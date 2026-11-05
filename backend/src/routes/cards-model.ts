import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';
import { audit } from '../audit.ts';
import type { CardsClient } from '../cards-client.ts';
import {
  CARDS_MODEL_KEY,
  effectiveCardsModel,
  listModels,
  pricePerMillion,
  isSaved,
  SUGGESTED,
  testCall,
  type ListedModel,
  type SavedCardsModel,
} from '../cards-model.ts';
import { isObject, isRevision } from '../http.ts';
import { asAdminWrite } from '../members.ts';
import { secretName, type Provider } from '../model-keys.ts';
import { requireAdmin, requireOnboardedPerson, type AuthenticatePerson } from '../people-auth.ts';
import type { SecretStore } from '../secrets/store.ts';
import { bumpSettingsVersion, storedSettings, writeChanges } from '../settings/store.ts';
import type { ZdrLookup } from '../zdr.ts';
import { keyProviderFor, type CardsModel } from './cards-settings.ts';
import { answeredStoreError } from './secret-change.ts';

/** Each key as Providers names it. */
const KEY_NAMES: Partial<Record<Provider, string>> = { openrouter: 'OpenRouter', openai: 'OpenAI', custom: 'Custom endpoint' };

// One line of printable ASCII: a pasted space or line break is caught here.
const MODEL_ID = /^[\x21-\x7E]{1,200}$/;

const WARNING = (model: string) =>
  `No provider of ${model} on OpenRouter promises to keep no data. Meeting text sent to it could be kept, or used to train ` +
  "models, by that provider. That goes against the spirit of Zoom's terms for meeting content. Save it only if you accept that.";

/**
 * The card writer's model, for owners and admins. GET: the model in use, the
 * suggestions (on OpenRouter the pinned ones priced from its public list; on any other
 * address that endpoint's own list, unpriced), a choice saved for another address, and
 * the writer's pause when it is for the model in use. PUT: checks the model before it is
 * saved, and refuses with a plain message: the endpoint must list it, and one tiny call
 * with the address's key must answer. On OpenRouter a model with no zero-data-retention
 * endpoint is saved only once the admin accepts the warning (409 no_zdr first). The
 * writer reads the change on its next settings read; no restart.
 */
