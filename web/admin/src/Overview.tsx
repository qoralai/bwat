import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getJson, ONCE } from './api';
import { FinishSetup } from './FinishSetup';
import { LoadError } from './LoadError';
import { fetchAllocations, POLL_MS, Recall, SendForm, sendError, useRecall, zoomNumber, type Allocation, type RecallMutation } from './Meetings';
import { Readiness } from './Readiness';
import { reasonOf, type Reason } from './reasons';
import { fetchSettings, joinSentence, type SettingsRead } from './settingsRead';
import { relativeTime } from './relativeTime';

/* The admin's first page: one sentence saying whether bwat is working, then what it is
   doing now and what it did lately. "Needs you" only when something needs a person. */

/** One bot, as GET /v1/fleet returns it: what it last reported, and the claim it holds. */
type Bot = {
  bot_id: string;
  version: string | null;
  ready: boolean;
  stale: boolean;
  last_report_at: string | null;
  hearing: boolean | null | undefined;
  error: string | null;
  claim_id: string | null;
  meeting_number: string | null;
  /** Set only while the bot holds a live claim: then it may be recalled, however it is. */
  claim_state: string | null;
  occurrence_id: string | null;
  /** What the bot last said it was doing: joining, in_meeting, waiting_room, idle… */
  state: string | null;
  /** The held meeting's title and start, once Zoom has named it. */
  meeting_title: string | null;
  meeting_started_at: string | null;
};

/** A past or live meeting a bot was in, as GET /v1/meetings pages them. Every field but id may be null. */
type Meeting = {
  id: string;
  occurrence_id: string;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  host_email?: string | null;
  bot_ids: string[];
};
type MeetingsPage = { meetings: Meeting[]; next_cursor: string | null };

