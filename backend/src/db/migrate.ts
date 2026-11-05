import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PLUGIN_NAME } from '../plugins/plugin.ts';
import { inTransaction } from './pool.ts';

/** backend/migrations: plain `NNNN_name.sql` files, applied once each in name order. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * A plugin's migrations sit in `<migrations>/plugins/<plugin>/`, numbered on their own: the
 * ledger records them as `plugins/<plugin>/NNNN_name.sql`, so a plugin's numbers never
 * collide with core's. They are applied whether or not the plugin is switched on (a schema
 * never depends on a switch).
 */
export const PLUGINS_SUBDIR = 'plugins';

const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * sha256 of the file with CRLF read as LF, so a Windows checkout and a Linux one
 * of the same migration agree.
 */
export function checksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Applies every not-yet-applied migration in `dir`, in name order, each in its own
 * transaction, recording it in public.schema_migrations with its checksum. Returns the
 * names it applied. Refuses to run at all if the history does not add up: an applied
 * file edited or missing, two files with one number, or a new file numbered before one
 * already applied. A migration is changed by adding a new one, never by rewriting history.
 * `namespace` ('' for core, `plugins/<name>` for a plugin) scopes all of it: the ledger keys
 * are `<namespace>/<file>`, and only this namespace's rows are checked against `dir`.
 */
export async function migrate(client: pg.ClientBase, dir = MIGRATIONS_DIR, namespace = ''): Promise<string[]> {
  const key = (file: string) => (namespace ? `${namespace}/${file}` : file);
  const ours = (name: string) => (namespace ? name.startsWith(`${namespace}/`) : !name.includes('/'));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const misnamed = files.find((f) => !NAME.test(f));
  if (misnamed) throw new Error(`migration ${misnamed} is not named NNNN_name.sql`);
  for (let i = 1; i < files.length; i++) {
    const number = files[i]!.slice(0, 4);
    if (number === files[i - 1]!.slice(0, 4)) {
      throw new Error(`migrations ${files[i - 1]} and ${files[i]} share the number ${number}`);
    }
  }

  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM public.schema_migrations`,
  );
  const applied = new Map(done.rows.filter((r) => ours(r.name)).map((r) => [r.name, r.checksum]));
  const present = new Set(files.map(key));
  const missing = [...applied.keys()].find((name) => !present.has(name));
  if (missing) throw new Error(`migration ${missing} was applied but its file is missing`);

  const pending: { name: string; sql: string; sum: string }[] = [];
  for (const file of files) {
    const name = key(file);
    const sql = await readFile(join(dir, file), 'utf8');
    const sum = checksum(sql);
    const recorded = applied.get(name);
    if (recorded === undefined) pending.push({ name, sql, sum });
    else if (recorded !== sum) throw new Error(`migration ${name} was edited after it was applied`);
  }
  const last = [...applied.keys()].reduce<string | undefined>((max, n) => (max === undefined || n > max ? n : max), undefined);
  const early = last && pending.find((p) => p.name < last);
  if (early) throw new Error(`migration ${early.name} is numbered before ${last}, which is already applied`);

  for (const { name, sql, sum } of pending) {
    try {
      await inTransaction(client, async () => {
        await client.query(sql);
        await client.query(`INSERT INTO public.schema_migrations (name, checksum) VALUES ($1, $2)`, [name, sum]);
      });
    } catch (err) {
      throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
    }
  }
  return pending.map((p) => p.name);
}

/**
 * Core's migrations, then each plugin's (`<dir>/plugins/<plugin>/`, plugins in name order),
 * each in its own namespace. Returns every ledger key it applied.
 */
export async function migrateAll(client: pg.ClientBase, dir = MIGRATIONS_DIR): Promise<string[]> {
  const applied = await migrate(client, dir);
  const pluginsDir = join(dir, PLUGINS_SUBDIR);
  const plugins = (await readdir(pluginsDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const plugin of plugins) {
    if (!PLUGIN_NAME.test(plugin)) throw new Error(`plugin migrations folder ${plugin} is not a plugin name`);
    applied.push(...(await migrate(client, join(pluginsDir, plugin), `${PLUGINS_SUBDIR}/${plugin}`)));
  }
  return applied;
}

// Any fixed number unique to this purpose.
const MIGRATE_LOCK_KEY = 45680001;

/**
 * Logs in with the owner role's URL, applies pending migrations and disconnects. An
 * advisory lock makes two runs started at once take turns: the second finds nothing
 * pending. A superuser is refused, since whatever it created it would own, and so is
 * any role but the database owner (the RDS master can act as the owner, but is not it).
 * `ssl` is dbTls's: TLS when BWAT_DB_SSLROOTCERT is set.
 */
export async function migrateDatabase(
  connectionString: string,
  dir = MIGRATIONS_DIR,
  { lockTimeoutMs = 60_000, ssl }: { lockTimeoutMs?: number; ssl?: pg.ClientConfig['ssl'] } = {},
): Promise<string[]> {
  const client = new pg.Client({ connectionString, ssl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const who = await client.query<{ role: string; rolsuper: boolean; owner: string }>(
      `SELECT r.rolname AS role, r.rolsuper, pg_get_userbyid(d.datdba) AS owner
         FROM pg_roles r, pg_database d
        WHERE r.rolname = current_user AND d.datname = current_database()`,
    );
    const { role, rolsuper, owner } = who.rows[0]!;
    if (rolsuper) throw new Error('migrations must run as the owner role, not a superuser');
    if (role !== owner) throw new Error(`migrations must run as the database owner ${owner}, not ${role}`);
    // An integer, so safe to inline. Bounds the wait for the lock and for table locks.
    await client.query(`SET lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    return await migrateAll(client, dir);
  } finally {
    await client.end(); // ending the session releases the lock
  }
}
