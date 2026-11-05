import { beforeEach, describe, expect, it } from 'vitest';
import { cardsModelFromEnv } from '../src/routes/cards-settings.ts';
import { awsSecretStore } from '../src/secrets/store.ts';
import { issueCardsCredential } from '../src/credentials.ts';
import { createPool } from '../src/db/pool.ts';
import { buildServer, start } from '../src/server.ts';
import { apiBase, bearer, PERSON, registerBot, signedIn, useApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { fakeOpenRouter } from './fake-openrouter.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';

// QOR-4678 (D179): the card writer's model address, model and key, for the card service only.
// QOR-4769: and Jev's settings, the ZDR verdicts the keys depend on, and Jev's key.

const OPENROUTER = 'sk-or-card-writer-0123456789-ORKY';
const OPENAI = 'sk-openai-card-writer-0123456789-OAKY';

const WRITER_MODEL = 'anthropic/claude-opus-5.5';
const JEV_MODEL = 'typesafe/jev-1.13';
/** OpenRouter as of writing: the writer has one ZDR endpoint of two, Jev's only endpoint is ZDR. */
const zdrFetch = () =>
  fakeOpenRouter(
    { [WRITER_MODEL]: ['Amazon Bedrock | w', 'Anthropic | w'], [JEV_MODEL]: ['TypeSafe | j'], 'other/model': ['Other | o', 'TypeSafe | j'] },
    ['Amazon Bedrock | w', 'TypeSafe | j'],
  ).fetch;
const DEFAULTS = { cards_granularity: 'balanced', jev_enabled: true, jev_model: JEV_MODEL, jev_threshold_pct: 65, jev_link_threshold_pct: 85, jev_deadline_s: 60 };

/** A secret store holding these provider keys, seeded before any request. */
function storeWith(keys: Record<string, string>, fake = new FakeSecretsManager()) {
  for (const [name, value] of Object.entries(keys)) fake.secrets.set(`bwat/test/${name}`, { value, scheduled: false });
  return awsSecretStore(fake, 'bwat/test/');
}

const events = (lines: string[], event: string) => lines.map((l) => JSON.parse(l)).filter((l) => l.event === event);

describeDb('GET /cards/settings (QOR-4678)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: signedIn,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER, 'provider.openai': OPENAI }),
    zdrFetch: zdrFetch(),
  });
  const get = async (headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url: '/cards/settings', headers: { ...bearer(await issueCardsCredential(t.pool)), ...headers } });
  /** Stores these settings as JSON text; null is "reset to default". */
  const store = (values: Record<string, string>) =>
    t.pool.query(
      `INSERT INTO settings (key, value, revision) SELECT k, v::jsonb, 1 FROM unnest($1::text[], $2::text[]) AS x(k, v)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = settings.revision + 1`,
      [Object.keys(values), Object.values(values)],
    );
  beforeEach(async () => {
    await store({ cards_granularity: 'null', jev_enabled: 'null', jev_model: 'null', jev_threshold_pct: 'null', jev_link_threshold_pct: 'null', jev_deadline_s: 'null' });
  });

  it('gives the card service the default OpenRouter address and model with the stored OpenRouter key, and Jev with its defaults', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      base_url: 'https://openrouter.ai/api/v1',
      model: WRITER_MODEL,
      api_key: OPENROUTER,
      settings: DEFAULTS,
      settingsVersion: expect.any(Number),
      zdr: { writer: true, jev: true },
      zdr_waived: false,
      jev_api_key: OPENROUTER,
    });
    expect(lines.join('\n')).not.toContain(OPENROUTER);
  });

  it('serves the stored card size over its default', async () => {
    await store({ cards_granularity: '"fewer"' });
    expect((await get()).json().settings).toEqual({ ...DEFAULTS, cards_granularity: 'fewer' });
  });

  it('serves the stored Jev settings over the defaults, under the settings version', async () => {
    await store({ jev_enabled: 'false', jev_threshold_pct: '80' });
    const { rows } = await t.pool.query<{ version: number }>(`SELECT version FROM settings_version`);
    const body = (await get()).json();
    expect(body.settings).toEqual({ ...DEFAULTS, jev_enabled: false, jev_threshold_pct: 80 });
    expect(body.settingsVersion).toBe(rows[0]!.version);
    // Jev is off: no verdict is looked up for it, and its key is not handed out.
    expect(body.zdr).toEqual({ writer: true, jev: false });
    expect(body.jev_api_key).toBeNull();
  });

  it("withholds Jev's key while not every endpoint of its model is ZDR, and logs that once", async () => {
    await store({ jev_model: '"other/model"' });
    const body = (await get()).json();
    expect(body.settings.jev_model).toBe('other/model');
    expect(body.zdr).toEqual({ writer: true, jev: false });
    expect(body.jev_api_key).toBeNull();
    expect(body.api_key).toBe(OPENROUTER);
    await get();
    expect(events(lines, 'cards_settings.zdr_refused')).toEqual([expect.objectContaining({ use: 'jev', model: 'other/model' })]);
  });

  it('answers 304 to its own ETag while nothing changed, and a new body once a setting does', async () => {
    const first = await get();
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"cards-r1-\d+-keys-[0-9a-f]{16}"$/);
    expect(first.headers['cache-control']).toBe('no-store');
    const again = await get({ 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    await store({ jev_threshold_pct: '70' });
    const changed = await get({ 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('answers 503 secret_unavailable while the key store cannot be read', async () => {
    const cards = await issueCardsCredential(t.pool);
    const fake = new FakeSecretsManager();
    fake.failWith = 'ServiceUnavailable';
    const down = buildServer({ pool: t.pool, secrets: storeWith({}, fake), zdrFetch: zdrFetch() });
    try {
      const res = await apiBase(down).inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'secret_unavailable' });
    } finally {
      await down.close();
    }
  });

  it('refuses (401) a person and a bot', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/cards/settings', headers: PERSON })).statusCode).toBe(401);
    const bot = await registerBot(t);
    expect((await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(bot.bot_token) })).statusCode).toBe(401);
  });
});

