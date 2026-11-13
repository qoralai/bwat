import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { andList, ApiError, sendJsonForBody, sessionGone, ONCE, refetchOnForbidden } from './api';
import { LoadError } from './LoadError';
import { SECTIONS, settingDef, validateSection, type SettingDef } from './catalogue';
import { CardsModel } from './CardsModel';
import { Dictionary } from './Dictionary';
import { PresencePicture } from './PresencePicture';
import { setupSentence } from './Readiness';
import { fetchSettings, joinSentence, settingAt, type Entry, type SettingsRead } from './settingsRead';
import { Credentials, ModelKeys } from './Secrets';
import { GoogleSignIn } from './GoogleSignIn';

/* The company's settings, in five places: Meeting bot, Cards, Models, Data and Connections.
   A member reads them as sentences; an owner or admin changes them. The join timings and
   the Jev tuning thresholds keep their stored values and defaults but are not offered here.

   Every change waits in one page-level draft until Save. Save sends every key that
   changed in one request, with the revision this page read for each. The backend stores
   all of it or none: a save over someone else's is refused as a whole (409 stale), and the
   draft stays on screen until the reader chooses Reload. */

/** JSON equality for the small values a setting holds; unset (null) equals a missing value. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The number of days keeps what was typed when it is not a whole number, so the shared
// validation names the problem rather than the page quietly dropping it.
const wholeFrom = (text: string): unknown => (text === '' ? null : /^\d+$/.test(text) ? Number(text) : text);

/** The five places, in order; a member sees only Meeting bot, Cards and Retention. */
const PLACES = [
  { id: 'bot', title: 'Meeting bot' },
  { id: 'cards', title: 'Cards' },
  { id: 'models', title: 'Models' },
  { id: 'data', title: 'Retention' },
  { id: 'connections', title: 'Connections' },
] as const;
type Place = (typeof PLACES)[number]['id'];
const MEMBER_PLACES: readonly Place[] = ['bot', 'cards', 'data'];

/** Every key the save bar holds, with the place that shows it. Each is named by its catalogue label, as its problems are. */
const DRAFT_PLACES: Record<string, Place> = {
  auto_join_enabled: 'bot',
  auto_join_require_host: 'bot',
  bypass_waiting_room: 'bot',
  display_name: 'bot',
  chat_posts_enabled: 'bot',
  chat_agenda_enabled: 'bot',
  cards_granularity: 'cards',
  jev_enabled: 'cards',
  jev_model: 'models',
  transcript_keep_forever: 'data',
  transcript_retention_days: 'data',
  cards_keep_open_forever: 'data',
  cards_close_after_days: 'data',
};
const DRAFT_KEYS = Object.keys(DRAFT_PLACES);
/** The places these keys are shown in, by name, in page order: "Meeting bot and Cards". */
const placeNames = (keys: readonly string[]) => andList(PLACES.filter((p) => keys.some((k) => DRAFT_PLACES[k] === p.id)).map((p) => p.title));

const def = (key: string) => settingDef(key)!;

/**
 * One moment from a real meeting, names and product removed, as each grouping
 * cards it. Static text: the slider shows the difference without asking a model.
 */
const MOMENT =
  "“The service restarted mid-release and everyone's sessions froze. The proper fix is blue-green: keep the old one up, switch people over, then turn the old one off.”";
const RISK = ['Risk', "A restart mid-release freezes everyone's sessions"] as const;
const GROUPED: Record<string, readonly (readonly [kind: string, title: string, detail?: string])[]> = {
  fewer: [
    ['To-do', 'Move releases to a blue-green rollout', 'Keep the old instance up while the new one starts, switch everyone over, then turn it off. Sessions froze on the last restart.'],
  ],
  balanced: [['To-do', 'Move releases to a blue-green rollout'], RISK],
  more: [
    ['To-do', 'Keep the old instance up while the new one starts'],
    ['To-do', 'Switch everyone to the new instance'],
    ['To-do', 'Turn off the old instance once everyone has moved'],
    RISK,
  ],
};

/** Every grouping's cards at once; the ones not picked fold away (and leave the accessibility tree). */
function GroupingExample({ grouping }: { grouping: string }) {
  return (
    <>
      <p className="muted quote">{MOMENT}</p>
      <div className="mini">
        {Object.entries(GROUPED).flatMap(([step, cards]) =>
          cards.map(([kind, title, detail]) => (
            <div key={`${step}-${title}`} className={[kind === 'Risk' && 'risk', step !== grouping && 'gone'].filter(Boolean).join(' ') || undefined} aria-hidden={step === grouping ? undefined : true}>
              <b>{kind}</b>
              {title}
              {detail && <small>{detail}</small>}
            </div>
          )),
        )}
      </div>
    </>
  );
}

