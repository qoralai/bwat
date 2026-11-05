import { createHash } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { readableModelKeys } from '../model-keys.ts';
import type { SecretStore } from '../secrets/store.ts';
import { SERVED_KEYS } from '../settings/catalogue.ts';
import { readDictionary } from '../settings/dictionary.ts';
import { readSettingsVersion, setValues } from '../settings/store.ts';
import { requireCaller } from './bots.ts';

/**
 * The header a bot sends to say it keeps model keys in memory only. A bot that caches
 * the whole body to disk must not send it, and then gets no keys. `X-Bwat-Provider-Keys:
 * memory-only` (D143); Node lower-cases header names.
 */
const KEYS_HEADER = 'x-bwat-provider-keys';
const KEYS_MEMORY_ONLY = 'memory-only';

/**
 * The tag of a body: `prefix`, its settings version, and for a body that carries what a
 * version does not cover (model keys, verdicts) a digest of that. Every change a body
 * covers (a setting, the dictionary, a model key saved in the panel) bumps the version; a
 * key that changed without a bump (a stale aws read, an aws write whose commit failed, an
 * env key rotated across a restart) changes the digest. The digest is a sha256 prefix,
 * never the key, and is never logged.
 * `settings-r3`: the bot body's shape since per-participant audio is no longer a setting
 * (QOR-4760), so a tag from before it, whose body may still carry it, never answers 304.
 */
export function tagOf(prefix: string, settingsVersion: number, covered: unknown): string {
  if (covered === null) return `"${prefix}-${settingsVersion}"`;
  const digest = createHash('sha256').update(JSON.stringify(covered)).digest('hex').slice(0, 16);
  return `"${prefix}-${settingsVersion}-keys-${digest}"`;
}

/** Whether If-None-Match names this tag (a list, a weak tag or `*` included). */
export function matches(ifNoneMatch: string | undefined, tag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(',').some((t) => {
    const trimmed = t.trim();
    return trimmed === '*' || trimmed.replace(/^W\//, '') === tag;
  });
}

/**
 * GET /bot/settings: what every bot applies, read with its own bot token. The
 * dictionary, the served settings that hold a value (an unset key is left out, so the
 * bot uses its own default), the settings version the bot reports back once it has
 * applied them, and the model keys for a bot that asks for them in memory only
 * (`providerKeys`, `{}` for any other bot).
 *
 * Bots poll it, so it is conditional: the answer carries an ETag, and a bot that sends
 * it back as If-None-Match while nothing changed gets 304 after its token check and one
 * version read. The model keys are kept in process, and read again from the store once
 * the settings version moves (a key set or removed bumps it) or once they are
 * `keyRefreshMs` old (60 s), whichever comes first, so a key that
 * changed without a bump reaches the bots within that bound. For a bot that asks for keys
 * that happens before the 304 is decided. A keys read that failed is neither kept nor
 * tagged: that answer carries no ETag, so the bot's next poll is answered in full and
 * reads the store again. `clock`: tests only.
 */
export function botSettingsRoutes(
  app: FastifyInstance,
  { pool, secrets, keyRefreshMs, clock = Date.now }: { pool: pg.Pool; secrets: SecretStore; keyRefreshMs: number; clock?: () => number },
): void {
  let cachedKeys: { settingsVersion: number; readAt: number; keys: Record<string, string> } | null = null;

  /** The model keys for this version, and whether every one could be read. */
  const currentKeys = async (settingsVersion: number, log: FastifyBaseLogger) => {
    if (cachedKeys?.settingsVersion === settingsVersion && clock() - cachedKeys.readAt < keyRefreshMs) {
      return { keys: cachedKeys.keys, complete: true };
    }
    let complete = true;
    const readAt = clock();
    const keys = await readableModelKeys(secrets, (provider) => {
      complete = false;
      log.warn({ event: 'model_key.unreadable', provider }, 'model key unreadable');
    });
    cachedKeys = complete ? { settingsVersion, readAt, keys } : null;
    return { keys, complete };
  };

  app.get('/bot/settings', async (req, reply) => {
    const botId = await requireCaller(pool, 'bot', req, reply);
    if (!botId) return reply;
    // The version FIRST. Each read below is its own snapshot, so a save landing between
    // them would otherwise pair old values with the new version, and the bot would
    // report a version whose values it never received. This way round a save in
    // between can only under-report, and the next poll catches up.
    const settingsVersion = await readSettingsVersion(pool);
    const withKeys = req.headers[KEYS_HEADER] === KEYS_MEMORY_ONLY;
    const { keys, complete } = withKeys ? await currentKeys(settingsVersion, req.log) : { keys: null, complete: true };
    const tag = tagOf('settings-r3', settingsVersion, keys);
    reply.header('cache-control', 'no-store');
    // Only a complete answer may be "unchanged": a partial one never carries a tag, and
    // `If-None-Match: *` must not turn it into a 304 either.
    if (complete && matches(req.headers['if-none-match'], tag)) {
      reply.header('etag', tag);
      req.log.info({ event: 'bot.settings_unchanged', bot_id: botId, settings_version: settingsVersion }, 'bot settings unchanged');
      return reply.code(304).send();
    }

    const { state, revision, version, payload } = await readDictionary(pool);
    const rows = await setValues(pool, SERVED_KEYS);
    const body = {
      dictionary: { state, revision, version, payload },
      // An unset key is left out.
      settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
      settingsVersion,
      // Empty unless the bot keeps keys in memory only.
      providerKeys: keys ?? {},
    };
    if (complete) reply.header('etag', tag);
    req.log.info({ event: 'bot.settings_read', bot_id: botId, settings_version: settingsVersion }, 'bot read settings');
    return reply.send(body);
  });
}
