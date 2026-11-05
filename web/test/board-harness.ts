import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';

const BOARD = join(import.meta.dirname, '..', 'pages', 'board');
// The web plugins' board scripts, served at /plugins/<name>/<file> from plugins/<name>/board/.
const PLUGINS = join(import.meta.dirname, '..', 'plugins');
const FIXTURE_PLUGINS = join(import.meta.dirname, 'fixtures', 'plugins');
export const ORIGIN = 'http://bwat.test';

export const MEETING = '11111111-1111-4111-8111-111111111111';
export const CARD = '22222222-2222-4222-8222-222222222222';
export const OLDER_MEETING = '77777777-7777-4777-8777-777777777777';
export const QUESTION = '88888888-8888-4888-8888-888888888888';
export const QUESTION_NOW = '99999999-9999-4999-8999-999999999999';
export const CARD_OWNED = '66666666-6666-4666-8666-666666666666';
export const ADA = '33333333-3333-4333-8333-333333333333';
export const BOB = '44444444-4444-4444-8444-444444444444';
export const TOKEN = 'id-token-for-ada';

// What the board said to a screen reader: politely (#announcement), and an error, at once (#alert,
// where a repeat of the same words carries a trailing no-break space).
export const said = (document: Document) => document.querySelector('#announcement')!.textContent;
export const alerted = (document: Document) => document.querySelector('#alert')!.textContent!.trim();
// The red line on a card of the desk, when what was done to it failed: its words come before its Try again.
export const errLine = (document: Document, id = CARD_OWNED) => document.querySelector(`#card-list [data-card="${id}"] .card-line.err`) as HTMLElement | null;
// The desk's timings (ui/delight.js), which a test shortens.
export const ms = (window: object) => (window as unknown as { DELIGHT: { ms: Record<string, number> } }).DELIGHT.ms;
// Open to-dos (GET /v1/cards?status=open): a card whose owner the room said is "Ada" but that
// no member owns, and Ada's card from a meeting weeks before any the feed lists.
export const SPOKEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const OLD_CARD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const KICKOFF = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
// bwat's claim in the live meeting (GET /v1/allocations).
export const BOT_CLAIM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
// The claim a send from the board's Settings opens (POST /v1/allocations).
export const SENT_CLAIM = '12121212-1212-4121-8121-121212121212';
// The i-th of the ended meetings in the weeks before this one (fakeServer's pastWeeks).
export const pastId = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;

/** The feed the page reads (board_feed.json), through its own window.fetch. */
export const feedOf = async <T = { weeks: { key: string; n: number | null }[] }>(window: { fetch: typeof fetch }) =>
  (await (await window.fetch('board_feed.json')).json()) as T;

// A card's source as the card service builds it (cards/api/app.py card_view): its first quote.
const sourceOf = (evidence: { epoch: number; seq: number; quote: string; speaker_member_id: string | null }[]) => evidence[0]
  ? { epoch: evidence[0].epoch, segment_seq_from: evidence[0].seq, segment_seq_to: evidence[0].seq, quote: evidence[0].quote, speaker_member_id: evidence[0].speaker_member_id }
  : null;

export interface Call {
  method: string;
  path: string;
  authorization: string | null;
  // X-Bwat-Surface: what the board inside a plugin's product marks every request with (absent elsewhere).
  surface?: string;
  body: unknown;
}

/** The backend, the card service and the sign-in server the page talks to, as one fake. */
// ownedGone: the card service stops listing T-2, as it may once T-2 is closed; cardGone, T-1, as a lagging list may after its reopen.
// countsDown: the card service cannot count each meeting's cards (GET /v1/cards/counts): it answers 500, or the connection drops.
// feedDown: the backend cannot list the meetings, so the board's refresh fails: true, its gateway answers 502
// (the backend is not reached); 500, the backend answers with an error of its own.
export const control = { askedArchived: false, ownedGone: false, cardGone: false, pairCode: 'ABCD-EFGH', newestLine: null as string | null, countsDown: false as false | 500 | 'dropped', feedDown: false as boolean | 500,
  // T-2's routed record as the card service lists it, once its session read the hand-off.
  ownedRouted: null as unknown[] | null };