function Field({
  setting,
  label = setting.label,
  value,
  fallback,
  changed,
  onChange,
  children,
}: {
  setting: SettingDef;
  /** The page's own name for it, where that is shorter than the catalogue's. */
  label?: string;
  value: unknown;
  fallback: unknown;
  changed: boolean;
  onChange: (value: unknown) => void;
  children?: ReactNode;
}) {
  const id = `setting-${setting.key}`;
  const { kind } = setting;
  // An on/off or a short value is one line: its label on the left, its control on the right.
  const inline = (control: ReactNode) => (
    <div className={changed ? 'setting inline changed' : 'setting inline'}>
      <span className="l">
        <label htmlFor={id}>{label}</label>
        {children}
      </span>
      {control}
    </div>
  );
  let control: ReactNode;
  if (kind.type === 'boolean') {
    const on = Boolean(value ?? fallback);
    return inline(
      <span className="switch">
        <input id={id} type="checkbox" role="switch" aria-checked={on} checked={on} onChange={(e) => onChange(e.target.checked)} />
        <i aria-hidden="true" />
      </span>,
    );
  } else if (kind.type === 'steps') {
    // A slider over the named steps; the stored value is the step's name, never its position.
    const at = kind.options.findIndex(([v]) => v === (value ?? fallback));
    const name = kind.options[at]![1];
    control = (
      <>
        <label htmlFor={id}>{label}</label>
        <div className="steps-track">
          <input
            id={id}
            type="range"
            min={0}
            max={kind.options.length - 1}
            step={1}
            value={at}
            aria-valuetext={name}
            onChange={(e) => onChange(kind.options[Number(e.target.value)]![0])}
          />
          <div className="step-ends" aria-hidden="true">
            {kind.options.map(([v, stepName]) => (
              <span key={v}>{stepName}</span>
            ))}
          </div>
        </div>
      </>
    );
  } else {
    return inline(
      <span className="field">
        <input
          id={id}
          type="text"
          value={value == null ? '' : String(value)}
          placeholder={setting.example ? `e.g. ${setting.example}` : String(fallback)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      </span>,
    );
  }
  return (
    <div className={changed ? 'setting changed' : 'setting'}>
      {control}
      {children}
    </div>
  );
}

const UNCONFIRMED = "We couldn't confirm the save. Reload to see what is stored.";

/**
 * Why a save failed, in words; null when /whoami takes over (the session is gone).
 * `baseline` is what the save was sent against: a stale key is one whose revision moved since.
 */
function SaveError({ error, reload, baseline }: { error: Error; reload: () => void; baseline: Record<string, Entry> }) {
  if (sessionGone(error)) return null;
  const code = error instanceof ApiError ? error.code : undefined;
  const problems = error instanceof ApiError ? error.body.problems : undefined;
  const withReload = (text: string) => (
    <>
      <p>{text}</p>
      <p>
        <button type="button" className="button" onClick={reload}>
          Reload
        </button>
      </p>
    </>
  );
  // Only a 4xx refusal proves nothing was stored.
  const refused = error instanceof ApiError && error.status < 500;
  let message: ReactNode = refused ? 'Something went wrong and nothing was saved. Try again.' : withReload(UNCONFIRMED);
  if (code === 'stale') {
    const current = (error as ApiError).body.currentRevisions as Record<string, number | null>;
    const staleKeys = Object.keys(current).filter((k) => current[k] !== (baseline[k]?.revision ?? null));
    message = withReload(`Nothing was saved. ${placeNames(staleKeys)} changed elsewhere: reload to see it.`);
  }
  else if (code === 'forbidden') message = 'Only admins can change settings.';
  else if ((code === 'invalid_settings' || code === 'auto_join_not_ready') && Array.isArray(problems)) {
    message = (
      <>
        <p>Nothing was saved. These settings can&apos;t be saved:</p>
        <ul>
          {problems.map((p) => (
            <li key={String(p)}>{String(p)}</li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <div role="alert" className="error">
      {message}
    </div>
  );
}

/** The logo's lens, its orange arc drawn round on a save. Decoration only. */
function Lens() {
  return (
    <svg className="lensmark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="5" />
      <path className="arc" d="M18.5 15.5A8 8 0 1 1 20 12" />
    </svg>
  );
}

const SAVED_MS = 1800;

/** `dots` lights a place's dot. */
function Places({
  page,
  setPage,
  places,
  dots,
}: {
  page: Place;
  setPage: (p: Place) => void;
  places: readonly Place[];
  dots?: Partial<Record<Place, boolean>>;
}) {
  return (
    <nav className="subnav" aria-label="Settings pages">
      {PLACES.filter((p) => places.includes(p.id)).map(({ id, title }) => (
        <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}>
          {title}
          {dots && id in dots && <span className={dots[id] ? 'dot ok' : 'dot'} aria-hidden="true" />}
        </button>
      ))}
    </nav>
  );
}

const Heading = ({ page }: { page: Place }) => <h3>{PLACES.find((p) => p.id === page)!.title}</h3>;

/** The Cards place's fast writer, named for what it does; its line keeps the data fact. */
const FASTER = 'Faster cards';
const FASTER_NOTE = 'Writes a card as soon as something worth one is said, using your OpenRouter key, and only while OpenRouter lists it as zero data retention.';

/** A member's view: what is set, said in sentences. */
function Sentences({ read, page, setPage }: { read: SettingsRead; page: Place; setPage: (p: Place) => void }) {
  const at = (key: string) => settingAt(read, key);
  const shown = MEMBER_PLACES.includes(page) ? page : 'bot';
  let lines: ReactNode;
  if (shown === 'bot') {
    lines = (
      <>
        <p>{joinSentence(read)}</p>
        <p>
          It shows up as <b>{String(at('display_name'))}</b>, with its picture as its video.
        </p>
        <p>
          {!at('chat_posts_enabled')
            ? 'It does not post in the meeting chat.'
            : at('chat_agenda_enabled')
              ? 'It posts in the meeting chat.'
              : 'It posts in the meeting chat, but nothing on joining.'}
        </p>
      </>
    );
  } else if (shown === 'cards') {
    const grouped = { fewer: 'fewer and fuller', balanced: 'balanced', more: 'more and smaller' }[String(at('cards_granularity'))];
    lines = (
      <>
        <p>
          Cards are grouped <b>{grouped}</b>.
        </p>
        <p>{at('jev_enabled') ? 'Faster cards are on.' : 'Faster cards are off.'}</p>
      </>
    );
  } else {
    lines = at('transcript_keep_forever') ? (
      <p>Transcripts are kept forever. Cards stay.</p>
    ) : (
      <p>
        Transcripts are deleted after <b>{String(at('transcript_retention_days'))} days</b>. Cards stay.
      </p>
    );
  }
  return (
    <div className="settings-layout">
      <Places page={shown} setPage={setPage} places={MEMBER_PLACES} />
      <div className="settings-pane">
        <Heading page={shown} />
        <div className="readonly">{lines}</div>
        <p className="muted">Only an owner or an admin changes these.</p>
        {/* Anyone signed in keeps the dictionary. */}
        {shown === 'cards' && <Dictionary />}
      </div>
    </div>
  );
}

const valuesOf = (settings: Record<string, Entry>): Record<string, unknown> => Object.fromEntries(DRAFT_KEYS.map((k) => [k, settings[k]?.value ?? null]));
const pick = (settings: Record<string, Entry>, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, settings[k]!]));

/** An owner's or admin's view: every place, one draft and one save bar. */
function Editor({ read, reload, page, setPage }: { read: SettingsRead; reload: () => void; page: Place; setPage: (p: Place) => void }) {
  const queryClient = useQueryClient();
  // What this page last read or saved, key by key: a save answers with every key, but
  // only the keys it sent move, so someone else's change never reads as one of ours.
  const [baseline, setBaseline] = useState(read.settings);
  const [draft, setDraft] = useState(() => valuesOf(read.settings));
  const [autoJoin, setAutoJoin] = useState(read.autoJoin);
  const ready = Boolean(autoJoin?.effective);
  const [saved, setSaved] = useState(false);
  const stored = (key: string) => baseline[key]?.value ?? null;
  const fallback = (key: string) => baseline[key]?.default ?? def(key).codeDefault;
  const changed = DRAFT_KEYS.filter((k) => !same(draft[k], stored(k)));
  const isChanged = (key: string) => changed.includes(key);
  // Put back by hand, a key that was unset is unset again: no change to save.
  const set = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: stored(key) === null && same(value, fallback(key)) ? null : value }));
  // Only what is being saved is checked: a stored value is the server's to have accepted.
  const problems = SECTIONS.flatMap((section) =>
    validateSection(section, Object.fromEntries(changed.filter((k) => def(k).section === section).map((k) => [k, draft[k]]))),
  );

  const save = useMutation({
    mutationFn: async () => {
      const changes = Object.fromEntries(changed.map((k) => [k, { value: draft[k] ?? null, expectedRevision: baseline[k]?.revision ?? null }]));
      const answer = (await sendJsonForBody('PUT', '/v1/console/settings', { changes })) as SettingsRead;
      setBaseline((b) => ({ ...b, ...pick(answer.settings, changed) }));
      // A field typed in again while this was on its way keeps the newer value.
      setDraft((d) => ({ ...d, ...Object.fromEntries(changed.filter((k) => same(d[k], draft[k])).map((k) => [k, answer.settings[k]?.value ?? null])) }));
      if (answer.autoJoin) setAutoJoin(answer.autoJoin);
      // The shared read now holds what is stored, so the Overview shows it without reading again.
      // It stays fresh (nothing refetches it), and the Editor is keyed on Reload, not on this read.
      // A save with no joining key is answered without autoJoin: the read keeps the one it had.
      queryClient.setQueryData<SettingsRead>(['settings'], (old) => ({ ...answer, autoJoin: answer.autoJoin ?? old?.autoJoin }));
    },
    onMutate: () => setSaved(false),
    onSuccess: () => {
      setSaved(true);
    },
    // Made a member meanwhile: both reads change what the page offers.
    ...refetchOnForbidden(['me'], ['settings']),
  });
  // "Saved" holds, then the bar goes.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saved]);

  const field = (key: string, children?: ReactNode, label?: string) => (
    <Field key={key} setting={def(key)} label={label} value={draft[key]} fallback={fallback(key)} changed={isChanged(key)} onChange={(v) => set(key, v)}>
      {children}
    </Field>
  );

  let body: ReactNode;
  if (page === 'bot') {
    body = (
      <>
        {autoJoin && (
          <div className={ready ? 'setup' : 'setup warn'}>
            <p>{setupSentence(autoJoin)}</p>
            <a className="link" href="#/">
              See the checks on Overview
            </a>
          </div>
        )}
        <div className="block">
          <h4 className="eyebrow">Joining</h4>
          {field('auto_join_enabled')}
          {field('auto_join_require_host')}
          {field('bypass_waiting_room')}
        </div>
        <div className="block">
          <h4 className="eyebrow">In the meeting</h4>
          <PresencePicture name={String(draft.display_name ?? fallback('display_name')).trim() || String(fallback('display_name'))}>
            {field('display_name')}
          </PresencePicture>
          {field('chat_posts_enabled', <small className="muted">The hello, open items from last time, 5 minutes left and time up.</small>)}
          {field('chat_agenda_enabled', <small className="muted">A short summary of what is still open from last time, or the hello.</small>)}
        </div>
      </>
    );
  } else if (page === 'cards') {
    body = (
      <>
        <div className="block">{field('cards_granularity', <GroupingExample grouping={String(draft.cards_granularity ?? fallback('cards_granularity'))} />)}</div>
        <div className="block">{field('jev_enabled', <small className="muted">{FASTER_NOTE}</small>, FASTER)}</div>
        <Dictionary />
      </>
    );
  } else if (page === 'models') {
    body = (
      <>
        <CardsModel />
        <section className="block" aria-labelledby="settings-jev-model">
          <h4 id="settings-jev-model" className="eyebrow">
            Jev
          </h4>
          <p className="muted">
            Tells the card writer when something card-worthy was said, through OpenRouter, while Faster cards is on in Cards. A change here
            saves with the bar below, not with Save model.
          </p>
          {field('jev_model')}
        </section>
        <ModelKeys />
      </>
    );
  } else if (page === 'data') {
    // A choice between keeping forever and a number of days (the cards one is new).
    // Forever hides Days, so a change typed there is dropped rather than left to hold Save.
    const foreverOrDays = (id: string, label: string, foreverKey: string, daysKey: string, afterText: string, daysLabel: string) => {
      const forever = Boolean(draft[foreverKey] ?? fallback(foreverKey));
      const days = draft[daysKey];
      return (
        <div
          className={isChanged(foreverKey) || isChanged(daysKey) ? 'setting inline changed' : 'setting inline'}
          role="group"
          aria-labelledby={id}
        >
          <span id={id} className="setting-label">
            {label}
          </span>
          <span className="choice">
            <span className="seg">
              <button
                type="button"
                aria-pressed={forever}
                onClick={() => {
                  set(foreverKey, true);
                  set(daysKey, stored(daysKey));
                }}
              >
                Forever
              </button>
              <button type="button" aria-pressed={!forever} onClick={() => set(foreverKey, false)}>
                {afterText}
              </button>
            </span>
            {!forever && (
              <span className="field">
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={daysLabel}
                  value={days == null ? '' : String(days)}
                  placeholder={String(fallback(daysKey))}
                  onChange={(e) => set(daysKey, wholeFrom(e.target.value))}
                />
                <span className="unit">days</span>
              </span>
            )}
          </span>
        </div>
      );
    };
    body = (
      <>
        <div className="block">
          {foreverOrDays('keep-transcripts', 'Keep transcripts', 'transcript_keep_forever', 'transcript_retention_days', 'Delete after', 'Days')}
        </div>
        <p className="muted">Cards stay. Only the word-for-word transcript is deleted.</p>
        <div className="block">
          {foreverOrDays('keep-cards', 'Keep untouched cards open', 'cards_keep_open_forever', 'cards_close_after_days', 'Close after', 'Days before a card closes')}
        </div>
        <p className="muted">A card nobody acts on for that long closes as no response. Over its last 5 days it says when, with a Keep button.</p>
      </>
    );
  } else {
    body = (
      <>
        <section className="block" aria-labelledby="settings-zoom">
          <h4 id="settings-zoom" className="eyebrow">
            Zoom
          </h4>
          <Credentials />
        </section>
        <GoogleSignIn />
      </>
    );
  }

  const count = changed.length === 1 ? '1 change' : `${changed.length} changes`;
  return (
    <div className="settings-layout">
      <Places page={page} setPage={setPage} places={PLACES.map((p) => p.id)} dots={{ bot: ready }} />
      <div className="settings-pane">
        <Heading page={page} />
        {body}
        {problems.length > 0 && (
          <ul className="notice warn">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {save.isError && <SaveError error={save.error} reload={reload} baseline={baseline} />}
        <div className={changed.length > 0 || saved ? 'savebar show' : 'savebar'} role="region" aria-label="Unsaved changes">
          <span className="l">
            {changed.length > 0 && !saved && count}
            <span role="status" className={saved ? 'saved play' : 'saved'}>
              {saved && (
                <>
                  <Lens />
                  <span className="savedword">Saved</span>
                </>
              )}
            </span>
          </span>
          <button
            type="button"
            className="button quiet"
            disabled={changed.length === 0 || save.isPending}
            onClick={() => {
              save.reset();
              setDraft(valuesOf(baseline));
            }}
          >
            Undo
          </button>
          <button
            type="button"
            className="button primary"
            disabled={changed.length === 0 || save.isPending || problems.length > 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Settings() {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    // Read once per visit, never behind the reader's back: a refetch would replace
    // edits in progress. Reload is the reader's choice.
    ...ONCE,
  });
  // #/settings?place=<id> opens that place; a member is shown Meeting bot for one not theirs.
  const [page, setPage] = useState<Place>(() => {
    const linked = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('place');
    return PLACES.find((p) => p.id === linked)?.id ?? 'bot';
  });
  const read = settings.error ? undefined : settings.data;
  // Bumped once a Reload has read the settings again: only then does the draft start over.
  const [reloads, setReloads] = useState(0);
  const reload = () => void settings.refetch().then(() => setReloads((n) => n + 1));
  return (
    <section className="settings">
      <h2>Settings</h2>
      {settings.isPending && (
        <p role="status" className="muted">
          Loading settings…
        </p>
      )}
      <LoadError what="the settings" error={settings.error} />
      {read &&
        (read.canManage ? (
          // Keyed on Reload, never on the read: a save that refreshes the shared read keeps the draft.
          <Editor key={reloads} read={read} reload={reload} page={page} setPage={setPage} />
        ) : (
          <Sentences read={read} page={page} setPage={setPage} />
        ))}
    </section>
  );
}