const fetchFleet = () => getJson<{ fleet: Bot[] }>('/v1/fleet');
/** Only meetings a bot was in, filtered by the backend so every page is full. */
const fetchMeetings = (cursor: string | null) =>
  getJson<MeetingsPage>(`/v1/meetings?with_bot=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);

/** Whether `a` comes after `b` in the backend's order (started_at, then id, newest first). */
const after = (a: Meeting, b: Meeting) => (a.started_at ?? '') < (b.started_at ?? '') || (a.started_at === b.started_at && a.id < b.id);

// What bwat is doing now: every 10 s while the tab is visible; React Query skips the interval while it is hidden.
const LIVE = { refetchInterval: POLL_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: true } as const;

type BotState = 'starting' | 'idle' | 'claimed' | 'attending' | 'leaving' | 'stale' | 'error';
/** A bot that says it is in or at a meeting it no longer holds (recalled) is on its way out. */
const IN_A_MEETING: ReadonlySet<string> = new Set(['joining', 'in_meeting', 'waiting_room', 'waiting_for_host']);
const OUT_OF_CREDIT = 'model_out_of_credit';

function stateOf(bot: Bot): BotState {
  if (bot.stale) return 'stale';
  // A bot that holds a meeting is in it whatever it reports: its error is said beside the line.
  if (bot.claim_state === 'attending') return 'attending';
  if (bot.claim_state === 'pending' || bot.claim_state === 'claimed') return 'claimed';
  if (bot.error && bot.error !== OUT_OF_CREDIT) return 'error';
  if (bot.state && IN_A_MEETING.has(bot.state)) return 'leaving';
  // Not yet ready (or withdrawn): the allocator sends it nowhere.
  return bot.ready ? 'idle' : 'starting';
}

const PILL: Record<BotState, string> = {
  starting: 'Starting',
  idle: 'Ready',
  claimed: 'Joining',
  attending: 'In a meeting',
  leaving: 'Leaving',
  stale: 'Not responding',
  error: 'Not ready',
};

/** What a bot in a meeting hears, when it has said. */
const audioOf = (bot: Bot) => (bot.hearing == null ? null : bot.hearing ? 'hearing audio' : 'no audio');
const titleOf = (bot: Bot) => bot.meeting_title ?? 'Untitled meeting';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function meetingDate(iso: string | null): string | null {
  if (iso == null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A reason as the page says it: what happened, then the fix, quieter. */
function Why({ reason, lead }: { reason: Reason; lead?: string }) {
  return (
    <>
      {lead && <b>{lead} </b>}
      {reason.say}
      {reason.fix && <span className="fix"> {reason.fix}</span>}
    </>
  );
}

/** The sentence, and what it means: what happened and the fix for a need, the details otherwise. */
type Headline = { text: string; why: Reason; needs: boolean };

/** The one sentence, from the bots, automatic joining and the meetings they are in. */
function headline(bots: Bot[], read: SettingsRead | undefined): Headline {
  const erring = bots.find((b) => !b.stale && b.error);
  if (erring) {
    const why = reasonOf(erring.error!, read);
    return { text: `Needs you: ${why.need ?? why.say.replace(/\.$/, '')}`, why, needs: true };
  }
  if (bots.length === 0) {
    return {
      text: 'Needs you: no bwat bot is running',
      why: { say: "Until one checks in, bwat can't join a meeting.", fix: "Start the meeting bot on this install's computer." },
      needs: true,
    };
  }
  if (bots.every((b) => b.stale)) {
    return { text: 'Needs you: no bot is answering', why: { say: 'The bots stopped checking in.', fix: 'Restart the meeting bot.' }, needs: true };
  }
  if (read?.autoJoin?.requested && !read.autoJoin.effective) {
    return { text: 'Needs you: automatic joining is waiting for setup', why: { say: 'The checks under Automatic joining say what is missing.' }, needs: true };
  }
  const meetings = bots.filter((b) => stateOf(b) === 'attending');
  if (meetings.length > 0) {
    const say = meetings
      .map((b) => {
        const since = b.meeting_started_at;
        const audio = audioOf(b);
        return `${titleOf(b)}, meeting ${zoomNumber(b.meeting_number)}${since ? `, since ${time(since)}` : ''}.${audio ? ` ${audio.charAt(0).toUpperCase()}${audio.slice(1)}.` : ''}`;
      })
      .join(' ');
    return { text: `bwat is in ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`, why: { say }, needs: false };
  }
  const joining = bots.filter((b) => stateOf(b) === 'claimed');
  if (joining.length > 0) {
    const say = joining.map((b) => (b.meeting_title ? `${b.meeting_title}, meeting ${zoomNumber(b.meeting_number)}.` : `Meeting ${zoomNumber(b.meeting_number)}.`)).join(' ');
    return { text: joining.length === 1 ? 'bwat is joining a meeting' : `bwat is joining ${joining.length} meetings`, why: { say }, needs: false };
  }
  const free = bots.filter((b) => stateOf(b) === 'idle').length;
  if (free > 0) return { text: 'bwat is ready', why: { say: `${joinSentence(read)} ${free === 1 ? '1 bot is' : `${free} bots are`} free.` }, needs: false };
  if (bots.some((b) => stateOf(b) === 'starting')) return { text: 'bwat is starting', why: { say: 'Its bots are starting up.' }, needs: false };
  // What is left: a bot leaving a meeting it was recalled from (stale and erring ones are above).
  return { text: 'bwat is leaving a meeting', why: { say: 'Its bot is free again once it has left.' }, needs: false };
}

/** One line per bot; its ID, version and last report in the line's tooltip. */
function BotLine({ bot, read, recall, canRecall }: { bot: Bot; read: SettingsRead | undefined; recall: RecallMutation; canRecall: boolean }) {
  const state = stateOf(bot);
  const number = zoomNumber(bot.meeting_number);
  const noTranscript = state === 'attending' && bot.error === OUT_OF_CREDIT;
  const tip = `Bot ${bot.bot_id} · version ${bot.version ?? 'unknown'} · last heard ${bot.last_report_at ? relativeTime(bot.last_report_at) : 'never'}`;
  let line;
  if (state === 'attending') {
    const audio = audioOf(bot);
    line = (
      <>
        <b className="tip">In {number}</b>
        {audio && ` · ${audio}${noTranscript ? ', not transcribing' : ''}`} · {titleOf(bot)}
      </>
    );
  } else if (state === 'claimed') line = <b className="tip">Joining {number}</b>;
  else if (state === 'idle') line = <span className="tip">Ready for the next meeting</span>;
  else if (state === 'starting') line = <span className="tip">Starting up</span>;
  else if (state === 'leaving') line = <span className="tip">Leaving its meeting</span>;
  else if (state === 'stale') line = <span className="tip">Not heard from {bot.last_report_at ? relativeTime(bot.last_report_at) : 'yet'}</span>;
  else line = <b className="tip">Can&apos;t take a meeting</b>;
  return (
    <li title={tip}>
      <span className={`pill ${noTranscript ? 'stale' : state}`}>{noTranscript ? 'No transcript' : PILL[state]}</span>
      <span className="line">
        {line}
        {bot.error && !bot.stale && (
          <span className="why">
            <Why reason={reasonOf(bot.error, read)} />
          </span>
        )}
      </span>
      {/* A bot that holds a meeting can be recalled whatever its health: the claim is what is recalled. */}
      {canRecall && bot.claim_id && (
        <Recall id={bot.claim_id} meetingNumber={number} onRecall={recall.mutate} recalling={recall.isPending} />
      )}
    </li>
  );
}

const OPEN: ReadonlySet<Allocation['claim_state']> = new Set(['pending', 'claimed', 'attending']);
const SEND_PILL: Record<Allocation['claim_state'], readonly [className: string, label: string]> = {
  pending: ['requested', 'Waiting for a bot'],
  claimed: ['claimed', 'Joining'],
  attending: ['attending', 'In the meeting'],
  released: ['refused', "Couldn't join"],
  refused: ['refused', "Couldn't join"],
};

/**
 * A send listed on its own: waiting for a bot, held by a bot the fleet read does not show
 * (so it can still be recalled), or ended without bwat getting in. `held` is the claims the
 * bot lines show.
 */
const isSendRow = (a: Allocation, held: ReadonlySet<string>) =>
  OPEN.has(a.claim_state) ? !held.has(a.id) : !a.joined_at && a.refused_reason !== 'recalled';

function SendRow({ send, read, recall, canRecall }: { send: Allocation; read: SettingsRead | undefined; recall: RecallMutation; canRecall: boolean }) {
  const number = zoomNumber(send.meeting_number);
  const date = meetingDate(send.created_at);
  const [pill, label] = SEND_PILL[send.claim_state];
  const reason = send.refused_reason ? reasonOf(send.refused_reason, read) : null;
  const last = send.last_placement_failure ? reasonOf(send.last_placement_failure, read) : null;
  return (
    <li>
      <div className="head">
        <p className="meeting-title">{send.meeting_title ?? `Meeting ${number}`}</p>
        <span className={`pill ${pill}`}>{label}</span>
      </div>
      <p className="meta">
        {date ?? '—'}
        {send.meeting_title && ` · meeting ${number}`}
      </p>
      {reason && (
        <p className="why">
          <Why reason={reason} />
        </p>
      )}
      {last && (
        <p className="why">
          <Why reason={last} lead="Last try:" />
        </p>
      )}
      {canRecall && OPEN.has(send.claim_state) && <Recall id={send.id} meetingNumber={number} onRecall={recall.mutate} recalling={recall.isPending} />}
    </li>
  );
}

/**
 * `live`: a bot holds this meeting now, by the fleet's claim, not by a missing length; null
 * while the bots have never been read, when nothing is said of presence.
 */
function MeetingRow({ meeting, live }: { meeting: Meeting; live: boolean | null }) {
  const date = meetingDate(meeting.started_at);
  const minutes = meeting.duration_seconds == null ? null : Math.round(meeting.duration_seconds / 60);
  return (
    <li>
      <div className="head">
        <p className="meeting-title">{meeting.title ?? 'Untitled meeting'}</p>
        {live && <span className="pill attending">In the meeting</span>}
      </div>
      <p className="meta">
        {date == null ? '—' : <time dateTime={meeting.started_at ?? undefined}>{date}</time>}
        {live ? ' · in progress' : minutes != null ? ` · ${minutes} min` : live === false ? ' · bwat has left' : null}
        {meeting.host_email ? ` · host ${meeting.host_email}` : null}
      </p>
      <a className="board" href={`/?meeting=${encodeURIComponent(meeting.id)}`}>
        Open board
      </a>
    </li>
  );
}

export function Overview({ isAdmin }: { isAdmin: boolean }) {
  const fleet = useQuery({ queryKey: ['fleet'], queryFn: fetchFleet, ...LIVE });
  const allocations = useQuery({ queryKey: ['allocations'], queryFn: fetchAllocations, ...LIVE });
  // The newest page is polled with the bots (and read again after a send or a recall); the
  // older pages Load more reads are read once, from where the newest page ended then.
  const first = useQuery({ queryKey: ['meetings', 'first'], queryFn: () => fetchMeetings(null), ...LIVE });
  const [olderFrom, setOlderFrom] = useState<string | null>(null);
  // Once Load more has read on from olderFrom, a row the newest page pushes out stays: it lies
  // between that page and the older pages, which are not read again. A row gone from within
  // the newest page's own range was deleted, and goes.
  const [kept, setKept] = useState<Meeting[]>([]);
  useEffect(() => {
    if (olderFrom === null || !first.data) return;
    const fresh = first.data.meetings;
    const oldest = fresh.at(-1);
    setKept((rows) => [...fresh, ...rows.filter((r) => !fresh.some((f) => f.id === r.id) && oldest !== undefined && after(r, oldest))]);
  }, [olderFrom, first.data]);
  const older = useInfiniteQuery({
    queryKey: ['meetings', 'older', olderFrom],
    queryFn: ({ pageParam }) => fetchMeetings(pageParam),
    initialPageParam: olderFrom,
    getNextPageParam: (last) => last.next_cursor,
    enabled: olderFrom !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, ...ONCE });
  const { recall, failed } = useRecall();

  // A meeting that moved from the newest page into an older one is listed once.
  const read = [...(first.data?.meetings ?? []), ...kept, ...(older.data?.pages.flatMap((p) => p.meetings) ?? [])];
  const meetings = read.filter((m, i) => read.findIndex((n) => n.id === m.id) === i);
  // Only the latest read counts: after a failed one, the previous bots are not shown.
  const bots = fleet.error ? undefined : fleet.data?.fleet;
  const said = bots && headline(bots, settings.data);
  const held = new Set((bots ?? []).flatMap((b) => (b.claim_id ? [b.claim_id] : [])));
  // Presence is the last good read of the bots: a failed read keeps it, and none yet says nothing.
  const known = fleet.data?.fleet;
  const liveOccurrences = new Set((known ?? []).flatMap((b) => (b.claim_id && b.occurrence_id ? [b.occurrence_id] : [])));

  const sends = (allocations.data?.allocations ?? []).filter((a) => isSendRow(a, held));
  const recent = [
    ...meetings.map((m) => ({ at: m.started_at ?? '', row: <MeetingRow key={m.id} meeting={m} live={known ? liveOccurrences.has(m.occurrence_id) : null} /> })),
    ...sends.map((s) => ({ at: s.created_at ?? '', row: <SendRow key={s.id} send={s} read={settings.data} recall={recall} canRecall={isAdmin} /> })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // A first read of the older pages that failed has no page to go on from: Load more reads it again.
  const olderFailed = older.isError && !older.data?.pages.length;
  const moreFrom = olderFrom === null ? first.data?.next_cursor : older.hasNextPage || olderFailed || older.isFetching ? 'next' : null;

  return (
    <section className="overview" aria-labelledby="ov-sentence">
      {fleet.isPending && (
        <p role="status" className="muted">
          Loading…
        </p>
      )}
      <LoadError what="the bots" error={fleet.error} />
      {said && (
        <div className={said.needs ? 'headline needs' : 'headline'}>
          <h2 id="ov-sentence">
            <span className="state-dot" aria-hidden="true" />
            {said.text}
          </h2>
          <p className="muted">
            <Why reason={said.why} />
          </p>
          {said.why.actions && (
            <div className="next">
              {said.why.actions.map(({ label, href }, i) => (
                <a
                  key={label}
                  className={i === 0 ? 'button primary' : 'button'}
                  href={href}
                  {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {label}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && <FinishSetup />}

      {settings.data?.autoJoin && (
        <section aria-labelledby="ov-joining">
          <h3 id="ov-joining">Automatic joining</h3>
          <Readiness autoJoin={settings.data.autoJoin} />
        </section>
      )}

      {bots && (
        <section aria-labelledby="ov-bots">
          <h3 id="ov-bots">Bots now</h3>
          {bots.length === 0 ? (
            <p className="muted">No bwat bots are running yet.</p>
          ) : (
            <ul className="bots" aria-label="Bots">
              {bots.map((bot) => (
                <BotLine key={bot.bot_id} bot={bot} read={settings.data} recall={recall} canRecall={isAdmin} />
              ))}
            </ul>
          )}
        </section>
      )}

      <SendForm />
      {failed && recall.error && (
        <p role="alert" className="error">
          {sendError(recall.error)}
        </p>
      )}

      <section aria-labelledby="ov-recent">
        <h3 id="ov-recent">Recent meetings</h3>
        <LoadError what="the meetings" error={first.error ?? older.error ?? allocations.error} />
        {first.isPending ? (
          <p className="muted">Loading…</p>
        ) : recent.length === 0 ? (
          // Only a read that answered can say there are none; a failed one says so above.
          first.data && <p className="muted">No meetings yet. Once bwat has joined a meeting, it shows up here.</p>
        ) : (
          <ul className="meetings" aria-label="Recent meetings">
            {recent.map((r) => r.row)}
          </ul>
        )}
        {moreFrom && (
          <div className="recent-foot">
            <button
              type="button"
              onClick={() => (olderFrom === null ? setOlderFrom(moreFrom) : olderFailed ? void older.refetch() : void older.fetchNextPage())}
              disabled={older.isFetching}
            >
              {older.isFetching ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
