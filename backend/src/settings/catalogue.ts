/**
 * The settings catalogue: every key the panel's Settings page can save, its section,
 * type and range, its default, who is served it (the bots, the card service), and the one validation
 * a save goes through. A key that is not here is not a setting, and a save naming one is refused.
 * Model keys are not settings: they live in the secret store (src/model-keys.ts).
 *
 * Adapted from our own prototype admin panel (docs/provenance.md).
 */

/** The Settings page's sections, in page order; each saves on its own. */
export const SECTIONS = ['joining', 'behaviour', 'retention', 'jev'] as const;
export type SettingsSection = (typeof SECTIONS)[number];

/** The JSON a key holds, which is also how it is checked. */
type SettingKind =
  | { type: 'boolean' }
  | { type: 'whole'; min: number; max: number; unit: 'minutes' | 'days' | 'seconds' | 'percent' }
  | { type: 'name' }
  | { type: 'steps'; options: readonly (readonly [value: string, label: string])[] };

/** One row of the catalogue. */
interface SettingDef {
  key: string;
  section: SettingsSection;
  /** The plain label; validation messages name it. */
  label: string;
  kind: SettingKind;
  /** What applies while the key is unset (and the reader's env is unset too); GET /console/settings shows it. */
  codeDefault: string | number | boolean;
  /** Who it is served to: GET /bot/settings, GET /cards/settings. Empty: read by the backend itself. */
  servedTo: readonly ('bot' | 'cards')[];
  /** An example value the panel shows by the field ("e.g. ..."), for a setting that is pasted in. */
  example?: string;
}

/** The complete key list, in page order. */
export const SETTINGS: readonly SettingDef[] = [
  // The auto-join pair is enforced by the backend when a meeting starts, not by the bot.
  // Off until an admin turns it on; once on, Zoom and fleet readiness checks still gate it.
  {
    key: 'auto_join_enabled',
    section: 'joining',
    label: 'Join meetings on its own',
    kind: { type: 'boolean' },
    codeDefault: false,
    servedTo: [],
  },
  {
    key: 'auto_join_require_host',
    section: 'joining',
    label: 'Only once the host is there',
    kind: { type: 'boolean' },
    codeDefault: true,
    servedTo: [],
  },
  {
    // Read by the backend when it mints the bot's recording join token, which Zoom lets
    // skip the waiting room (QOR-4893); the SDK has no switch of its own for it.
    key: 'bypass_waiting_room',
    section: 'joining',
    label: 'Skip the waiting room',
    kind: { type: 'boolean' },
    codeDefault: true,
    servedTo: [],
  },
  {
    key: 'wait_for_start_min',
    section: 'joining',
    label: 'Wait for a meeting to start',
    // 0 = no limit.
    kind: { type: 'whole', min: 0, max: 120, unit: 'minutes' },
    codeDefault: 10,
    servedTo: ['bot'],
  },
  {
    key: 'waiting_room_min',
    section: 'joining',
    label: 'Wait in a waiting room',
    kind: { type: 'whole', min: 0, max: 120, unit: 'minutes' },
    codeDefault: 15,
    servedTo: ['bot'],
  },
  {
    key: 'idle_leave_min',
    section: 'joining',
    label: 'Leave after a silence of',
    // From 1, not 0: 0 would leave on any silence.
    kind: { type: 'whole', min: 1, max: 120, unit: 'minutes' },
    codeDefault: 5,
    servedTo: ['bot'],
  },
  {
    key: 'display_name',
    section: 'joining',
    label: 'Name',
    kind: { type: 'name' },
    // The installer asks for it (BWAT_BOT_NAME); the admin can still change it here.
    codeDefault: process.env.BWAT_BOT_NAME?.trim() || 'bwat',
    servedTo: ['bot'],
  },
  {
    // How the card writer splits what is said into cards; Balanced is the writer as it always was.
    key: 'cards_granularity',
    section: 'behaviour',
    label: 'Card grouping',
    kind: {
      type: 'steps',
      options: [
        ['fewer', 'Fewer, fuller'],
        ['balanced', 'Balanced'],
        ['more', 'More, smaller'],
      ],
    },
    codeDefault: 'balanced',
    servedTo: ['cards'],
  },
  {
    // On, the bot posts in the meeting chat: the hello or the agenda carried over on joining,
    // and with a scheduled end the five-minute warning and the alarm clock at the end.
    // Off until an admin turns it on.
    key: 'chat_posts_enabled',
    section: 'behaviour',
    label: 'Post to the meeting chat',
    kind: { type: 'boolean' },
    codeDefault: false,
    servedTo: ['bot'],
  },
  {
    // QOR-4966: on, with the chat posts on, the bot posts on joining the summary of what is
    // still open from last time, or the hello when nothing is; off, nothing on joining. The
    // timed posts stay as the chat posts setting has them.
    key: 'chat_agenda_enabled',
    section: 'behaviour',
    label: 'Post the agenda on joining',
    kind: { type: 'boolean' },
    codeDefault: false,
    servedTo: ['bot'],
  },
  {
    // A255, D163: transcripts older than this many days are deleted by the retention job
    // (the meeting and its cards stay), which reads it on every run. From 1: 0 would
    // expire every ended meeting. Keeping forever is its own choice, below.
    key: 'transcript_retention_days',
    section: 'retention',
    label: 'Days to keep transcripts',
    kind: { type: 'whole', min: 1, max: 36_500, unit: 'days' },
    codeDefault: 90,
    servedTo: [],
  },
  {
    // QOR-4600, D168: on, the retention job keeps meeting content (transcripts, inbox briefs,
    // hand-off keys) but still clears passcodes and Zoom's records. On by default (QOR-4760).
    key: 'transcript_keep_forever',
    section: 'retention',
    label: 'Keep transcripts forever',
    kind: { type: 'boolean' },
    codeDefault: true,
    servedTo: [],
  },
  {
    // QOR-4769: Jev, the card service's cheap check whether new transcript lines are worth a
    // writer pass. On by default; the installer's "no" writes BWAT_JEV=off, which turns
    // the default off (a stored value still wins).
    key: 'jev_enabled',
    section: 'jev',
    label: 'Faster cards with Jev',
    kind: { type: 'boolean' },
    codeDefault: process.env.BWAT_JEV !== 'off',
    servedTo: ['cards'],
  },
  {
    // QOR-4769: the OpenRouter model id Jev is asked through. A model id holds no quote or
    // control character, so the name check fits it.
    key: 'jev_model',
    section: 'jev',
    label: 'Jev model',
    kind: { type: 'name' },
    codeDefault: 'typesafe/jev-1.13',
    servedTo: ['cards'],
    example: 'typesafe/jev-1.13',
  },
  {
    // QOR-4769: the writer is due once Jev's score reaches this percentage.
    key: 'jev_threshold_pct',
    section: 'jev',
    label: 'Jev threshold',
    kind: { type: 'whole', min: 5, max: 95, unit: 'percent' },
    codeDefault: 65,
    servedTo: ['cards'],
  },
  {
    // The confidence, in whole percent, at which a card shows Jev's duplicate or related pick.
    key: 'jev_link_threshold_pct',
    section: 'jev',
    label: 'Link threshold',
    kind: { type: 'whole', min: 5, max: 95, unit: 'percent' },
    codeDefault: 85,
    servedTo: ['cards'],
  },
  {
    // QOR-4769: the writer is due once the oldest line it has not read is this old, whatever Jev says.
    key: 'jev_deadline_s',
    section: 'jev',
    label: 'Card deadline',
    kind: { type: 'whole', min: 15, max: 600, unit: 'seconds' },
    codeDefault: 60,
    servedTo: ['cards'],
  },
];

