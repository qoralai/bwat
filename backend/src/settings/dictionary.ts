import type pg from 'pg';
import { isObject } from '../http.ts';

/**
 * The corrections dictionary bwat corrects transcripts with: its shape check, its
 * validation, its dated version stamp, and the singleton row that holds it.
 *
 * Three states: absent = no row; cleared = a row whose payload is JSON null; set = a row
 * whose payload is an object. Absent and cleared both disable custom corrections.
 * The validation is adapted from our own prototype admin panel
 * (docs/provenance.md): it rejects what bwat's loader would reject, here, where it can be
 * corrected, because bwat fails closed on a bad dictionary and keeps the old one.
 */

type Db = pg.Pool | pg.ClientBase;

export type DictionaryState = 'set' | 'cleared' | 'absent';

export interface DictionaryView {
  state: DictionaryState;
  /** The integer a save is conditional on. */
  revision: number | null;
  /** The dated version string the server stamps on each save (`payload.version`). */
  version: string | null;
  payload: Record<string, unknown> | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const ABSENT: DictionaryView = { state: 'absent', revision: null, version: null, payload: null, updatedAt: null, updatedBy: null };

interface Entry {
  id?: unknown;
  canonical?: unknown;
  hardness?: unknown;
  proper_noun?: unknown;
}
interface Alias {
  alias?: unknown;
  target_id?: unknown;
  scopes?: unknown;
}

const text = (v: unknown): v is string => typeof v === 'string';

const SHAPE_PROBLEM = 'The dictionary needs a list of words (targets) and a list of corrections (aliases).';
const MALFORMED_PROBLEM = 'Every word, person and correction must be an object with text fields.';

/**
 * What is wrong with a payload, in the editor's words; empty when it may be saved.
 * Every key the panel does not know is kept as sent: bwat reads the whole payload.
 */
export function problemsWith(payload: unknown): string[] {
  if (!isObject(payload) || !Array.isArray(payload.targets) || !Array.isArray(payload.aliases)) return [SHAPE_PROBLEM];
  if (payload.people !== undefined && !Array.isArray(payload.people)) return [SHAPE_PROBLEM];
  const targets = payload.targets as unknown[];
  const people = (payload.people ?? []) as unknown[];
  const aliases = payload.aliases as unknown[];
  const fine = (row: unknown, fields: string[]) => isObject(row) && fields.every((f) => row[f] === undefined || text(row[f]));
  if (![...targets, ...people].every((r) => fine(r, ['id', 'canonical'])) || !aliases.every((r) => fine(r, ['alias', 'target_id']))) {
    return [MALFORMED_PROBLEM];
  }

  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of [...targets, ...people] as Entry[]) {
    if (!t.id || !text(t.canonical) || !t.canonical.trim()) problems.push('Every entry needs an id and a spelling.');
    else if (ids.has(t.id as string)) problems.push(`Two entries share the id "${t.id as string}".`);
    if (text(t.id)) ids.add(t.id);
  }
  // bwat's compiler reads these two off a word with no default.
  for (const t of targets as Entry[]) {
    if (!t.hardness || t.proper_noun === undefined) problems.push(`"${(t.canonical || t.id) as string}" is missing settings bwat needs.`);
  }
  const personIds = new Set((people as Entry[]).map((p) => p.id));
  const canonicals = new Map(([...targets, ...people] as Entry[]).filter((t) => text(t.canonical)).map((t) => [(t.canonical as string).toLowerCase(), t.id]));
  const seen = new Set<string>();
  for (const a of aliases as Alias[]) {
    const alias = ((a.alias as string | undefined) ?? '').trim();
    if (!alias) {
      problems.push('A correction has no heard-as text.');
      continue;
    }
    if (!ids.has(a.target_id as string)) problems.push(`"${alias}" points at a word that is not in the list.`);
    const key = alias.toLowerCase();
    if (seen.has(key)) problems.push(`"${alias}" is corrected twice.`);
    seen.add(key);
    if (a.scopes !== undefined && (!Array.isArray(a.scopes) || !a.scopes.length || !a.scopes.every((scope) => scope === 'body' || scope === 'speaker'))) {
      problems.push(`"${alias}" needs a scope of body, speaker, or both.`);
    }
    // Only a person can be a speaker.
    if (Array.isArray(a.scopes) && a.scopes.includes('speaker') && !personIds.has(a.target_id)) {
      problems.push(`"${alias}" corrects a speaker's name, so it has to point at a person.`);
    }
    // A correction that is some other entry's own spelling: bwat refuses to pick.
    const owner = canonicals.get(key);
    if (owner !== undefined && owner !== a.target_id) problems.push(`"${alias}" is already the spelling of another word.`);
  }
  return [...new Set(problems)];
}

/**
 * The next dated version string for a save: today's UTC date, counting up within a day
 * (`2026-10-01.1`, `.2`, ...) and starting again at `.1` the next day. It always differs
 * from `prev`, so every save has its own string a bot can report. Anything that is not
 * `<today>.<positive integer>` restarts at .1.
 */
export function nextVersionStamp(prev: string | null, now: Date): string {
  const d = now.toISOString().slice(0, 10);
  const rest = prev?.startsWith(`${d}.`) ? prev.slice(d.length + 1) : '';
  // BigInt: past 2^53 a Number + 1 rounds back to the same value.
  return /^[1-9]\d*$/.test(rest) ? `${d}.${BigInt(rest) + 1n}` : `${d}.1`;
}

interface Row {
  revision: number;
  payload: Record<string, unknown> | null;
  updated_at: Date;
  updated_by: string | null;
}

function viewOf(row: Row | undefined): DictionaryView {
  if (!row) return ABSENT;
  const set = isObject(row.payload);
  return {
    state: set ? 'set' : 'cleared',
    revision: row.revision,
    version: set && text(row.payload!.version) ? (row.payload!.version as string) : null,
    payload: set ? row.payload : null,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export async function readDictionary(db: Db): Promise<DictionaryView> {
  const { rows } = await db.query<Row>(`SELECT revision, payload, updated_at, updated_by FROM dictionary`);
  return viewOf(rows[0]);
}

type SaveResult = { saved: DictionaryView; before: DictionaryView } | { stale: true; currentRevision: number | null };

/**
 * A conditional save: refused unless the stored revision (null when absent) is the one
 * the editor read. The row is locked first; a first save has no row to lock, so two of
 * them race on the primary key and the loser is stale. `payload: null` clears it. The
 * dated version is stamped here from the stored one, whatever the browser sent.
 */
export async function saveDictionary(
  client: pg.ClientBase,
  personId: string,
  expectedRevision: number | null,
  payload: Record<string, unknown> | null,
  now: Date,
): Promise<SaveResult> {
  const { rows } = await client.query<Row>(`SELECT revision, payload, updated_at, updated_by FROM dictionary FOR UPDATE`);
  const before = viewOf(rows[0]);
  if (before.revision !== expectedRevision) return { stale: true, currentRevision: before.revision };
  const stamped = payload && { ...payload, version: nextVersionStamp(before.version, now) };
  const written = await client.query<Row>(
    `INSERT INTO dictionary (id, payload, revision, updated_by) VALUES (true, $1::jsonb, 1, $2)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, revision = dictionary.revision + 1,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE dictionary.revision = $3
     RETURNING revision, payload, updated_at, updated_by`,
    [JSON.stringify(stamped), personId, expectedRevision],
  );
  // A first save that lost the race to another first save updates nothing: stale.
  if (!written.rows[0]) return { stale: true, currentRevision: (await readDictionary(client)).revision };
  return { saved: viewOf(written.rows[0]), before };
}