export function fakeServer({
  adaName = 'Ada' as string | null, title = 'Standup' as string | null, bobName = 'Bob', startedAt = new Date().toISOString(),
  whoami = null as [number, unknown] | null, occurrence = null as string | null,
  state = 'live' as 'live' | 'ended' | 'abandoned', spokenOwner = null as string | null,
  olderCardsDown = false, merged = false, crossMeetingEvidence = false,
  // The error code the live meeting's bot reports (GET /v1/meetings bot_error) and the card
  // writer's (its activity's error; model_unavailable comes with the paused phase);
  // a test changes them to see the board follow.
  modelError = { bot: null as string | null, cards: null as string | null },
  // Jev's hint on T-1, naming a card per side, and what Merge now / Link now answers: the
  // card service's [status, body] (the card is filled in), held until `actGate` resolves.
  hint = null as Record<'duplicate' | 'related', { card_id: string; display_id: string; title: string } | null> | null,
  act = null as [number, Record<string, unknown>] | null, actGate = Promise.resolve(),
  // The card service's lifecycle fields on T-1 and T-2 (status, accepted, expires_in_days).
  lifecycle = {} as Record<string, unknown>, ownedLifecycle = {} as Record<string, unknown>,
  // What Save on T-2 answers, [status, body]; by default it saves, and T-2 stops expiring.
  keep = null as [number, Record<string, unknown>] | null,
  // Every /v1 call refused 401, as the backend does for a board token that lapsed.
  refuseApi = false,
  // The open list never ends (`next` on every page), as a board with more open cards than a refresh reads.
  endlessOpen = false,
  // Q-2 starts unanswered and is answered by its clarify, rather than answered from the start.
  askedOpen = false,
  // Q-2 has no typed answer, but another card (T-1) answers it.
  askedByCard = false,
  // Q-2 is a draft the card writer closed itself (QOR-5003): as answered in the room, with its
  // answer as the card service's answer paragraph, or as dropped, with none.
  askedClosedByBwat = null as 'answered' | 'dropped' | null,
  // Q-2's quotes, in place of T-1's: who said it first decides whose it is under People.
  askedEvidence = null as { epoch: number; seq: number; speaker: string; speaker_member_id: string | null; quote: string }[] | null,
  // Q-2's first clarify is refused as stale: someone else changed the question first.
  clarifyStaleOnce = false,
  // T-2's first close is refused as stale: someone else changed it first (a new revision).
  archiveStaleOnce = false,
  // T-1's first reopen (Undo) is refused: the card service answers 500.
  unarchiveFailsOnce = false,
  // T-1's reopen answers only once this resolves, as a slow card service does.
  unarchiveGate = Promise.resolve(),
  // T-1's first reopen is refused as stale: someone else changed it first (a new revision).
  unarchiveStaleOnce = false,
  // T-1 closed, as the card service lists it (its own fields, over T-1's), until a reopen opens it.
  closed = null as Record<string, unknown> | null,
  // Who that refusal names (the card service's `by`), or nobody.
  staleBy = null as string | null,
  // The first drag order saved is refused as stale: someone else reordered the meeting's to-dos first.
  orderStaleOnce = false,
  // The first drag order saved is refused outright: the card service answers 500.
  orderFailsOnce = false,
  // T-1's first owner change is refused: the card service answers 500.
  ownerFailsOnce = false,
  // T-1's first owner change is refused as stale: the card writer revised its text first ('text'),
  // someone else set its owner first ('owner': Ada), or someone closed it first ('closed').
  ownerStaleOnce = null as 'text' | 'owner' | 'closed' | null,
  // The first Undo merge is refused: the card service answers 500.
  unmergeFailsOnce = false,
  // The first recall of bwat from the live meeting is refused: the backend answers 500.
  recallFailsOnce = false,
  // Q-2's first clarify saves, but its reply is lost (the connection to the card service drops); it
  // answers the retry, same request id and same old revision, as already saved.
  clarifyLostOnce = false,
  // What the web server's transcript download answers: [status, body].
  transcript = [401, { error: 'signed_out' }] as [number, unknown],
  // What GET /board-plugins answers (the plugins on, and every claimed token), held until
  // `boardPluginsGate` resolves; `boardPluginsDown` answers it 503.
  boardPlugins = { plugins: [], reserved: [] } as { plugins: { name: string; token: string | null; scripts: string[] }[]; reserved: string[] },
  boardPluginsDown = false, boardPluginsGate = Promise.resolve(),
  // What GET /board-links answers: the switched-on plugins' links, by slot.
  boardLinks = { links: [] } as { links: { slot: string; label: string; href: string }[] },
  // The person's live sessions, most recently heard from first (each on ada-mac and just heard
  // from unless it says otherwise), and their default session.
  sessions = [{ id: 'sess-1', name: 'bwat repo' }] as { id: string; name: string; machine?: string; ageS?: number }[],
  defaultSession = null as { session_id: string; name: string; live: boolean } | null,
  // The backend's answer to a default change: 204, or an error status.
  defaultStatus = 204,
  // Whether the person's Zoom login is linked to their bwat account; a test changes { on } to see the board follow.
  zoomLinked = { on: true },
  // The read of the person's links fails (the backend unreachable); a test changes it to see the board follow.
  connectionsDown = { on: false },
  // The card writer's activity read drops (the network blips); a test changes it to see the board follow.
  activityDown = { on: false },
  // When bwat joined the live meeting (its claim attending), or null for no bot in it.
  botJoinedAt = null as string | null,
  // Whether the meetings list says a bot is in the live meeting now (GET /v1/meetings bot_present).
  botPresent = true,
  // False: the claim is attending but its join time is not known yet (no heartbeat since the upgrade).
  joinedAtKnown = true,
  // What POST /v1/allocations answers instead of opening a claim: [status, body].
  sendAnswer = null as [number, unknown] | null,
  // POST /v1/allocations answers only once this resolves, as a send waits on Zoom's schedule lookup.
  sendGate = Promise.resolve(),
  // More answers, by "METHOD /path": a plugin's own routes, as its tests need them.
  extra = {} as Record<string, (url: URL, body: unknown) => [number, unknown] | Promise<[number, unknown]>>,
  // How long the card service's counts are reused, as COUNTS_TTL_S makes them (0: counted on every read).
  countsTtl = 0,
  // Ended meetings in the weeks before this one, one a week, each with one card: what "All weeks" reads.
  pastWeeks = 0,
  // The meeting has not started yet: the feed lists only the older ones until start().
  late = false,
  // Someone dragged the meeting's to-dos (and Ada her own) into an order of their own.
  handOrdered = true,
  // Reads that never answer ("GET /v1/members"), as a hung backend: only the request's own abort ends them.
  hung = [] as string[],
  // The Zoom panel's meeting check fails (502) while on; a test changes it to see the panel follow.
  meetingBotDown = { on: false },
} = {}) {
  const calls: Call[] = [];
  // The query of every GET /v1/cards (Open to-dos), in order.
  const openReads: URLSearchParams[] = [];
  // Fixed for the server's life, as a real meeting's are: every poll sees the same meeting.
  // An hour ago, but never before today's local midnight: in the first hour of a Monday an
  // hour ago is last week, and the tests count this meeting in this week.
  const midnight = new Date().setHours(0, 0, 0, 0);
  const olderStart = new Date(Math.max(Date.now() - 3_600_000, midnight)).toISOString(), olderEnd = new Date().toISOString();
  const evidence = [{ epoch: 0, seq: 78, speaker: 'Ada Lovelace', speaker_member_id: ADA, quote: 'ship it on friday' }, { epoch: 0, seq: 80, speaker: 'Bob', speaker_member_id: BOB, quote: 'friday works' },
    ...(crossMeetingEvidence ? [{ meeting_id: OLDER_MEETING, epoch: 0, seq: 4, speaker: 'Bob', speaker_member_id: BOB, quote: 'Include the screenshots' }] : [])];
  const card = {
    id: CARD,
    meeting_id: MEETING,
    occurrence_id: 'zoom-occurrence==',
    display_id: 'T-1',
    kind: 'task',
    title: 'Ship the release on Friday',
    detail_html: '<p>Agreed in standup.<script>window.pwned = true</script><img src=x onerror="window.pwned = true"><svg><style>.pwned{}</style></svg></p>',
    owner_member_id: null,
    // A name the room gave that no member has (the card service's owner_name).
    owner_label: spokenOwner,
    owner_by: null as string | null,
    superseded_by: null,
    answered_by: [] as { id: string; display_id: string }[],
    archived: false,
    done: false,
    evidence,
    source: sourceOf(evidence),
    revision: 3,
    hint,
    ...lifecycle,
  };
  // A second card, already Ada's: only an owned card offers Send to Claude.
  // Said later in the meeting than the first card: after the bot rejoined (epoch 1, seq 0),
  // so it sorts above a card from epoch 0 even though its seq is lower.
  // Bob gave it to Ada (owner_by: who last set the owner).
  const ownedEvidence = [{ epoch: 1, seq: 0, speaker: 'Ada Lovelace', speaker_member_id: ADA, quote: 'I will write the notes' }];
  const owned = { ...card, hint: null, id: CARD_OWNED, display_id: 'T-2', title: 'Write the release notes', owner_member_id: ADA, owner_by: BOB, revision: 7,
    evidence: ownedEvidence, source: sourceOf(ownedEvidence), ...ownedLifecycle };
  // An earlier meeting on the second page of GET /v1/meetings, with an open question.
  const question = { ...card, hint: null, id: QUESTION, meeting_id: OLDER_MEETING, display_id: 'Q-1', kind: 'question', title: 'Who owns the rollout?', revision: 1 };
  // Answered: by T-1, and with Answer on the board (the card service's data-clarify note).
  const asked = { ...question, id: QUESTION_NOW, meeting_id: MEETING, display_id: 'Q-2', title: 'When is the code freeze?',
    detail_html: askedOpen || askedByCard ? '<p>When do we freeze?</p>' : '<p data-clarify="r"><b>Answered</b> by Bob: Friday noon</p>',
    answered_by: askedOpen && !askedByCard ? [] : [{ id: CARD, display_id: 'T-1' }], ...(askedEvidence ? { evidence: askedEvidence, source: sourceOf(askedEvidence) } : {}),
    ...(askedClosedByBwat ? { status: 'wont_do', withdrawn: true, answered_by: [], detail_html: askedClosedByBwat === 'answered'
      ? '<p>When do we freeze?</p><p data-clarify="bwat"><b>Answered in the room</b>, closed by bwat, 2026-10-26T22:05:28Z: Friday noon.</p>'
      : '<p>When do we freeze?</p><p><b>Closed by bwat</b>, 2026-10-26T22:05:28Z: Nobody needs the date any more.</p>' } : {}) };
  // The claim a send opened, listed by GET /v1/allocations; sent() moves it on.
  let sent: { id: string; meeting_number: string; occurrence_id: null; claim_state: string; refused_reason: string | null } | null = null;
  // What end(), pass() and arrive() change, below.
  let lastPass: Record<string, unknown> = {};
  const arrived: Record<string, unknown>[] = [];
  const archived = { ...card, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', display_id: 'T-3', title: 'Closed earlier', archived: true };
  // The card service's open list, newest first, each with its meeting: two pages, so the
  // board must follow `next`; owner=me keeps Ada's by member id only.
  const standup = { id: MEETING, title, starts_at: startedAt };
  const kickoff = { id: KICKOFF, title: 'Kickoff', starts_at: new Date(Date.now() - 40 * 86_400_000).toISOString() };
  const openList = () => [
    ...(control.cardGone ? [] : [{ ...card, ...closed, meeting: standup }]),
    { ...owned, meeting: standup },
    { ...card, hint: null, id: SPOKEN, display_id: 'T-9', title: 'Said to be Ada’s', owner_label: 'Ada', revision: 1, meeting: standup },
    { ...card, hint: null, id: OLD_CARD, meeting_id: KICKOFF, display_id: 'T-7', title: 'Finish the migration', owner_member_id: ADA,
      revision: 2, evidence: [{ epoch: 0, seq: 5, speaker: 'Ada Lovelace', speaker_member_id: ADA, quote: 'I will finish the migration' }], meeting: kickoff },
    // Open, but a question, not a to-do: the list holds every kind.
    { ...question, owner_member_id: ADA, meeting: { id: OLDER_MEETING, title: 'Planning', starts_at: olderStart } },
  ];
  // A dismissal or an act clears that side; the hint goes once neither is left.
  const clearHint = (kind: 'duplicate' | 'related') => {
    if (card.hint) card.hint = { ...card.hint, [kind]: null };
    if (card.hint && !card.hint.duplicate && !card.hint.related) card.hint = null;
    card.revision += 1;
  };
  const past = Array.from({ length: pastWeeks }, (_, i) => {
    const at = new Date(Date.now() - (i + 1) * 7 * 86_400_000).toISOString();
    return { id: pastId(i), occurrence_id: `past-${i}==`, title: 'Weekly', started_at: at, ended_at: at, occurrence_state: 'ended' };
  });
  const pastCards = past.map((m, i) => ({ ...card, hint: null, id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, meeting_id: m.id,
    display_id: `T-${100 + i}`, title: `Weekly item ${i}`, revision: 1 }));
  // Each meeting's list, as GET /v1/occurrences/{id}/cards answers it; the counts are its own.
  const meetingCards = () => [
    ...(control.cardGone ? [] : [{ ...card, ...closed, merged_from: merged ? [{ id: CARD_OWNED, display_id: 'A-2' }] : [] }]),
    ...(control.ownedGone ? [] : [{ ...owned, merged_into: merged ? { id: CARD, display_id: 'T-1' } : null, ...(control.ownedRouted && { routed: control.ownedRouted }) }]),
    { ...asked, archived: control.askedArchived }, archived, ...arrived];
  // The card service's last count and when it was made.
  let counted: { at: number; body: unknown } | null = null;
  const lists = (): Record<string, { archived?: unknown }[]> => ({
    [MEETING]: meetingCards(), [OLDER_MEETING]: [question], ...Object.fromEntries(past.map((m, i) => [m.id, [pastCards[i]!]])),
  });
  const answers: Record<string, (url: URL, body: unknown) => [number, unknown] | Promise<[number, unknown]>> = {
    'GET /board-plugins': async () => {
      await boardPluginsGate;
      return boardPluginsDown ? [503, { error: 'plugins_unavailable' }] : [200, boardPlugins];
    },
    'GET /board-links': () => [200, boardLinks],
    // Each meeting's list from lists(), as the counts are; the older meeting's on its own, as it can fail.
    ...Object.fromEntries(Object.keys(lists()).filter((id) => id !== OLDER_MEETING)
      .map((id) => [`GET /v1/occurrences/${id}/cards`, () => [200, lists()[id]] as [number, unknown]])),
    // The card service's count of each meeting's cards less the archived ones, a meeting with none unlisted.
    'GET /v1/cards/counts': () => {
      if (control.countsDown === 'dropped') throw new TypeError('Failed to fetch');
      if (control.countsDown) return [500, { error: 'internal' }];
      if (counted && Date.now() - counted.at < countsTtl) return [200, counted.body];
      counted = { at: Date.now(), body: { meetings: Object.entries(lists())
      .map(([id, list]) => ({ meeting_id: id, cards: list.filter((c) => !c.archived).length,
        // Opaque to the board: moves with any change to any of the meeting's cards, archived ones too.
        cards_version: list.map((c) => `${(c as { id: string }).id}:${(c as { revision?: number }).revision}:${!!c.archived}`).join(',') }))
      .filter((m) => m.cards > 0) } };
      return [200, counted.body];
    },
    'GET /whoami': () => whoami ?? [200, { member: { id: ADA, email: 'ada@example.com', display_name: adaName, role: 'owner' }, id_token: TOKEN, occurrence_id: occurrence }],
    'GET /v1/meetings': (url) => control.feedDown ? [control.feedDown === 500 ? 500 : 502, { error: control.feedDown === 500 ? 'internal' : 'backend_unavailable' }] : [200, url.searchParams.get('cursor') === 'page-2'
      ? { meetings: [{
        id: OLDER_MEETING, occurrence_id: 'old/er+==', title: 'Planning', started_at: olderStart, ended_at: olderEnd, occurrence_state: 'ended',
        duration_seconds: 1_790, attendee_count: 4, host_email: 'ada@example.com',
      }, ...past], next_cursor: null }
      : { meetings: late ? [] : [{ id: MEETING, occurrence_id: 'zoom-occurrence==', title, started_at: startedAt, ended_at: null, occurrence_state: state, duration_seconds: null, attendee_count: null, host_email: null, bot_error: modelError.bot, bot_present: botPresent && state === 'live' }], next_cursor: 'page-2' }],
    // The newest lines only (?tail=), oldest of them first.
    [`GET /v1/meetings/${MEETING}/transcript`]: (url) => (url.searchParams.get('tail') === '30' ? [200, { segments: [
      { epoch: 0, seq: 79, speaker: { label: 'Ada Lovelace', member_id: ADA }, text: 'ship it on friday', start_ms: 1000, end_ms: 2000, source: 'audio' },
      { epoch: 0, seq: 80, speaker: { label: 'Bob', member_id: BOB }, text: 'friday works', start_ms: 2000, end_ms: 3000, source: 'audio' },
      ...(control.newestLine ? [{ epoch: 0, seq: 81, speaker: { label: 'Bob', member_id: BOB }, text: control.newestLine, start_ms: 3000, end_ms: 4000, source: 'audio' }] : []),
    ], next_cursor: null }] : [400, { error: 'invalid_query' }]),
    'GET /v1/members': () => [200, { members: [
      { id: ADA, email: 'ada@example.com', display_name: adaName, role: 'owner' },
      { id: BOB, email: 'bob@example.com', display_name: bobName, role: 'member' },
    ] }],
    [`POST /v1/cards/${CARD_OWNED}/unmerge`]: () => unmergeFailsOnce
      ? (unmergeFailsOnce = false, [500, { error: 'internal' }])
      : (merged = false, [200, { ...card, revision: 4 }]),
    [`GET /v1/occurrences/${OLDER_MEETING}/cards`]: () => (olderCardsDown ? [500, { error: 'internal' }] : [200, [question]]),
    'GET /v1/cards': (url) => {
      const q = url.searchParams;
      openReads.push(new URLSearchParams(q));
      if (q.get('status') !== 'open' || (q.has('owner') && q.get('owner') !== 'me')) return [400, { error: 'bad_request' }];
      const all = openList().filter((c) => !q.has('owner') || c.owner_member_id === ADA);
      if (endlessOpen) {
        const n = Number(q.get('cursor')?.replace('open-', '') || 1);
        return [200, { cards: n === 1 ? all : [], next: `open-${n + 1}`, ...(q.has('cursor') ? {} : { total: 1000 }) }];
      }
      const page = q.get('cursor') === 'open-2' ? all.slice(2) : all.slice(0, 2);
      // `total` on the first page only, as the card service answers.
      return [200, { cards: page, next: q.get('cursor') === 'open-2' || all.length <= 2 ? null : 'open-2', ...(q.has('cursor') ? {} : { total: all.length }) }];
    },
    'GET /v1/sessions': () => [200, sessions.map((x) => ({
      session_id: x.id, client: { kind: 'claude-code', wake: 'push', machine: x.machine ?? 'ada-mac', platform: 'darwin', plugin_version: '1.0.0', name: x.name, cwd: 'bwat' },
      last_seen_at: new Date(Date.now() - (x.ageS ?? 0) * 1000).toISOString(),
    }))],
    // The person's links: a live Claude session while they have one, and their Zoom login.
    'GET /v1/me/connections': () => (connectionsDown.on ? [502, { error: 'backend_unavailable' }]
      : [200, { claude_session: sessions.length > 0, zoom: zoomLinked.on }]),
    'GET /v1/me/default-session': () => [200, defaultSession
      ? { session_id: defaultSession.session_id, live: defaultSession.live, client: { kind: 'claude-code', name: defaultSession.name, machine: 'ada-mac' } }
      : {}],
    ...Object.fromEntries([...sessions.map((x) => x.id), defaultSession?.session_id].filter(Boolean).flatMap((id) => [
      [`PUT /v1/sessions/${id}/default`, () => [defaultStatus, defaultStatus === 204 ? null : { error: 'internal' }]],
      [`DELETE /v1/sessions/${id}/default`, () => [defaultStatus, defaultStatus === 204 ? null : { error: 'internal' }]],
    ])),
    [`PUT /v1/cards/${CARD}/owner`]: () => {
      if (ownerStaleOnce) {
        Object.assign(card, ownerStaleOnce === 'owner' ? { owner_member_id: ADA } : ownerStaleOnce === 'closed' ? { done: true } : { title: 'Ship the release on Friday, with notes' }, { revision: card.revision + 1 });
        ownerStaleOnce = null;
        return [409, { error: 'stale_revision' }];
      }
      return ownerFailsOnce
        ? (ownerFailsOnce = false, [500, { error: 'internal' }])
        : [200, { ...card, owner_member_id: BOB, revision: card.revision + 1 }];
    },
    [`POST /v1/cards/${CARD}/archive`]: () => [200, { ...card, archived: true, revision: 4 }],
    [`POST /v1/cards/${CARD_OWNED}/archive`]: () => archiveStaleOnce
      ? (archiveStaleOnce = false, owned.revision += 1, [409, { error: 'stale_revision', ...(staleBy && { by: staleBy }) }])
      : [200, { ...owned, archived: true, revision: owned.revision + 1 }],
    [`POST /v1/cards/${CARD}/unarchive`]: async () => (await unarchiveGate, unarchiveStaleOnce
      ? (unarchiveStaleOnce = false, card.revision += 1, [409, { error: 'stale_revision', ...(staleBy && { by: staleBy }) }])
      : unarchiveFailsOnce
        ? (unarchiveFailsOnce = false, [500, { error: 'internal' }])
        // Open again, as the card service's reopen leaves it.
        : (closed = null, [200, { ...card, status: 'open', revision: 5 }])),
    [`POST /v1/cards/${CARD_OWNED}/keep`]: () => keep ?? [200, Object.assign(owned, { expires_in_days: null, revision: owned.revision + 1 })],
    [`PATCH /v1/cards/${CARD}`]: () => [200, Object.assign(card, { title: 'Ship it Monday', revision: card.revision + 1 })],
    [`POST /v1/cards/${QUESTION_NOW}/clarify`]: () => {
      if (clarifyStaleOnce) {
        clarifyStaleOnce = false;
        Object.assign(asked, { title: 'When is the code freeze, exactly?', revision: asked.revision + 1 });
        return [409, { error: 'stale_revision' }];
      }
      if (asked.archived) return [200, { ...asked, repeated: true }];
      if (clarifyLostOnce) {
        clarifyLostOnce = false;
        Object.assign(asked, { archived: true, status: 'done', revision: asked.revision + 1 });
        throw new TypeError('Failed to fetch');
      }
      Object.assign(asked, { detail_html: '<p data-clarify="r"><b>Answered</b> by Ada: Friday noon</p>', revision: asked.revision + 1 });
      return [200, { ...asked, detail_html: '<p data-clarify="r">Answered</p>', revision: 2 }];
    },
    [`POST /v1/cards/${CARD}/hint/dismiss`]: (_url, body) => { clearHint((body as { kind: 'duplicate' | 'related' }).kind); return [200, { ...card }]; },
    [`POST /v1/cards/${CARD}/hint/act`]: async (_url, body) => {
      await actGate;
      const [status, answer] = act ?? [200, { outcome: 'merged', message: 'Merged' }];
      if (status === 200) clearHint((body as { kind: 'duplicate' | 'related' }).kind);
      return [status, status === 200 ? { ...answer, card: { ...card } } : answer];
    },
    'GET /v1/editing': () => [200, { editing: {} }],
    'POST /v1/editing': () => [204, null],
    'GET /v1/orders': () => [200, handOrdered ? { meetings: { [MEETING]: { order: [CARD_OWNED, CARD], version: 2 } }, mine: { order: [CARD_OWNED], version: 1 } } : { meetings: {}, mine: null }],
    'PUT /v1/orders': () => orderStaleOnce
      ? (orderStaleOnce = false, [409, { error: 'stale_order', order: [CARD_OWNED, CARD], version: 4 }])
      : orderFailsOnce ? (orderFailsOnce = false, [500, { error: 'internal' }])
        : [200, { order: [CARD, CARD_OWNED], version: 3 }],
    [`GET /v1/occurrences/${MEETING}/activity`]: () => { if (activityDown.on) throw new TypeError('Failed to fetch'); return [200, { phase: modelError.cards === 'model_unavailable' ? 'paused' : modelError.cards ? 'failed' : 'complete', expires_at: Date.now() / 1000 + 60, ...(modelError.cards && { error: modelError.cards }), ...lastPass }]; },
    // The card service appends "Queued" to the card's detail, a new revision.
    'POST /v1/handoffs': () => { owned.revision += 1; return [202, { handoff_id: '55555555-5555-4555-8555-555555555555', status: 'queued' }]; },
    'POST /v1/members': () => [201, { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'cy@example.com', display_name: null, role: 'member' }],
    // The meeting bots (an admin's): bwat's claim in the live meeting while it is in. A recall
    // ends the claim, so the meeting is no longer live.
    'GET /v1/allocations': () => [200, { allocations: [
      ...(sent ? [{ ...sent, error: null, created_at: new Date().toISOString(), joined_at: null, ended_at: null }] : []),
      ...(botJoinedAt && state === 'live' ? [
        { id: BOT_CLAIM, meeting_number: '230000001', occurrence_id: 'zoom-occurrence==', claim_state: 'attending', refused_reason: null, error: null, created_at: botJoinedAt, joined_at: joinedAtKnown ? botJoinedAt : null, ended_at: null },
      ] : []),
    ] }],
    // Any signed-in person sends bwat to a meeting by its Zoom link: 202 with the new claim.
    'POST /v1/allocations': async (_url, body) => {
      await sendGate;
      if (sendAnswer) return sendAnswer;
      const number = /^https:\/\/[\w.]*zoom\.us\/j\/(\d+)/.exec((body as { zoom_url: string }).zoom_url)?.[1];
      if (!number) return [422, { error: 'not_a_zoom_meeting_link' }];
      sent = { id: SENT_CLAIM, meeting_number: number, occurrence_id: null, claim_state: 'pending', refused_reason: null };
      return [202, sent];
    },
    [`PATCH /v1/allocations/${BOT_CLAIM}`]: () => {
      if (recallFailsOnce) { recallFailsOnce = false; return [500, { error: 'internal' }]; }
      state = 'abandoned';
      return [200, { id: BOT_CLAIM, claim_state: 'refused', refused_reason: 'recalled' }];
    },
    // Inside Zoom: bwat's status in the meeting the panel is in; a host may ask it to leave.
    'POST /v1/zoom/meeting-bot': (_url, body) => meetingBotDown.on ? [502, { error: 'backend_unavailable' }] : [200, (body as { leave?: boolean }).leave
      ? { state: 'leaving', can_invite: false, can_leave: false, occurrence_id: 'zoom-occurrence==' }
      : { state: botJoinedAt && state === 'live' ? 'present' : 'absent', can_invite: false, can_leave: true, joined_at: joinedAtKnown ? botJoinedAt : null, occurrence_id: 'zoom-occurrence==' }],
    // The transcript download, as the web server answers a sign-in that ended.
    'GET /transcript': () => transcript,
    // The pairing code the browser showed, typed into the board inside Zoom.
    'POST /auth/zoom-pair': () => (control.pairCode === 'ABCD-EFGH' ? [204, null] : [400, { error: 'wrong_code' }]),
  };
  async function fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input), ORIGIN);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({
      method,
      path: url.pathname,
      authorization: headers.get('authorization'),
      ...(headers.has('x-bwat-surface') && { surface: headers.get('x-bwat-surface')! }),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (refuseApi && url.pathname.startsWith('/v1/')) return new Response('{"error":"unauthorized"}', { status: 401 });
    // As a browser's fetch: a request whose signal has already aborted is never sent.
    if (init.signal?.aborted) throw init.signal.reason;
    if (hung.includes(`${method} ${url.pathname}`)) {
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    const answer = answers[`${method} ${url.pathname}`] ?? extra[`${method} ${url.pathname}`];
    if (!answer) return new Response('{"error":"not_found"}', { status: 404 });
    const [status, body] = await answer(url, calls.at(-1)!.body);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  return {
    calls, fetch, openReads,
    // The meeting ends: its occurrence is no longer live.
    end() { state = 'ended'; },
    // A late meeting starts: the feed lists it, live.
    start() { late = false; },
    // The owned card changes behind the board (a plugin's note on it, say): a new revision.
    touchOwned() { owned.revision += 1; },
    // The claim a send opened moves on: claimed (joining), attending, refused...
    sent(claimState: string) { sent!.claim_state = claimState; },
    // bwat is invited back into the live meeting after a recall.
    reinvite() { state = 'live'; },
    // The card writer finishes a pass (its event id) with what it saved.
    pass(id: string, result: Record<string, unknown>) { lastPass = { event_id: id, last_complete: id, result }; },
    // A card the card writer wrote after the page loaded, in the live meeting.
    // It closes and reopens as any card does, and reopened it is listed last: a feed that moves
    // it, so the board has to put it back where it was itself.
    arrive(c: { id: string; display_id: string; kind: string; title: string }) {
      const a = { ...card, hint: null, revision: 1, ...c, archived: false };
      arrived.push(a);
      answers[`POST /v1/cards/${c.id}/archive`] = () => { Object.assign(a, { archived: true, revision: a.revision + 1 }); return [200, { ...a }]; };
      answers[`POST /v1/cards/${c.id}/unarchive`] = () => {
        Object.assign(a, { archived: false, revision: a.revision + 1 });
        arrived.splice(arrived.indexOf(a), 1);
        arrived.push(a);
        return [200, { ...a }];
      };
    },
    // Someone else edits T-1: a new revision, which its meeting's counts carry too.
    edit(fields: { title: string }) { Object.assign(card, fields, { revision: card.revision + 1 }); },
  };
}

/** Serves the page's own files from web/pages/board, and plugins' board scripts; nothing else is fetched. */
export class Pages extends ResourceLoader {
  // What the page asked for off this site, in order.
  readonly offsite: string[] = [];

  override fetch(url: string) {
    const { origin, pathname } = new URL(url);
    if (origin !== ORIGIN) this.offsite.push(url);
    // Off this site (the Zoom Apps SDK): unreachable, as outside Zoom, so the page's onerror runs at once.
    if (origin !== ORIGIN) return Promise.reject(new Error(`offline ${origin}`)) as ReturnType<ResourceLoader['fetch']>;
    const plugin = /^\/plugins\/([a-z0-9-]+)\/([a-z0-9._-]+\.js)$/.exec(pathname);
    if (plugin) {
      // A shipped plugin's, else a test's (test/fixtures/plugins/); neither: as the server's 404.
      for (const root of [PLUGINS, FIXTURE_PLUGINS]) {
        const path = join(root, plugin[1]!, 'board', plugin[2]!);
        if (existsSync(path)) return Promise.resolve(readFileSync(path)) as ReturnType<ResourceLoader['fetch']>;
      }
      return Promise.reject(new Error(`404 ${pathname}`)) as ReturnType<ResourceLoader['fetch']>;
    }
    const file = readFileSync(join(BOARD, decodeURIComponent(pathname)));
    return Promise.resolve(file) as ReturnType<ResourceLoader['fetch']>;
  }
}

/**
 * Loads a board page as a browser would, with the fake behind window.fetch. `navigations`
 * lists every navigation the page tried (jsdom has none: location.assign only reports one).
 */
export async function loadPage(page: string, server = fakeServer(), query = '', {
  framed = false, storage = {} as Record<string, string>,
  // Inside a frame: the parent window the page sees (window.parent), the referrer its parent's
  // policy left it, and what the browser says its ancestors are (location.ancestorOrigins; jsdom has none).
  parent = null as object | null, referrer = undefined as string | undefined, ancestorOrigins = undefined as string[] | undefined,
  // What the page finds on window before its scripts run (Zoom's SDK, say).
  globals = {} as Record<string, unknown>,
} = {}) {
  const html = readFileSync(join(BOARD, page), 'utf8');
  const navigations: string[] = [];
  const virtualConsole = new VirtualConsole().sendTo(console, { omitJSDOMErrors: true });
  virtualConsole.on('jsdomError', (e: Error) => {
    if (/navigation/.test(e.message)) navigations.push(e.message);
    // Nothing off this site loads here (Pages: the Zoom Apps SDK, the old board's fonts); the page goes on without it.
    else if (!/^Could not load \w+: "https:\/\/(?!bwat\.test\/)/.test(e.message)) console.error(e.stack);
  });
  const resources = new Pages();
  const dom = new JSDOM(html, {
    url: `${ORIGIN}/${page}${query}`,
    ...(referrer !== undefined && { referrer }),
    runScripts: 'dangerously',
    resources,
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>;
      // Inside a frame (the product's): jsdom's window.top is fixed, so self stands apart from it.
      if (framed) Object.defineProperty(window, 'self', { configurable: true, get: () => ({}) });
      if (parent) Object.defineProperty(window, 'parent', { configurable: true, get: () => parent });
      if (ancestorOrigins) Object.defineProperty(window.location, 'ancestorOrigins', { configurable: true, value: Object.freeze([...ancestorOrigins]) });
      Object.assign(w, globals);
      // What this browser kept from an earlier visit.
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      // A request still in flight when the test closes the window never answers, so the
      // page's polls do not resume against a torn-down window.
      let closed = false;
      const close = window.close.bind(window);
      window.close = () => { closed = true; close(); };
      const hold = <T>(p: Promise<T>) => p.then((v) => (closed ? new Promise<T>(() => {}) : v));
      w.fetch = (input: string | URL, init?: RequestInit) => hold(server.fetch(input, init).then((r) => {
        const json = r.json.bind(r), text = r.text.bind(r);
        r.json = () => hold(json());
        r.text = () => hold(text());
        return r;
      }));
      w.Response = Response;
      w.Headers = Headers;
      // jsdom has no TextEncoder; the page hashes names with it.
      w.TextEncoder = TextEncoder;
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      w.scrollTo = () => {};
      // jsdom has <dialog> but not its methods.
      const dialog = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
      dialog.showModal ??= function (this: HTMLElement) { this.setAttribute('open', ''); };
      dialog.close ??= function (this: HTMLElement) { this.removeAttribute('open'); };
    },
  });
  await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve()));
  return { dom, window: dom.window, document: dom.window.document, server, navigations, offsite: resources.offsite };
}

/** Waits until `check` holds, polling the page's own timers. */
export async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the page');
    await new Promise((r) => setTimeout(r, 25));
  }
}
