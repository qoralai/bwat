import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { CARDS_MODEL_KEY, effectiveCardsModel, isSaved } from '../cards-model.ts';
import { secretName, type Provider } from '../model-keys.ts';
import { SecretUnavailable, SecretUnreadable, type SecretStore } from '../secrets/store.ts';
import { CARDS_KEYS, settingDef } from '../settings/catalogue.ts';
import { readSettingsVersion, setValues } from '../settings/store.ts';
import type { ZdrLookup } from '../zdr.ts';
import { matches, tagOf } from './bot-settings.ts';
import { requireCaller } from './bots.ts';

/** The card writer's model (D179): an OpenAI-compatible address and a model id. */
export interface CardsModel {
  baseUrl: string;
  model: string;
}

/** BWAT_CARDS_MODEL_URL and BWAT_CARDS_MODEL, defaulting to OpenRouter and the prototype writer's model. */
export function cardsModelFromEnv(env: NodeJS.ProcessEnv): CardsModel {
  const baseUrl = env.BWAT_CARDS_MODEL_URL || 'https://openrouter.ai/api/v1';
  if (!URL.canParse(baseUrl)) throw new Error('BWAT_CARDS_MODEL_URL is not a URL');
  return { baseUrl, model: env.BWAT_CARDS_MODEL || 'anthropic/claude-opus-5.5' };
}

/** The panel-entered key each model host takes; any other host gets the custom key (QOR-4910). */
const KEY_FOR_HOST = new Map<string, Provider>([
  ['openrouter.ai', 'openrouter'],
  ['api.openai.com', 'openai'],
]);

/** The key a model address is given: none for a plain-http one (a compose stub needs none). */
export const keyProviderFor = (url: URL): Provider | undefined =>
  url.protocol === 'https:' ? (KEY_FOR_HOST.get(url.host) ?? 'custom') : undefined;

/** The card writer's settings as served (QOR-4769): always the effective value, stored or default. */
interface CardsSettings {
  cards_granularity: string;
  jev_enabled: boolean;
  jev_model: string;
  jev_threshold_pct: number;
  jev_link_threshold_pct: number;
  jev_deadline_s: number;
}

type ZdrUse = 'writer' | 'jev';

/**
 * GET /cards/settings (QOR-4678, D179): the card writer's model address, model and key,
 * for the card service's credential only. The key is the stored provider key (or its env
 * fallback) for the address's host, the custom key for any other host (QOR-4910), null for
 * a plain-http address; it is never logged.
 *
 * QOR-4769: also Jev's settings (each its effective value), the settings version, the ZDR
 * verdicts and Jev's key. `zdr.writer`: the writer's address is not OpenRouter, or at least
 * one of its model's endpoints is on OpenRouter's ZDR list (the writer asks for ZDR
 * routing). `zdr.jev`: every endpoint of Jev's model is (the Decisions API is not
 * documented to honour that routing); false while Jev is off, when it is not looked up. A failed lookup fails its verdict. A key goes out
 * only for a model that passes: `api_key` is null while `zdr.writer` is false, and
 * `jev_api_key` (the OpenRouter key) is null unless Jev is on and `zdr.jev` holds. A
 * verdict that changes is logged once.
 *
 * `model` is the one an admin saved for this address, else BWAT_CARDS_MODEL. One
 * saved past the warning that it has no ZDR endpoint gets its key with `zdr_waived` true,
 * and the writer sends to it without ZDR routing; only once OpenRouter has said so, never
 * on a failed lookup.
 *
 * Polled, so conditional like /bot/settings: the ETag covers the settings version and a
 * digest of the whole body (verdicts and keys change without a version bump), and a
 * matching If-None-Match answers 304.
 */