export function cardsModelRoutes(
  app: FastifyInstance,
  {
    pool,
    authenticatePerson,
    secrets,
    cardsModel,
    zdr,
    fetch,
    cards,
  }: {
    pool: pg.Pool;
    authenticatePerson: AuthenticatePerson;
    secrets: SecretStore;
    cardsModel: CardsModel;
    zdr: ZdrLookup;
    fetch: typeof globalThis.fetch;
    cards: CardsClient | undefined;
  },
): void {
  const { baseUrl } = cardsModel;
  const url = new URL(baseUrl);
  const onOpenRouter = url.hostname === 'openrouter.ai';
  const provider = keyProviderFor(url);
  const keyName = provider && KEY_NAMES[provider];
  const where = onOpenRouter ? 'OpenRouter' : 'The model endpoint';

  const readKey = async () => (provider ? secrets.get(secretName(provider)) : null);

  const paused = async (log: FastifyBaseLogger, model: string) => {
    try {
      const status = await cards?.writerStatus?.();
      return status?.paused?.model === model ? status.paused : null;
    } catch {
      log.warn({ event: 'cards_model.writer_status_unavailable' }, 'card writer status unavailable');
      return null;
    }
  };

  /**
   * The page's read. After a save, `checked` is the list its check read, so it is not read
   * twice, and there is no pause to show: the save moved the settings version, which ends it.
   */
  const view = async (log: FastifyBaseLogger, checked?: ListedModel[]) => {
    // The value and its revision in one read, so a save in between cannot pair one with the other.
    // OpenRouter's list is public; another endpoint's needs its key. An unreadable key lists nothing.
    const [rows, key] = await Promise.all([
      storedSettings(pool, [CARDS_MODEL_KEY]),
      onOpenRouter || checked ? null : readKey().catch(() => null),
    ]);
    const row = rows.get(CARDS_MODEL_KEY);
    const { model, chosen, elsewhere } = effectiveCardsModel(isSaved(row?.value) ? row.value : null, baseUrl, cardsModel.model);
    const [listed, pause] = await Promise.all([checked ?? listModels(fetch, baseUrl, key), checked ? null : paused(log, model)]);
    const suggestions = onOpenRouter
      ? SUGGESTED.map(([id, label]) => ({ id, label, price: pricePerMillion(listed?.find((m) => m.id === id)?.pricing) }))
      : (listed ?? []).map(({ id }) => ({ id, label: id, price: null }));
    return {
      endpoint: onOpenRouter ? 'openrouter' : 'custom',
      host: url.host,
      model,
      default: cardsModel.model,
      saved: chosen !== null,
      elsewhere: elsewhere && { model: elsewhere.model, host: new URL(elsewhere.base_url).host },
      revision: row?.revision ?? null,
      listed: listed !== null,
      paused: pause,
      suggestions,
    };
  };

  app.register(async (panel) => {
    panel.addHook('preHandler', requireOnboardedPerson(pool, authenticatePerson));

    panel.get('/console/cards-model', async (req, reply) => {
      if (!(await requireAdmin(pool, req, reply))) return reply;
      return view(req.log);
    });

    panel.put('/console/cards-model', async (req, reply) => {
      const admin = await requireAdmin(pool, req, reply);
      if (!admin) return reply;
      const body = isObject(req.body) ? req.body : {};
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!MODEL_ID.test(model) || !isRevision(body.expectedRevision)) return reply.code(400).send({ error: 'invalid_model' });
      const refuse = (message: string) => reply.code(400).send({ error: 'model_refused', message });

      // The checks call out, so they run before the settings transaction, never inside it.
      let key: string | null;
      try {
        key = await readKey();
      } catch (err) {
        if (await answeredStoreError(reply, err)) return reply;
        throw err;
      }
      // The writer is served this address's key, and the test call needs it: a key is required.
      if (provider && key === null) return refuse(`Save the ${keyName} key under Providers first. Nothing was saved.`);
      const listed = await listModels(fetch, baseUrl, onOpenRouter ? null : key);
      if (listed === null) return refuse(`Couldn't reach ${url.host} to check the model. Nothing was saved. Try again shortly.`);
      if (!listed.some((m) => m.id === model)) return refuse(`${where} does not offer ${model}. Check the model ID. Nothing was saved.`);
      const verdict = onOpenRouter ? await zdr(model) : null;
      if (verdict && !verdict.decided) {
        return refuse(`Couldn't check with OpenRouter how ${model} handles meeting text. Nothing was saved. Try again shortly.`);
      }
      const noZdr = verdict !== null && !verdict.any;
      if (noZdr && body.acceptNoZdr !== true) return reply.code(409).send({ error: 'no_zdr', message: WARNING(model) });
      const failed = await testCall(fetch, { baseUrl, key, model, zdr: verdict?.any === true });
      if (failed) return refuse(`A test call to ${model} failed (${failed}). Nothing was saved.`);

      // In jsonb's key order (shorter keys first), so a save of the same choice compares unchanged.
      const value: SavedCardsModel = { model, ...(noZdr && { no_zdr: true as const }), base_url: baseUrl };
      const result = await asAdminWrite(pool, admin.id, async (client) => {
        const saved = await writeChanges(client, admin.id, new Map([[CARDS_MODEL_KEY, { value, expectedRevision: body.expectedRevision as number | null }]]));
        if ('stale' in saved) return saved;
        const written = saved.written.get(CARDS_MODEL_KEY);
        if (written) {
          await audit(client, { actor: admin.id, action: 'settings.updated', target: `settings:${CARDS_MODEL_KEY}`, before: written.before, after: written.after });
        }
        // Even unchanged: a writer paused on this model tries it again on a new settings version.
        await bumpSettingsVersion(client);
        return { changed: written !== undefined };
      });
      if (result === 'forbidden') return reply.code(403).send({ error: 'forbidden' });
      if ('stale' in result) return reply.code(409).send({ error: 'stale', currentRevisions: result.stale });
      req.log.info({ event: 'cards_model.saved', model, no_zdr: noZdr, changed: result.changed }, 'card writer model saved');
      return view(req.log, listed);
    });
  });
}
