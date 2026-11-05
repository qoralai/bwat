/**
 * `npm run seed-secrets -- <file|-> [--force]`: imports a JSON object of tier-2 secrets
 * (`{"provider.openai": "...", "zoom.webhook_secret": "..."}`, the names in src/secret-names.ts)
 * into the secret store BWAT_SECRET_STORE names (local: BWAT_ENC_KEY or
 * BWAT_ENC_KEY_FILE; aws: BWAT_SECRET_PREFIX), then deletes the file. `-` reads the JSON
 * from stdin instead (the installer pipes it in, so it is never on disk): no file to delete. A value already
 * stored is kept unless --force. Logs in as the runtime role (BWAT_DB_URL_FILE >
 * BWAT_DB_URL > aws `<prefix>BWAT_DB_URL`). Prints secret names, never a value; exits non-zero on any failure,
 * including a file it stored but could not delete.
 */
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { runtimePool } from '../src/db/pool.ts';
import { PLUGINS } from '../src/plugins/index.ts';
import { pluginSecretNames } from '../src/plugins/plugin.ts';
import { seedSecrets } from '../src/secrets/seed.ts';
import { secretStoreFromEnv } from '../src/secrets/store.ts';

const plural = (n: number) => `${n} secret${n === 1 ? '' : 's'}`;

try {
  const { values, positionals } = parseArgs({ options: { force: { type: 'boolean' } }, allowPositionals: true });
  const [path, ...extra] = positionals;
  if (!path || extra.length > 0) throw new Error('usage: npm run seed-secrets -- <file|-> [--force]');
  const warn = ({ name, winner }: { name: string; winner: string }) => console.warn(`warning: ${name} is set in more than one place; using ${winner}`);
  const env = await startupEnv(process.env, STARTUP_NAMES.seedSecrets, { warn });
  const pool = runtimePool(env, { max: 1 });
  try {
    const source = path === '-' ? { text: await text(process.stdin) } : path;
    const { stored, matched, kept } = await seedSecrets(pool, secretStoreFromEnv(env, pool, { pluginNames: pluginSecretNames(PLUGINS, { retired: true }) }), source, { force: values.force ?? false });
    const matchedNote = matched.length ? `; matched ${matched.length} already stored with this value: ${matched.join(', ')}` : '';
    const keptNote = kept.length ? `; kept ${kept.length} already stored (--force overwrites): ${kept.join(', ')}` : '';
    console.log(`seeded ${plural(stored.length)}${stored.length ? `: ${stored.join(', ')}` : ''}${matchedNote}${keptNote}${path === '-' ? '' : '; the file is deleted'}`);
  } finally {
    await pool.end();
  }
} catch (err) {
  console.error(`seed-secrets failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