export function cardsSettingsRoutes(
  app: FastifyInstance,
  { pool, secrets, cardsModel, zdr }: { pool: pg.Pool; secrets: SecretStore; cardsModel: CardsModel; zdr: ZdrLookup },
): void {
  const lastVerdict = new Map<ZdrUse, 'passed' | 'waived' | 'refused'>();
  const logVerdict = (log: FastifyBaseLogger, use: ZdrUse, model: string, verdict: 'passed' | 'waived' | 'refused') => {
    if (lastVerdict.get(use) === verdict) return;
    lastVerdict.set(use, verdict);
    if (verdict === 'passed') log.info({ event: 'cards_settings.zdr_passed', use, model }, 'model passes the ZDR check');
    else if (verdict === 'waived') log.warn({ event: 'cards_settings.zdr_waived', use, model }, 'model has no ZDR endpoint: an admin saved it past the warning');
    else log.warn({ event: 'cards_settings.zdr_refused', use, model }, 'model fails the ZDR check: its key is withheld');
  };

  app.get('/cards/settings', async (req, reply) => {
    if (!(await requireCaller(pool, 'cards', req, reply))) return reply;
    // The version first, as on /bot/settings: a save in between can only under-report.
    const settingsVersion = await readSettingsVersion(pool);
    const stored = new Map((await setValues(pool, [...CARDS_KEYS, CARDS_MODEL_KEY])).map((r) => [r.key, r.value]));
    const settings = Object.fromEntries(CARDS_KEYS.map((k) => [k, stored.has(k) ? stored.get(k) : settingDef(k)!.codeDefault])) as unknown as CardsSettings;

    const url = new URL(cardsModel.baseUrl);
    const saved = stored.get(CARDS_MODEL_KEY);
    const { model, chosen } = effectiveCardsModel(isSaved(saved) ? saved : null, cardsModel.baseUrl, cardsModel.model);
    // Jev off: its model is not looked up, its verdict is false and nothing is logged for it (QOR-4769).
    const jevLookup = settings.jev_enabled ? zdr(settings.jev_model) : null;
    const [writer, jev] = await Promise.all([url.hostname === 'openrouter.ai' ? zdr(model) : null, jevLookup]);
    const verdicts = { writer: writer ? writer.any : true, jev: jev ? jev.all : false };
    // Saved past the no-ZDR warning: the key goes out once OpenRouter has answered.
    const waived = !verdicts.writer && writer !== null && writer.decided && chosen?.no_zdr === true;
    const writerKeyed = verdicts.writer || waived;
    if (writer) logVerdict(req.log, 'writer', model, verdicts.writer ? 'passed' : waived ? 'waived' : 'refused');
    if (jev) logVerdict(req.log, 'jev', settings.jev_model, verdicts.jev ? 'passed' : 'refused');

    const provider = keyProviderFor(url);
    let apiKey: string | null = null;
    let jevKey: string | null = null;
    try {
      if (provider && writerKeyed) apiKey = await secrets.get(secretName(provider));
      if (settings.jev_enabled && verdicts.jev) jevKey = await secrets.get(secretName('openrouter'));
    } catch (err) {
      if (!(err instanceof SecretUnavailable || err instanceof SecretUnreadable)) throw err;
      // As on the other routes that read a key: the card service retries.
      req.log.warn({ event: 'cards.secret_unavailable', provider }, 'card writer key unreadable');
      return reply.code(503).send({ error: 'secret_unavailable' });
    }
    const body = {
      base_url: cardsModel.baseUrl,
      model,
      api_key: apiKey,
      settings,
      settingsVersion,
      zdr: verdicts,
      // An admin saved this model past the no-ZDR warning: the writer sends without ZDR routing.
      zdr_waived: waived,
      jev_api_key: jevKey,
    };
    const tag = tagOf('cards-r1', settingsVersion, body);
    reply.header('cache-control', 'no-store');
    reply.header('etag', tag);
    if (matches(req.headers['if-none-match'], tag)) {
      req.log.info({ event: 'cards.settings_unchanged', settings_version: settingsVersion }, 'card service settings unchanged');
      return reply.code(304).send();
    }
    req.log.info({ event: 'cards.settings_read', provider: provider ?? null, settings_version: settingsVersion }, 'card service read its settings');
    return body;
  });
}
