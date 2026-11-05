import type pg from 'pg';
import { SETTINGS } from './catalogue.ts';

type Db = pg.Pool | pg.ClientBase;

/**
 * One key as GET /console/settings shows it. `value: null` = unset, and then `default`
 * is what applies; `revision: null` = never saved.
 */
interface SettingView {
  value: unknown;
  default: string | number | boolean;
  revision: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Every catalogue key, always present, in catalogue order. A stored key the catalogue no longer has is left out. */
export async function readSettings(db: Db): Promise<Record<string, SettingView>> {
  const { rows } = await db.query<{ key: string; value: unknown; revision: number; updated_at: Date; updated_by: string | null }>(
    `SELECT key, value, revision, updated_at, updated_by FROM settings`,
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.fromEntries(
    SETTINGS.map(({ key, codeDefault }) => {
      const row = byKey.get(key);
      const view: SettingView = row
        ? { value: row.value, default: codeDefault, revision: row.revision, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by }
        : { value: null, default: codeDefault, revision: null, updatedAt: null, updatedBy: null };
      return [key, view];
    }),
  );
}

/**
 * One key's raw stored value: undefined when it was never saved, JSON null when it was
 * reset, never the catalogue default. Throws when the database does not answer. The
 * zoom track's readAutoJoinSwitch is `(key) => readStoredSetting(pool, key)`.
 */
export async function readStoredSetting(db: Db, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : undefined;
}

/** These keys' values, in key order; a key never saved or reset to its default is left out. */
export async function setValues(db: Db, keys: readonly string[]): Promise<{ key: string; value: unknown }[]> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1) AND value <> 'null'::jsonb ORDER BY key`,
    [keys],
  );
  return rows;
}

/** The company-wide counter the bots report back. */
export async function readSettingsVersion(db: Db): Promise<number> {
  const { rows } = await db.query<{ version: number }>(`SELECT version FROM settings_version`);
  return rows[0]!.version;
}

/**
 * Serialises every change the bots must pick up (settings, the dictionary and model keys) until the
 * transaction ends. A row lock on each key alone cannot: a key with no row has nothing
 * to lock, so two first saves of it would both pass the revision check. The singleton
 * version row always exists, so locking it first makes the second save wait, then read
 * the first one's row and be stale.
 */
export async function lockSettings(client: pg.ClientBase): Promise<void> {
  await client.query(`SELECT version FROM settings_version FOR UPDATE`);
}

/** +1, in the same transaction as any change the bots must pick up. */
export async function bumpSettingsVersion(client: pg.ClientBase): Promise<void> {
  await client.query(`UPDATE settings_version SET version = version + 1`);
}

/** The stored value, revision and time of these keys; a key never saved is absent. */
export async function storedSettings(
  client: Db,
  keys: string[],
): Promise<Map<string, { value: unknown; revision: number; updatedAt: Date }>> {
  const { rows } = await client.query<{ key: string; value: unknown; revision: number; updated_at: Date }>(
    `SELECT key, value, revision, updated_at FROM settings WHERE key = ANY($1)`,
    [keys],
  );
  return new Map(rows.map((r) => [r.key, { value: r.value, revision: r.revision, updatedAt: r.updated_at }]));
}

/** A save's changes: each key's new value and the revision it was read at (null: never saved). */
export type SettingChanges = Map<string, { value: unknown; expectedRevision: number | null }>;
/** One key a save wrote: its value and revision before (null: never saved) and after. */
export type WrittenSetting = { before: { value: unknown; revision: number | null }; after: { value: unknown; revision: number } };

/**
 * One save's writes, in the caller's transaction and under the settings lock: every key's
 * revision is checked before anything is written, and any mismatch writes nothing and answers
 * the revisions stored now. An unchanged value is not a change (JSON null equals no row): it is
 * not written. Answers what each written key held before and holds now, for its audit.
 */
export async function writeChanges(
  client: pg.ClientBase,
  personId: string,
  changes: SettingChanges,
): Promise<{ stale: Record<string, number | null> } | { written: Map<string, WrittenSetting> }> {
  await lockSettings(client);
  const keys = [...changes.keys()];
  const stored = await storedSettings(client, keys);
  const current = (key: string) => stored.get(key)?.revision ?? null;
  if (keys.some((key) => current(key) !== changes.get(key)!.expectedRevision)) {
    return { stale: Object.fromEntries(keys.map((key) => [key, current(key)])) };
  }
  const written = new Map<string, WrittenSetting>();
  for (const key of keys) {
    const before = stored.get(key)?.value ?? null;
    const { value } = changes.get(key)!;
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    written.set(key, { before: { value: before, revision: current(key) }, after: { value, revision: await writeSetting(client, personId, key, value) } });
  }
  return { written };
}

/**
 * Writes one key and returns its new revision: a new row is revision 1, an existing one
 * moves to the next. `null` is stored as JSON null (unset), never as a missing row. `personId`
 * null: written by bwat itself (a startup step), not by a member.
 */
export async function writeSetting(client: pg.ClientBase, personId: string | null, key: string, value: unknown): Promise<number> {
  // JSON text cast to jsonb: pg would send a JS null as SQL NULL, which the column refuses.
  const { rows } = await client.query<{ revision: number }>(
    `INSERT INTO settings (key, value, revision, updated_by, updated_at) VALUES ($1, $2::jsonb, 1, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = settings.revision + 1,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING revision`,
    [key, JSON.stringify(value), personId],
  );
  return rows[0]!.revision;
}
