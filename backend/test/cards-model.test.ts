import { beforeEach, describe, expect, it } from 'vitest';
import { pricePerMillion } from '../src/cards-model.ts';
import type { CardsClient } from '../src/cards-client.ts';
import { issueCardsCredential } from '../src/credentials.ts';
import { cardsModelFromEnv } from '../src/routes/cards-settings.ts';
import { awsSecretStore } from '../src/secrets/store.ts';
import { bearer } from './app.ts';
import { asSuperuser, describeDb } from './db/harness.ts';
import { fakeOpenRouter } from './fake-openrouter.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';
import { ADMIN, ADMIN_ID, MEMBER, OWNER, useRoles } from './people.ts';

// The card writer's model, picked in the admin panel and checked before it is saved.

const OPENROUTER_KEY = 'sk-or-model-picker-0123456789-ORKY';
const CUSTOM_KEY = 'sk-custom-model-picker-0123456789-CUKY';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const CUSTOM_URL = 'https://models.example.com/v1';

const PINNED = ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6-astra', 'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra'];
/** OpenRouter's /models as the fake has it: per-token prices, as OpenRouter gives them. */
const LISTED = [
  { id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000004', completion: '0.00002' } },
  { id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000003', completion: '0.000015' } },
  { id: 'openai/gpt-6-astra', pricing: { prompt: '0.00000125', completion: '0.00001' } },
  { id: 'openai/gpt-6.1-sol', pricing: { prompt: '0.000002', completion: '0.000012' } },
  { id: 'openai/gpt-6.1-terra', pricing: { prompt: '0.000001', completion: '0.000005' } },
  { id: 'plain/model', pricing: { prompt: '0.0000001', completion: '0.0000002' } },
  { id: 'murky/model', pricing: { prompt: '0', completion: '0' } },
];

type Call = { url: string; method: string; auth: string | null; body: Record<string, unknown> | null };

/**
 * OpenRouter and a custom endpoint: each /models list, each chat/completions (answered
 * `chat`, 200 by default), and OpenRouter's ZDR lookups. plain/model has no ZDR endpoint;
 * murky/model cannot be looked up. Every call is recorded.
 */
function fakeModels() {
  const zdr = fakeOpenRouter(
    Object.fromEntries([...PINNED.map((id) => [id, [`Bedrock | ${id}`]]), ['plain/model', ['Plain | p']]]),
    PINNED.map((id) => `Bedrock | ${id}`),
  );
  const state = { calls: [] as Call[], chat: 200, listDown: false };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    state.calls.push({ url, method: init?.method ?? 'GET', auth, body });
    if (url === `${OPENROUTER_URL}/models`) return state.listDown ? new Response('down', { status: 503 }) : Response.json({ data: LISTED });
    if (url === `${CUSTOM_URL}/models`) {
      return auth === `Bearer ${CUSTOM_KEY}` ? Response.json({ data: [{ id: 'router-opus' }, { id: 'router-sonnet' }] }) : new Response('no', { status: 401 });
    }
    if (url.endsWith('/chat/completions')) return new Response('{}', { status: state.chat });
    return zdr.fetch(input);
  }) as typeof globalThis.fetch;
  return { fetch, state };
}

function storeWith(keys: Record<string, string>) {
  const fake = new FakeSecretsManager();
  for (const [name, value] of Object.entries(keys)) fake.secrets.set(`bwat/test/${name}`, { value, scheduled: false });
  return awsSecretStore(fake, 'bwat/test/');
}

/** A card service whose writer reports `paused`. */
const writerPaused = (paused: { model: string; error: string } | null) => ({ writerStatus: async () => ({ paused }) }) as unknown as CardsClient;