describeDb('GET /cards/settings with Jev off (QOR-4769)', () => {
  const lines: string[] = [];
  // Its own fake: the verdict cache of another app would hide a lookup.
  const openRouter = fakeOpenRouter({ [WRITER_MODEL]: ['Amazon Bedrock | w'], [JEV_MODEL]: ['TypeSafe | j'] }, ['Amazon Bedrock | w', 'TypeSafe | j']);
  const t = useApp({
    authenticatePerson: signedIn,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER }),
    zdrFetch: openRouter.fetch,
  });

  it("looks up no verdict for Jev's model and logs none for it", async () => {
    await t.pool.query(
      `INSERT INTO settings (key, value, revision) VALUES ('jev_enabled', 'false'::jsonb, 1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = settings.revision + 1`,
    );
    const res = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(await issueCardsCredential(t.pool)) });
    expect(res.json()).toMatchObject({ api_key: OPENROUTER, zdr: { writer: true, jev: false }, jev_api_key: null });
    expect(openRouter.calls).toContain(`https://openrouter.ai/api/v1/models/${WRITER_MODEL}/endpoints`);
    expect(openRouter.calls.filter((url) => url.includes(JEV_MODEL))).toEqual([]);
    const zdrLogs = [...events(lines, 'cards_settings.zdr_passed'), ...events(lines, 'cards_settings.zdr_refused')];
    expect(zdrLogs.map((l) => l.use)).toEqual(['writer']);
  });
});

describeDb('GET /cards/settings when the ZDR lookups fail (QOR-4769)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: signedIn,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER }),
    zdrFetch: (async () => new Response('down', { status: 503 })) as typeof fetch,
  });

  it('withholds both keys (fail closed) and logs each refusal once, never the key', async () => {
    const cards = await issueCardsCredential(t.pool);
    for (let i = 0; i < 2; i++) {
      const res = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
      expect(res.json()).toMatchObject({ api_key: null, zdr: { writer: false, jev: false }, jev_api_key: null });
    }
    expect(events(lines, 'cards_settings.zdr_refused').map((l) => [l.use, l.model])).toEqual([
      ['writer', WRITER_MODEL],
      ['jev', JEV_MODEL],
    ]);
    expect(lines.join('\n')).not.toContain(OPENROUTER);
  });
});

describeDb('GET /cards/settings with a model an admin saved', () => {
  const lines: string[] = [];
  // OpenRouter as the fake has it: other/model has a ZDR endpoint, plain/model none, and
  // gone/model cannot be looked up (its endpoints answer 404).
  const openRouter = fakeOpenRouter(
    { [WRITER_MODEL]: ['Amazon Bedrock | w'], [JEV_MODEL]: ['TypeSafe | j'], 'other/model': ['TypeSafe | j'], 'plain/model': ['Plain | p'] },
    ['Amazon Bedrock | w', 'TypeSafe | j'],
  );
  const t = useApp({
    authenticatePerson: signedIn,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER }),
    zdrFetch: openRouter.fetch,
  });
  const get = async () => (await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(await issueCardsCredential(t.pool)) })).json();
  const save = (value: object | null) =>
    t.pool.query(
      `INSERT INTO settings (key, value, revision) VALUES ('cards_model', $1::jsonb, 1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, revision = settings.revision + 1`,
      [JSON.stringify(value)],
    );
  const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

  it('serves the saved model over BWAT_CARDS_MODEL while it was saved for this address', async () => {
    await save({ model: 'other/model', base_url: OPENROUTER_URL });
    expect(await get()).toMatchObject({ model: 'other/model', api_key: OPENROUTER, zdr: { writer: true } });
  });

  it('serves the env model while the saved one was checked against another address', async () => {
    await save({ model: 'other/model', base_url: 'https://models.example.com/v1' });
    expect(await get()).toMatchObject({ model: WRITER_MODEL, api_key: OPENROUTER });
  });

  it('serves the env model once the saved one is reset', async () => {
    await save(null);
    expect((await get()).model).toBe(WRITER_MODEL);
  });

  it('gives the key to a model with no ZDR endpoint the admin saved past the warning, unrouted', async () => {
    await save({ model: 'plain/model', base_url: OPENROUTER_URL, no_zdr: true });
    expect(await get()).toMatchObject({ model: 'plain/model', api_key: OPENROUTER, zdr: { writer: false }, zdr_waived: true });
    expect(events(lines, 'cards_settings.zdr_waived')).toEqual([expect.objectContaining({ use: 'writer', model: 'plain/model' })]);
  });

  it('still withholds the key from a model with no ZDR endpoint nobody was warned about', async () => {
    await save({ model: 'plain/model', base_url: OPENROUTER_URL });
    expect(await get()).toMatchObject({ model: 'plain/model', api_key: null, zdr: { writer: false }, zdr_waived: false });
  });

  it('withholds the key while the lookup fails, even for a model saved past the warning', async () => {
    await save({ model: 'gone/model', base_url: OPENROUTER_URL, no_zdr: true });
    expect(await get()).toMatchObject({ model: 'gone/model', api_key: null, zdr: { writer: false }, zdr_waived: false });
    expect(lines.join('\n')).not.toContain(OPENROUTER);
  });
});

