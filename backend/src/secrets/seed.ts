import { readFileSync, statSync, unlinkSync } from 'node:fs';
import type pg from 'pg';
import { audit } from '../audit.ts';
import { withTransaction } from '../db/pool.ts';
import { isObject } from '../http.ts';
import { bumpSettingsVersion, lockSettings } from '../settings/store.ts';
import { SecretUnreadable, type SecretStore } from './store.ts';

/**
 * Imports a JSON object of `{"<tier-2 name>": "<value>"}` (secret-names.ts) into the store.
 * `source`: a file's path, deleted after the import so the plaintext lives on disk no
 * longer than it, or `{ text }`, JSON that was never on disk (piped to `-`), so there is
 * nothing to delete. On POSIX (`posix`) a file readable by group or others is refused
 * before it is read. Everything is checked before anything is stored; a refused file is
 * kept, and no error quotes a value. A value already stored is kept unless `force`; one
 * already stored with the very value in the file is `matched`, and counts as seeded: an
 * earlier run that wrote it to aws and then failed in the database left its bump and
 * audit undone, and the retry does them. So whenever anything was stored or matched, the
 * version is bumped once (the bots pick the values up on their next settings read) and
 * one audit row names them, as `system`. When the file cannot be deleted afterwards it
 * throws, saying so, so the setup script stops and the operator removes it by hand.
 */
export async function seedSecrets(
  pool: pg.Pool,
  store: SecretStore,
  source: string | { text: string },
  {
    force = false,
    remove = unlinkSync,
    posix = process.platform !== 'win32',
  }: { force?: boolean; remove?: (path: string) => void; posix?: boolean } = {},
): Promise<{ stored: string[]; matched: string[]; kept: string[] }> {
  const path = typeof source === 'string' ? source : null;
  const what = path === null ? 'the input' : 'the file';
  if (path !== null && posix) {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) throw new Error(`seed-secrets: the file is readable by group or others (mode 0${mode.toString(8)}): chmod 600 it`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(path === null ? (source as { text: string }).text : readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`seed-secrets: ${what} is not JSON`);
  }
  if (!isObject(parsed)) throw new Error(`seed-secrets: ${what} must be a JSON object of secret name to value`);
  const entries = Object.entries(parsed);
  for (const [name, value] of entries) {
    if (!store.keeps(name)) throw new Error(`seed-secrets: not a secret this store keeps: ${name}`);
    if (typeof value !== 'string' || !value) throw new Error(`seed-secrets: ${name} has no value`);
  }
  // One change, under the settings lock: what is already stored is read under it, so a
  // value saved meanwhile is kept without `force`; on the local store the values and
  // their audit commit or roll back together. A store that cannot be asked throws
  // (SecretUnavailable) rather than act on an unknown.
  const result = await withTransaction(pool, async (client) => {
    await lockSettings(client);
    const stored: string[] = [];
    const matched: string[] = [];
    const kept: string[] = [];
    for (const [name, value] of entries) {
      const current = force ? null : await store.get(name, client).catch((err: unknown) => {
        // Stored, but not readable: set, and not the value in the file.
        if (err instanceof SecretUnreadable) return '';
        throw err;
      });
      if (current === null) stored.push(name);
      else (current === value ? matched : kept).push(name);
    }
    for (const name of stored) await store.put(name, parsed[name] as string, client);
    const seeded = [...stored, ...matched];
    if (seeded.length > 0) {
      await bumpSettingsVersion(client);
      await audit(client, { actor: null, action: 'secrets.seeded', target: 'secrets', before: null, after: { names: seeded } });
    }
    return { stored, matched, kept };
  });
  if (path === null) return result;
  try {
    remove(path);
  } catch {
    throw new Error(`seed-secrets: stored ${result.stored.join(', ') || 'nothing'}, but the file could not be deleted: delete it by hand`);
  }
  return result;
}