describeDb('/console/cards-model on OpenRouter', () => {
  const models = fakeModels();
  let paused: { model: string; error: string } | null = null;
  const t = useRoles({
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER_KEY }),
    zdrFetch: models.fetch,
    modelFetch: models.fetch,
    cards: { writerStatus: async () => ({ paused }) } as unknown as CardsClient,
  });
  const get = (headers = ADMIN) => t.app.inject({ method: 'GET', url: '/console/cards-model', headers });
  const put = (payload: object, headers = ADMIN) => t.app.inject({ method: 'PUT', url: '/console/cards-model', headers, payload });
  const revision = async () => (await get()).json().revision as number | null;
  const stored = async () => (await t.pool.query(`SELECT value FROM settings WHERE key = 'cards_model'`)).rows[0]?.value ?? null;
  const version = async () => (await t.pool.query<{ version: number }>(`SELECT version FROM settings_version`)).rows[0]!.version;
  const chats = () => models.state.calls.filter((c) => c.url.endsWith('/chat/completions'));
  beforeEach(async () => {
    models.state.calls.length = 0;
    models.state.chat = 200;
    models.state.listDown = false;
    paused = null;
    await asSuperuser((c) => c.query(`DELETE FROM bwat.settings WHERE key = 'cards_model'`), t.db.name);
  });

  it('is owner or admin only: 401 for nobody, 403 for a member', async () => {
    for (const send of [() => get({} as typeof ADMIN), () => put({ model: PINNED[1], expectedRevision: null }, {} as typeof ADMIN)]) {
      expect((await send()).statusCode).toBe(401);
    }
    expect((await get(MEMBER)).statusCode).toBe(403);
    expect((await put({ model: PINNED[1], expectedRevision: null }, MEMBER)).statusCode).toBe(403);
    expect(chats()).toEqual([]);
    expect((await get(OWNER)).statusCode).toBe(200);
    expect((await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null }, OWNER)).statusCode).toBe(200);
  });

  it('offers the pinned models, each the latest of its family, priced per million tokens', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      endpoint: 'openrouter',
      host: 'openrouter.ai',
      model: 'anthropic/claude-opus-5.5',
      default: 'anthropic/claude-opus-5.5',
      saved: false,
      elsewhere: null,
      revision: null,
      listed: true,
      paused: null,
      suggestions: [
        { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus (latest: 5.5)', price: '$4 / $20 per M tokens' },
        { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet (latest: 5.5)', price: '$3 / $15 per M tokens' },
        { id: 'openai/gpt-6-astra', label: 'GPT Astra (latest: 6)', price: '$1.25 / $10 per M tokens' },
        { id: 'openai/gpt-6.1-sol', label: 'GPT Sol (latest: 6.1)', price: '$2 / $12 per M tokens' },
        { id: 'openai/gpt-6.1-terra', label: 'GPT Terra (latest: 6.1)', price: '$1 / $5 per M tokens' },
      ],
    });
  });

  it('offers the names without prices while OpenRouter cannot be read', async () => {
    models.state.listDown = true;
    const body = (await get()).json();
    expect(body.listed).toBe(false);
    expect(body.suggestions.map((s: { price: unknown }) => s.price)).toEqual([null, null, null, null, null]);
  });

  it('saves a listed model after one tiny test call routed to ZDR endpoints, and the writer is served it', async () => {
    const before = await version();
    const res = await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', saved: true, revision: 1 });
    expect(await stored()).toEqual({ model: 'anthropic/claude-sonnet-5.5', base_url: OPENROUTER_URL });
    expect(chats()).toEqual([
      {
        url: `${OPENROUTER_URL}/chat/completions`,
        method: 'POST',
        auth: `Bearer ${OPENROUTER_KEY}`,
        body: { model: 'anthropic/claude-sonnet-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'Say OK.' }], provider: { zdr: true } },
      },
    ]);
    expect(await version()).toBe(before + 1);
    // The list the check read answers the save too: one read of it.
    expect(models.state.calls.filter((c) => c.url === `${OPENROUTER_URL}/models`)).toHaveLength(1);
    const { rows } = await t.pool.query(`SELECT actor_id AS actor, action, target_type AS target FROM audit WHERE target_type = 'settings:cards_model' AND actor_id = $1`, [ADMIN_ID]);
    expect(rows).toEqual([{ actor: ADMIN_ID, action: 'settings.updated', target: 'settings:cards_model' }]);
    const served = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(await issueCardsCredential(t.pool)) });
    expect(served.json().model).toBe('anthropic/claude-sonnet-5.5');
  });

  it('refuses a model OpenRouter does not list, with no test call', async () => {
    const res = await put({ model: 'nobody/model', expectedRevision: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'model_refused', message: 'OpenRouter does not offer nobody/model. Check the model ID. Nothing was saved.' });
    expect(chats()).toEqual([]);
    expect(await stored()).toBeNull();
  });

  it('refuses a model whose test call fails', async () => {
    models.state.chat = 404;
    const res = await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'model_refused', message: 'A test call to anthropic/claude-sonnet-5.5 failed (404). Nothing was saved.' });
    expect(await stored()).toBeNull();
  });

  it('refuses while the list cannot be read', async () => {
    models.state.listDown = true;
    const res = await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null });
    expect(res.json()).toEqual({ error: 'model_refused', message: "Couldn't reach openrouter.ai to check the model. Nothing was saved. Try again shortly." });
  });

  it('warns before saving a model with no ZDR endpoint, and saves it only once the admin accepts', async () => {
    const warned = await put({ model: 'plain/model', expectedRevision: null });
    expect(warned.statusCode).toBe(409);
    expect(warned.json().error).toBe('no_zdr');
    expect(warned.json().message).toMatch(/plain\/model.*kept, or used to train.*Zoom/s);
    expect(chats()).toEqual([]);
    expect(await stored()).toBeNull();

    const accepted = await put({ model: 'plain/model', expectedRevision: null, acceptNoZdr: true });
    expect(accepted.statusCode).toBe(200);
    expect(await stored()).toEqual({ model: 'plain/model', base_url: OPENROUTER_URL, no_zdr: true });
    expect(chats()[0]!.body).not.toHaveProperty('provider');

    // The same choice again is no change: no new revision.
    const again = await put({ model: 'plain/model', expectedRevision: 1, acceptNoZdr: true });
    expect(again.json().revision).toBe(1);
  });

  it('refuses while OpenRouter cannot say whether the model keeps data', async () => {
    const res = await put({ model: 'murky/model', expectedRevision: null, acceptNoZdr: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe("Couldn't check with OpenRouter how murky/model handles meeting text. Nothing was saved. Try again shortly.");
    expect(chats()).toEqual([]);
  });

  it('refuses a model id that is not one line of printable text', async () => {
    for (const model of ['', ' ', 'a b', 'x'.repeat(201), 42]) {
      const res = await put({ model, expectedRevision: null });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_model' });
    }
  });

  it('refuses a save over a newer one (409 stale)', async () => {
    await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null });
    const res = await put({ model: 'openai/gpt-6.1-sol', expectedRevision: null });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale', currentRevisions: { cards_model: 1 } });
  });

  it('moves the settings version on a save of the same model, so a paused writer tries it again', async () => {
    await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null });
    const before = await version();
    expect((await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: await revision() })).statusCode).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  it("shows the writer's pause while it is for the model in use, and none once a save ends it", async () => {
    paused = { model: 'anthropic/claude-opus-5.5', error: 'not found (404)' };
    expect((await get()).json().paused).toEqual(paused);
    expect((await put({ model: 'anthropic/claude-opus-5.5', expectedRevision: null })).json().paused).toBeNull();
    paused = { model: 'openai/gpt-6.1-sol', error: 'not found (404)' };
    expect((await get()).json().paused).toBeNull();
  });

  it('says when the saved model was picked for another endpoint, and uses the default', async () => {
    await t.pool.query(`INSERT INTO settings (key, value, revision) VALUES ('cards_model', $1::jsonb, 1)`, [
      JSON.stringify({ model: 'router-opus', base_url: CUSTOM_URL }),
    ]);
    expect((await get()).json()).toMatchObject({ model: 'anthropic/claude-opus-5.5', saved: false, elsewhere: { model: 'router-opus', host: 'models.example.com' }, revision: 1 });
  });

  it('is not a setting the Settings page can save', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/console/settings',
      headers: ADMIN,
      payload: { changes: { cards_model: { value: { model: 'x/y', base_url: OPENROUTER_URL }, expectedRevision: null } } },
    });
    expect(res.statusCode).toBe(400);
    expect(await stored()).toBeNull();
  });
});