/** The catalogue row for a key, or undefined when it is not a setting. */
export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/** The keys GET /bot/settings serves. */
export const SERVED_KEYS = SETTINGS.filter((s) => s.servedTo.includes('bot')).map((s) => s.key);

/** The keys GET /cards/settings serves (QOR-4769). */
export const CARDS_KEYS = SETTINGS.filter((s) => s.servedTo.includes('cards')).map((s) => s.key);

// A name is shown to people, so no controls (Cc), format characters (Cf: bidi marks and
// overrides, zero-width and tag characters), line or paragraph separators or unassigned
// code points, any of which could make it read as something else or as nothing; ZWNJ and
// ZWJ are allowed (scripts and emoji need them). Plus the letters that render blank.
const NAME_MAX = 200;
const UNSAFE_IN_NAME = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cn}\u115F\u1160\u3164\uFFA0\u2800]/u;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/** The problem with one non-null value, or null when it is fine. */
function problemWith(def: SettingDef, value: unknown): string | null {
  const { label, kind } = def;
  switch (kind.type) {
    case 'boolean':
      // A JSON boolean only: a stored "false" would read as on to a truthiness check.
      return typeof value === 'boolean' ? null : `${label} must be on or off.`;
    case 'whole': {
      const ok = Number.isInteger(value) && (value as number) >= kind.min && (value as number) <= kind.max;
      const none = kind.min === 0 ? ' (0 = no limit)' : '';
      return ok ? null : `${label} must be a whole number from ${kind.min} to ${kind.max}${none}.`;
    }
    case 'name': {
      if (typeof value !== 'string') return `${label} must be text.`;
      const name = value.trim();
      // Checked before blank: a lone hidden character must not read as merely empty.
      if (UNSAFE_IN_NAME.test(name)) return `${label} cannot contain hidden or control characters.`;
      if (!VISIBLE.test(name)) return `${label} cannot be blank.`;
      if ([...name].length > NAME_MAX) return `${label} must be at most ${NAME_MAX} characters.`;
      // The bot writes the name into a TOML string and refuses both.
      if (/["\\]/.test(name)) return `${label} cannot contain " or \\.`;
      return null;
    }
    case 'steps':
      return kind.options.some(([v]) => v === value) ? null : `${label} must be one of ${kind.options.map(([v]) => v).join(', ')}.`;
  }
}

/**
 * Checks a section's values before a save: `values` maps each key being saved to its
 * new value. `null` always passes: it is "reset to default". A key that is not in the
 * catalogue, or is in another section, is a problem. One message per problem; empty
 * when the values are clean.
 */
export function validateSection(section: SettingsSection, values: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const def = settingDef(key);
    if (!def) problems.push(`"${key}" is not a setting.`);
    else if (def.section !== section) problems.push(`"${key}" is not in the ${section} section.`);
    else if (value !== null) {
      const problem = problemWith(def, value);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

/** The value as stored: a name trimmed, anything else as given. */
export function normalised(key: string, value: unknown): unknown {
  if (value === null) return null;
  const kind = settingDef(key)!.kind.type;
  if (kind === 'name') return (value as string).trim();
  return value;
}
