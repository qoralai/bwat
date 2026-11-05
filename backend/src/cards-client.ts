/**
 * The backend's client for the card service's backend-only operations (D162, QOR-4620),
 * reached at BWAT_CARDS_URL on the internal network, never through the load balancer
 * (D169). Every call carries BWAT_CARDS_BACKEND_TOKEN as its bearer; the token is never
 * logged.
 */
export interface CardsClient {
  /** The card's self-contained brief, asked for as the acting member. */
  brief(cardId: string, memberId: string): Promise<{ subject: string; body: string }>;
  /** Tells the card it was handed off, as the acting member; the card then shows "queued". Idempotent on handoff_id. */
  routed(cardId: string, routed: { handoff_id: string; by_member_id: string; at: string }): Promise<void>;
  /** Tells the card its hand-off was marked read, as the reading member; the card then shows "Read". Idempotent on handoff_id. */
  handoffRead(cardId: string, read: { handoff_id: string; by_member_id: string; at: string }): Promise<void>;
  /**
   * What the bot posts in the meeting chat, asked for no person: what is still open from
   * the meeting's previous occurrence and its summary (`agenda`), or the occurrence's open
   * questions nobody owns (`questions`).
   */
  meetingChat(query: { list: 'agenda' | 'questions'; meeting_number: string; occurrence_uuid: string | null }): Promise<MeetingChat>;
  /** How many cards the install has written: the onboarding page's last check (QOR-4334). */
  cardCount?(): Promise<number>;
  /** The card writer's pause: the model it found gone and the error, or null while it writes. */
  writerStatus?(): Promise<{ paused: { model: string; error: string } | null }>;
  /** What a plugin works out from cards without their content: the cards named, and every card said in the named meeting series, as the acting member. */
  facts(query: { card_ids?: string[]; meeting_numbers?: string[] }, memberId: string): Promise<CardFact[]>;
  /** What a plugin reads of a card to file it in its product (QOR-4985), asked for as the acting member. */
  content(cardId: string, memberId: string): Promise<CardContent>;
  /**
   * Adds the acting member's receipt line to the card's detail ("<b>lead</b> text by <member>
   * at <time>"), once a plugin has acted on it in its product: a person's act on the card.
   * `lead` is at most 60 characters and `text` 300, each one line. With a `request_id` (the
   * plugin's own, at most 100 of `A-Za-z0-9._:-`), a retry adds no second line. Answers the
   * card's revision.
   */
  note(cardId: string, note: { lead: string; text: string; by_member_id: string; request_id?: string }): Promise<{ revision: number }>;
}

/** A card as a plugin files it elsewhere: its title, its note as plain text and its quotes. */
export interface CardContent {
  title: string;
  note: string;
  quotes: { speaker: string; quote: string }[];
}

/** A card without its content (POST /v1/cards/facts): `open` is on the board as current work; `closed_at` its newest close, or null. */
export interface CardFact {
  id: string;
  meeting_id: string;
  meeting_number: string;
  kind: 'decision' | 'task' | 'question' | 'risk';
  open: boolean;
  created_at: string;
  closed_at: string | null;
  /** The cards merged into it (QOR-4985): a plugin's record of one of them is now this card's. */
  merged_from: string[];
}

/** A card as the bot names it in the meeting chat; an agenda card also says its kind (QOR-4966). */
export interface ChatCard {
  display_id: string;
  title: string;
  kind?: 'todo' | 'question' | 'risk' | 'decision';
}

/** A meeting chat list; the agenda's `summary` is null when nothing carried over or the model could not say (QOR-4966). */
export interface MeetingChat {
  cards: ChatCard[];
  summary?: string | null;
}

/** The card service did not answer as the contract says. */
export class CardsUnavailable extends Error {}

const TIMEOUT_MS = 5_000;
// The agenda's summary is the card writer's model's, with a deadline of its own in the card
// service (SUMMARY_DEADLINE_S, cards/api/app.py); this wait is past it, so the agenda still
// arrives without one and the bot posts its count (QOR-4966).
const AGENDA_TIMEOUT_MS = 20_000;