const openaiStore = () => storeWith({ 'provider.openai': OPENAI });

describeDb('GET /cards/settings with another model address (QOR-4678)', () => {
  const t = useApp({
    authenticatePerson: signedIn,
    cardsModel: cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: 'https://api.openai.com/v1', BWAT_CARDS_MODEL: 'gpt-test' }),
    secrets: openaiStore,
    zdrFetch: zdrFetch(),
  });

  it('sends no key to a plain-http address, even a known host', async () => {
    const cards = await issueCardsCredential(t.pool);
    const http = buildServer({
      pool: t.pool,
      cardsModel: cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: 'http://api.openai.com/v1' }),
      secrets: openaiStore(),
      zdrFetch: zdrFetch(),
    });
    try {
      const res = await apiBase(http).inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
      expect(res.json()).toMatchObject({ base_url: 'http://api.openai.com/v1', model: WRITER_MODEL, api_key: null });
    } finally {
      await http.close();
    }
  });

  it('picks the key by host: api.openai.com takes the OpenAI key, with no ZDR check for a host that is not OpenRouter', async () => {
    const cards = await issueCardsCredential(t.pool);
    const res = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
    expect(res.json()).toMatchObject({ base_url: 'https://api.openai.com/v1', model: 'gpt-test', api_key: OPENAI, zdr: { writer: true } });
  });

  it('gives Jev no key while none is stored for OpenRouter', async () => {
    const cards = await issueCardsCredential(t.pool);
    const res = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
    expect(res.json()).toMatchObject({ zdr: { jev: true }, jev_api_key: null });
  });
});

const CUSTOM = 'sk-custom-card-writer-0123456789-CUKY';

describeDb('GET /cards/settings with a custom model address (QOR-4910)', () => {
  const openRouter = fakeOpenRouter({}, []);
  const t = useApp({
    authenticatePerson: signedIn,
    cardsModel: cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: 'https://models.example.com/v1', BWAT_CARDS_MODEL: 'm-1' }),
    secrets: () => storeWith({ 'provider.openrouter': OPENROUTER, 'provider.openai': OPENAI, 'provider.custom': CUSTOM }),
    zdrFetch: openRouter.fetch,
  });

  it('gives any other https host the custom key, with no ZDR check for the writer', async () => {
    const cards = await issueCardsCredential(t.pool);
    const res = await t.app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
    expect(res.json()).toMatchObject({ base_url: 'https://models.example.com/v1', model: 'm-1', api_key: CUSTOM, zdr: { writer: true } });
    expect(openRouter.calls.filter((url) => url.includes('/models/m-1/'))).toEqual([]);
  });
});

describe('cardsModelFromEnv (QOR-4678)', () => {
  it('defaults to OpenRouter and the prototype writer model', () => {
    expect(cardsModelFromEnv({})).toEqual({ baseUrl: 'https://openrouter.ai/api/v1', model: WRITER_MODEL });
  });

  it('refuses a model address that is not a URL, at startup', () => {
    expect(() => cardsModelFromEnv({ BWAT_CARDS_MODEL_URL: 'openrouter.ai/api/v1' })).toThrow('BWAT_CARDS_MODEL_URL is not a URL');
  });
});

describeDb('GET /cards/settings on a started server (QOR-4678)', () => {
  const db = useTestDb();

  it('serves the model from BWAT_CARDS_MODEL_URL and BWAT_CARDS_MODEL', async () => {
    const pool = createPool(db.url('runtime'));
    const app = apiBase(
      await start(
        { BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_CARDS_MODEL_URL: 'https://models.example.com/v1', BWAT_CARDS_MODEL: 'm-1' },
        { zdrFetch: zdrFetch() },
      ),
    );
    try {
      const cards = await issueCardsCredential(pool);
      const res = await app.inject({ method: 'GET', url: '/cards/settings', headers: bearer(cards) });
      expect(res.json()).toMatchObject({ base_url: 'https://models.example.com/v1', model: 'm-1', api_key: null });
    } finally {
      await app.close();
      await pool.end();
    }
  });
});