describeDb('/console/cards-model with no OpenRouter key', () => {
  const models = fakeModels();
  const t = useRoles({ secrets: () => storeWith({}), zdrFetch: models.fetch, modelFetch: models.fetch, cards: writerPaused(null) });

  it('refuses, naming the key to save first', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/console/cards-model', headers: ADMIN, payload: { model: 'anthropic/claude-sonnet-5.5', expectedRevision: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Save the OpenRouter key under Providers first. Nothing was saved.');
  });
});

describeDb('/console/cards-model on api.openai.com with no key', () => {
  const models = fakeModels();
  const t = useRoles({
    cardsModel: cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: 'https://api.openai.com/v1', BWAT_CARDS_MODEL: 'gpt-test' }),
    secrets: () => storeWith({}),
    zdrFetch: models.fetch,
    modelFetch: models.fetch,
  });

  it('names the OpenAI key, as Providers does', async () => {
    const res = await t.app.inject({ method: 'PUT', url: '/console/cards-model', headers: ADMIN, payload: { model: 'gpt-test', expectedRevision: null } });
    expect(res.json().message).toBe('Save the OpenAI key under Providers first. Nothing was saved.');
  });
});

describeDb('/console/cards-model on a custom endpoint', () => {
  const models = fakeModels();
  const t = useRoles({
    cardsModel: cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: CUSTOM_URL, BWAT_CARDS_MODEL: 'router-opus' }),
    secrets: () => storeWith({ 'provider.custom': CUSTOM_KEY, 'provider.openrouter': OPENROUTER_KEY }),
    zdrFetch: models.fetch,
    modelFetch: models.fetch,
  });
  const put = (payload: object) => t.app.inject({ method: 'PUT', url: '/console/cards-model', headers: ADMIN, payload });

  it("offers the endpoint's own models, unpriced", async () => {
    expect((await t.app.inject({ method: 'GET', url: '/console/cards-model', headers: ADMIN })).json()).toMatchObject({
      endpoint: 'custom',
      host: 'models.example.com',
      model: 'router-opus',
      listed: true,
      paused: null,
      suggestions: [
        { id: 'router-opus', label: 'router-opus', price: null },
        { id: 'router-sonnet', label: 'router-sonnet', price: null },
      ],
    });
  });

  it('checks a model against that list and with one test call under the custom key, with no ZDR lookup or routing', async () => {
    expect((await put({ model: 'anthropic/claude-sonnet-5.5', expectedRevision: null })).json()).toEqual({
      error: 'model_refused',
      message: 'The model endpoint does not offer anthropic/claude-sonnet-5.5. Check the model ID. Nothing was saved.',
    });
    models.state.calls.length = 0;
    expect((await put({ model: 'router-sonnet', expectedRevision: null })).statusCode).toBe(200);
    const chat = models.state.calls.find((c) => c.url === `${CUSTOM_URL}/chat/completions`)!;
    expect(chat.auth).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(chat.body).not.toHaveProperty('provider');
    expect(models.state.calls.some((c) => c.url.includes('openrouter.ai'))).toBe(false);
  });
});

describe('pricePerMillion', () => {
  it('reads per-token prices as dollars per million tokens, and none when either is missing or not a price', () => {
    expect(pricePerMillion({ prompt: '0.000004', completion: '0.00002' })).toBe('$4 / $20 per M tokens');
    expect(pricePerMillion({ prompt: '0.00000015', completion: '0.0000006' })).toBe('$0.15 / $0.6 per M tokens');
    expect(pricePerMillion({ prompt: '0', completion: '0' })).toBe('$0 / $0 per M tokens');
    expect(pricePerMillion({ prompt: '-1', completion: '-1' })).toBeNull();
    expect(pricePerMillion({ prompt: '0.000004' })).toBeNull();
    expect(pricePerMillion(undefined)).toBeNull();
  });
});