export function cardsClient(baseUrl: string, token: string, fetchFn: typeof fetch = fetch): CardsClient {
  const call = async (method: 'GET' | 'POST', path: string, headers: Record<string, string>, body?: object, timeoutMs = TIMEOUT_MS) => {
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers, ...(body && { 'content-type': 'application/json' }) },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => {
      throw new CardsUnavailable(`${method} ${path.split(/[/?]/)[1]} unreachable`);
    });
    if (!res.ok) throw new CardsUnavailable(`${method} ${path.split(/[/?]/)[1]} answered ${res.status}`);
    return res;
  };
  return {
    async brief(cardId, memberId) {
      const res = await call('GET', `/cards/${cardId}/brief`, { 'x-bwat-member-id': memberId });
      const brief = (await res.json().catch(() => {
        throw new CardsUnavailable('brief is not JSON');
      })) as { subject?: unknown; body?: unknown } | null;
      if (typeof brief?.subject !== 'string' || typeof brief.body !== 'string' || !brief.subject || !brief.body) {
        throw new CardsUnavailable('brief has no subject or body');
      }
      return { subject: brief.subject, body: brief.body };
    },
    async routed(cardId, routed) {
      await call('POST', `/cards/${cardId}/routed`, { 'x-bwat-member-id': routed.by_member_id }, routed);
    },
    async handoffRead(cardId, read) {
      await call('POST', `/cards/${cardId}/handoff-read`, { 'x-bwat-member-id': read.by_member_id }, read);
    },
    async meetingChat({ list, meeting_number, occurrence_uuid }) {
      const query = new URLSearchParams({ list, meeting_number, ...(occurrence_uuid !== null && { occurrence_uuid }) });
      const res = await call('GET', `/meeting-chat?${query}`, {}, undefined, list === 'agenda' ? AGENDA_TIMEOUT_MS : TIMEOUT_MS);
      return (await res.json()) as MeetingChat;
    },
    async cardCount() {
      const res = await call('GET', '/card-count', {});
      return ((await res.json()) as { count: number }).count;
    },
    async writerStatus() {
      const res = await call('GET', '/writer/status', {});
      return (await res.json()) as { paused: { model: string; error: string } | null };
    },
    async facts(query, memberId) {
      const res = await call('POST', '/cards/facts', { 'x-bwat-member-id': memberId }, query);
      return ((await res.json()) as { cards: CardFact[] }).cards;
    },
    async content(cardId, memberId) {
      const res = await call('GET', `/cards/${cardId}/content`, { 'x-bwat-member-id': memberId });
      const content = (await res.json().catch(() => null)) as Partial<CardContent> | null;
      if (typeof content?.title !== 'string' || typeof content.note !== 'string' || !Array.isArray(content.quotes)) {
        throw new CardsUnavailable('content has no title, note or quotes');
      }
      return { title: content.title, note: content.note, quotes: content.quotes };
    },
    async note(cardId, note) {
      const res = await call('POST', `/cards/${cardId}/note`, { 'x-bwat-member-id': note.by_member_id }, note);
      return (await res.json()) as { revision: number };
    },
  };
}

/**
 * BWAT_CARDS_URL and BWAT_CARDS_BACKEND_TOKEN (tier 1): the client, or none while the
 * install has no card service to call. With a URL the token is required, 32 characters
 * or more.
 */
export function cardsClientFromEnv(env: NodeJS.ProcessEnv): CardsClient | undefined {
  const url = env.BWAT_CARDS_URL;
  if (!url) return undefined;
  const token = env.BWAT_CARDS_BACKEND_TOKEN;
  if (!token) throw new Error('BWAT_CARDS_BACKEND_TOKEN is required when BWAT_CARDS_URL is set');
  if (token.length < 32) throw new Error('BWAT_CARDS_BACKEND_TOKEN must be at least 32 characters');
  return cardsClient(url, token);
}
