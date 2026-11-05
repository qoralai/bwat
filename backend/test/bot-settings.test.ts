import { expect, it } from 'vitest';
import { MODEL_KEY_ENV } from '../src/model-keys.ts';
import { awsSecretStore, withEnvFallback } from '../src/secrets/store.ts';
import { buildServer } from '../src/server.ts';
import { apiBase, bearer, registerBot } from './app.ts';
import { asSuperuser, describeDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';
import { ADMIN, MEMBER, useRoles } from './people.ts';
import { WORDS } from './words.ts';

const KEY = 'sk-openai-0123456789-abcdefghij-KEY1';
const ENV_KEY = 'csk-from-env-0123456789-abcdefgh-ENV2';
const NEW_KEY = 'sk-openai-0123456789-abcdefghij-KEY2';

describeDb('GET /bot/settings (QOR-4578)', () => {
  const lines: string[] = [];
  const fake = new FakeSecretsManager();
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, { CEREBRAS_API_KEY: ENV_KEY }),
  });
  const get = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/bot/settings', headers });

  it('answers 401 without a bot token, and 409 to a fleet credential that has not registered a bot', async () => {
    expect((await get({})).statusCode).toBe(401);
    expect((await get(MEMBER)).statusCode).toBe(401);
    const { issueFleetCredential } = await import('../src/credentials.ts');
    const fleet = await issueFleetCredential(t.pool);
    const res = await get(bearer(fleet));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'unregistered_bot' });
  });

  it('serves the dictionary, the served settings that hold a value, and the settings version, with no keys unasked', async () => {
    await t.app.inject({ method: 'PUT', url: '/console/corrections', headers: MEMBER, payload: { expectedRevision: null, payload: WORDS } });
    const save = (section: string, changes: object) =>
      t.app.inject({ method: 'PUT', url: `/console/settings/${section}`, headers: ADMIN, payload: { changes } });
    await save('joining', {
      display_name: { value: 'Scribe', expectedRevision: null },
      auto_join_enabled: { value: false, expectedRevision: null },
      idle_leave_min: { value: 7, expectedRevision: null },
    });
    await save('joining', { idle_leave_min: { value: null, expectedRevision: 1 } });
    await save('retention', { transcript_retention_days: { value: 30, expectedRevision: null } });
    await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });

    const { bot_token } = await registerBot(t);
    const res = await get(bearer(bot_token));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(body.settings).toEqual({ display_name: 'Scribe' });
    // 1 dictionary save + 3 settings saves that changed something + 1 model key.
    expect(body.settingsVersion).toBe(5);
    expect(body.dictionary).toMatchObject({ state: 'set', revision: 1 });
    expect(body.dictionary.payload.targets).toEqual(WORDS.targets);
    expect(body.providerKeys).toEqual({});
    expect(res.body).not.toContain(KEY);
  });

  it('serves and shows none of the removed settings, even ones stored before they were removed (QOR-4894)', async () => {
    const removed = ['tts_voice', 'aura_color', 'timekeeper_enabled', 'follow_mode_enabled'];
    await t.pool.query(
      `INSERT INTO settings (key, value, revision) SELECT k, v::jsonb, 1 FROM unnest($1::text[], $2::text[]) AS x(k, v)`,
      [removed, ['"cedar"', '"#11DDFF"', 'true', 'true']],
    );
    const { bot_token } = await registerBot(t);
    const served = await get(bearer(bot_token));
    expect(served.statusCode).toBe(200);
    const shown = await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER });
    expect(shown.statusCode).toBe(200);
    for (const key of removed) {
      expect(served.json().settings, key).not.toHaveProperty(key);
      expect(shown.json().settings, key).not.toHaveProperty(key);
    }
  });

  it('serves no per_participant_audio, even one stored before it stopped being a setting (QOR-4760)', async () => {
    await t.pool.query(`INSERT INTO settings (key, value, revision) VALUES ('per_participant_audio', 'false'::jsonb, 1)`);
    const { bot_token } = await registerBot(t);
    const res = await get(bearer(bot_token));
    expect(res.json().settings).not.toHaveProperty('per_participant_audio');
    // A bot's tag from before names a body that may still carry it: it gets the new body, not 304.
    const before = await get({ ...bearer(bot_token), 'if-none-match': `"settings-r2-${res.json().settingsVersion}"` });
    expect(before.statusCode).toBe(200);
  });

  it('adds the provider keys, stored or from the env, only for a bot that keeps them in memory', async () => {
    const { bot_token } = await registerBot(t);
    const res = await get({ ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' });
    expect(res.json().providerKeys).toEqual({ openai: KEY, cerebras: ENV_KEY });
    const other = await get({ ...bearer(bot_token), 'x-bwat-provider-keys': 'disk' });
    expect(other.json().providerKeys).toEqual({});
    // D143: the header is X-Bwat-Provider-Keys; any other name gets no keys.
    const oldName = await get({ ...bearer(bot_token), 'x-provider-keys': 'memory-only' });
    expect(oldName.json().providerKeys).toEqual({});
  });

  it('reads the settings version before anything it covers (a save in between under-reports, never over-reports)', async () => {
    const { bot_token } = await registerBot(t);
    const seen: string[] = [];
    const query = t.pool.query.bind(t.pool);
    t.pool.query = ((...args: Parameters<typeof query>) => {
      seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text));
      return query(...args);
    }) as typeof t.pool.query;
    try {
      expect((await get(bearer(bot_token))).statusCode).toBe(200);
    } finally {
      t.pool.query = query;
    }
    const first = (pattern: RegExp) => seen.findIndex((sql) => pattern.test(sql));
    expect(first(/FROM settings_version/)).toBeGreaterThanOrEqual(0);
    expect(first(/FROM settings_version/)).toBeLessThan(first(/FROM settings\b(?!_)/));
    expect(first(/FROM settings_version/)).toBeLessThan(first(/FROM dictionary/));
  });

  it('answers 304 with no body to a bot that already has this settings version, without reading what it covers', async () => {
    const { bot_token } = await registerBot(t);
    const first = await get(bearer(bot_token));
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"settings-r3-\d+"$/);
    const seen: string[] = [];
    const query = t.pool.query.bind(t.pool);
    t.pool.query = ((...args: Parameters<typeof query>) => {
      seen.push(String(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text));
      return query(...args);
    }) as typeof t.pool.query;
    let again;
    try {
      again = await get({ ...bearer(bot_token), 'if-none-match': etag });
    } finally {
      t.pool.query = query;
    }
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(seen.some((sql) => /FROM dictionary|FROM settings\b(?!_)/.test(sql))).toBe(false);

    // Any change the bots pick up moves the version, and the same tag gets the new body.
    await t.app.inject({ method: 'PUT', url: '/console/settings/behaviour', headers: ADMIN, payload: { changes: { chat_posts_enabled: { value: true, expectedRevision: null } } } });
    const changed = await get({ ...bearer(bot_token), 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('tags a body with keys apart from one without, so a bot that changes its mind gets the body it asked for', async () => {
    const { bot_token } = await registerBot(t);
    const plain = (await get(bearer(bot_token))).headers.etag as string;
    const withKeys = await get({ ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only', 'if-none-match': plain });
    expect(withKeys.statusCode).toBe(200);
    expect(withKeys.headers.etag).toMatch(new RegExp(`^${plain.slice(0, -1)}-keys-[0-9a-f]{16}"$`));
    expect(withKeys.json().providerKeys).toEqual({ openai: KEY, cerebras: ENV_KEY });
  });

  it('reads the model keys from the store once per settings version, and again after a key changes', async () => {
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
    await get(keys);
    fake.calls.length = 0;
    expect((await get(keys)).json().providerKeys).toEqual({ openai: KEY, cerebras: ENV_KEY });
    expect(fake.calls).toEqual([]);

    await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: NEW_KEY } });
    expect((await get(keys)).json().providerKeys).toEqual({ openai: NEW_KEY, cerebras: ENV_KEY });
    await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
  });

  it('does not keep a read that failed: the next poll asks the store again', async () => {
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
    // A new version, so nothing is cached for it yet.
    await t.app.inject({ method: 'PUT', url: '/console/settings/behaviour', headers: ADMIN, payload: { changes: { chat_posts_enabled: { value: true, expectedRevision: null } } } });
    fake.failWith = 'ThrottlingException';
    try {
      // The env never stands in for a store that cannot be read (B2): the bot uses its own.
      expect((await get(keys)).json().providerKeys).toEqual({});
    } finally {
      fake.failWith = null;
    }
    expect((await get(keys)).json().providerKeys).toEqual({ openai: KEY, cerebras: ENV_KEY });
  });

  it('sends no ETag with keys it could not read, so a bot that follows the ETag asks again and gets them', async () => {
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
    const held = (await get(keys)).headers.etag as string;
    await t.app.inject({ method: 'PUT', url: '/console/settings/behaviour', headers: ADMIN, payload: { changes: { chat_posts_enabled: { value: false, expectedRevision: 1 } } } });
    fake.failWith = 'ThrottlingException';
    let incomplete;
    try {
      incomplete = await get(keys);
    } finally {
      fake.failWith = null;
    }
    expect(incomplete.statusCode).toBe(200);
    expect(incomplete.headers['cache-control']).toBe('no-store');
    expect(incomplete.headers.etag).toBeUndefined();
    // The bot follows the ETag contract: it sends back the last tag it was given.
    const next = await get({ ...keys, 'if-none-match': (incomplete.headers.etag as string | undefined) ?? held });
    expect(next.statusCode).toBe(200);
    expect(next.headers.etag).toMatch(new RegExp(`^"settings-r3-${incomplete.json().settingsVersion}-keys-[0-9a-f]{16}"$`));
    expect(next.json().providerKeys).toEqual({ openai: KEY, cerebras: ENV_KEY });
  });

  it('never answers 304 for keys it could not read, even to If-None-Match: *', async () => {
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only', 'if-none-match': '*' };
    // A new settings version, so the keys are read from the (failing) store, not the cache.
    const current = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN })).json();
    const revision = current.settings.chat_posts_enabled.revision;
    await t.app.inject({ method: 'PUT', url: '/console/settings/behaviour', headers: ADMIN, payload: { changes: { chat_posts_enabled: { value: true, expectedRevision: revision } } } });
    fake.failWith = 'ThrottlingException';
    let incomplete;
    try {
      incomplete = await get(keys);
    } finally {
      fake.failWith = null;
    }
    expect(incomplete.statusCode).toBe(200);
    expect(incomplete.headers.etag).toBeUndefined();
  });

  it('never logs a key or a setting value', () => {
    for (const secret of [KEY, ENV_KEY, NEW_KEY, 'Scribe', 'Zedekiah']) expect(lines.join('')).not.toContain(secret);
  });
});

describeDb('GET /bot/settings when the store fails and the backend has env keys (QOR-4578)', () => {
  const fake = new FakeSecretsManager();
  const env = { OPENAI_API_KEY: ENV_KEY, ANTHROPIC_API_KEY: ENV_KEY, OPENROUTER_API_KEY: ENV_KEY, CEREBRAS_API_KEY: ENV_KEY };
  const t = useRoles({ secrets: () => withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, env) });
  const get = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/bot/settings', headers });

  it('serves no env key in place of an unreadable one (B2): no ETag, nothing kept, and the next poll gets the stored key', async () => {
    await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
    const held = (await get(keys)).headers.etag as string;
    await t.app.inject({ method: 'PUT', url: '/console/settings/behaviour', headers: ADMIN, payload: { changes: { chat_posts_enabled: { value: true, expectedRevision: null } } } });
    fake.failWith = 'ThrottlingException';
    let fallback;
    try {
      fallback = await get(keys);
    } finally {
      fake.failWith = null;
    }
    expect(fallback.json().providerKeys).toEqual({});
    expect(fallback.headers.etag).toBeUndefined();
    const next = await get({ ...keys, 'if-none-match': (fallback.headers.etag as string | undefined) ?? held });
    expect(next.statusCode).toBe(200);
    expect(next.json().providerKeys.openai).toBe(KEY);
  });
});

describeDb('GET /bot/settings when the store fails and no env stands in (QOR-4578)', () => {
  const fake = new FakeSecretsManager();
  const t = useRoles({ secrets: () => awsSecretStore(fake, 'bwat/test/') });
  const get = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/bot/settings', headers });

  it('leaves the unreadable keys out, with no ETag and nothing kept, and the next poll gets them', async () => {
    await t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key: KEY } });
    const { bot_token } = await registerBot(t);
    const keys = { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
    fake.failWith = 'ThrottlingException';
    let failed;
    try {
      failed = await get(keys);
    } finally {
      fake.failWith = null;
    }
    expect(failed.json().providerKeys).toEqual({});
    expect(failed.headers.etag).toBeUndefined();
    const next = await get(keys);
    expect(next.headers.etag).toMatch(new RegExp(`^"settings-r3-${failed.json().settingsVersion}-keys-[0-9a-f]{16}"$`));
    expect(next.json().providerKeys).toEqual({ openai: KEY });
  });
});

describeDb('GET /bot/settings re-reads the model keys within the refresh bound (B1)', () => {
  const fake = new FakeSecretsManager();
  let clock = 0;
  const REFRESH_MS = 60_000;
  const env = { CEREBRAS_API_KEY: ENV_KEY };
  const t = useRoles({
    secrets: () => withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, env),
    keyRefreshMs: REFRESH_MS,
    clock: () => clock,
  });
  const get = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/bot/settings', headers });
  const keysOf = async () => {
    const { bot_token } = await registerBot(t);
    return { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
  };
  const putKey = (key: string) => t.app.inject({ method: 'PUT', url: '/console/model-keys/openai', headers: ADMIN, payload: { key } });

  it('a stale aws read right after a write is not kept: within the bound the bot gets the new key under a new ETag', async () => {
    await putKey(KEY);
    const keys = await keysOf();
    const first = await get(keys);
    expect(first.json().providerKeys.openai).toBe(KEY);
    // Secrets Manager is eventually consistent: the PUT's own status read and the bot's next read still see KEY.
    fake.staleReads = 2;
    await putKey(NEW_KEY);
    fake.staleReads = 0;
    const stale = await get({ ...keys, 'if-none-match': first.headers.etag as string });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().providerKeys.openai).toBe(KEY);
    // Inside the bound the cached answer stands.
    expect((await get({ ...keys, 'if-none-match': stale.headers.etag as string })).statusCode).toBe(304);
    clock += REFRESH_MS;
    const fresh = await get({ ...keys, 'if-none-match': stale.headers.etag as string });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().providerKeys.openai).toBe(NEW_KEY);
    expect(fresh.json().settingsVersion).toBe(stale.json().settingsVersion);
    expect(fresh.headers.etag).not.toBe(stale.headers.etag);
  });

  it('converges within the bound when the aws write lands and the commit after it fails (no version bump)', async () => {
    await putKey(KEY);
    const keys = await keysOf();
    clock += REFRESH_MS;
    const before = await get(keys);
    expect(before.json().providerKeys.openai).toBe(KEY);
    const su = (sql: string) => asSuperuser((c) => c.query(sql), t.db.name);
    await su(`CREATE FUNCTION public.test_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'commit refused'; END $$`);
    await su(`CREATE CONSTRAINT TRIGGER test_refuse_commit AFTER INSERT ON bwat.audit DEFERRABLE INITIALLY DEFERRED
              FOR EACH ROW WHEN (NEW.action = 'model_key.set') EXECUTE FUNCTION public.test_refuse_commit()`);
    try {
      expect((await putKey(NEW_KEY)).statusCode).toBe(500);
    } finally {
      await su(`DROP TRIGGER test_refuse_commit ON bwat.audit; DROP FUNCTION public.test_refuse_commit()`);
    }
    expect(fake.secrets.get('bwat/test/provider.openai')?.value).toBe(NEW_KEY);
    clock += REFRESH_MS;
    const after = await get({ ...keys, 'if-none-match': before.headers.etag as string });
    expect(after.statusCode).toBe(200);
    expect(after.json().settingsVersion).toBe(before.json().settingsVersion);
    expect(after.json().providerKeys.openai).toBe(NEW_KEY);
    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('answers 200, not 304, to an old ETag after a restart with another env key and the same settings version', async () => {
    const keys = await keysOf();
    const first = await get(keys);
    expect(first.json().providerKeys.cerebras).toBe(ENV_KEY);
    const restarted = apiBase(buildServer({
      pool: t.pool,
      secrets: withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, { CEREBRAS_API_KEY: `${ENV_KEY}-rotated` }),
    }));
    try {
      const res = await restarted.inject({ method: 'GET', url: '/bot/settings', headers: { ...keys, 'if-none-match': first.headers.etag as string } });
      expect(res.statusCode).toBe(200);
      expect(res.json().settingsVersion).toBe(first.json().settingsVersion);
      expect(res.json().providerKeys.cerebras).toBe(`${ENV_KEY}-rotated`);
      expect(res.headers.etag).not.toBe(first.headers.etag);
      // The ETag names the keys by a digest, never the key itself.
      expect(res.headers.etag).not.toContain(ENV_KEY);
      // A tag from before the digest (`"settings-N-keys"`) is not this body either.
      const legacy = `"settings-${first.json().settingsVersion}-keys"`;
      expect((await restarted.inject({ method: 'GET', url: '/bot/settings', headers: { ...keys, 'if-none-match': legacy } })).statusCode).toBe(200);
    } finally {
      await restarted.close();
    }
  });
});

describeDb('GET /bot/settings serves a Deepgram key under the same rules (QOR-4632, D167)', () => {
  const DG_KEY = 'dg-stored-0123456789abcdef0123456789-DGK1';
  const DG_ENV = 'dg-from-env-0123456789abcdef012345678-DGE1';
  const lines: string[] = [];
  const fake = new FakeSecretsManager();
  const t = useRoles({
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
    secrets: () => withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, {}),
  });
  const get = (headers: Record<string, string>) => t.app.inject({ method: 'GET', url: '/bot/settings', headers });
  const keysOf = async () => {
    const { bot_token } = await registerBot(t);
    return { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' };
  };

  it('leaves deepgram out while no key is stored and the env has none', async () => {
    const res = await get(await keysOf());
    expect(res.json().providerKeys).toEqual({});
  });

  it('serves a stored deepgram key only to a bot that keeps keys in memory', async () => {
    const saved = await t.app.inject({ method: 'PUT', url: '/console/model-keys/deepgram', headers: ADMIN, payload: { key: DG_KEY } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ provider: 'deepgram', set: true, source: 'store', last4: 'DGK1' });
    expect(saved.body).not.toContain(DG_KEY);
    const { bot_token } = await registerBot(t);
    const plain = bearer(bot_token);
    const keys = { ...plain, 'x-bwat-provider-keys': 'memory-only' };
    expect((await get(keys)).json().providerKeys).toEqual({ deepgram: DG_KEY });
    const unasked = await get(plain);
    expect(unasked.json().providerKeys).toEqual({});
    expect(unasked.body).not.toContain(DG_KEY);
    expect((await get({ ...plain, 'x-bwat-provider-keys': 'disk' })).json().providerKeys).toEqual({});
    await t.app.inject({ method: 'DELETE', url: '/console/model-keys/deepgram', headers: ADMIN, payload: {} });
    expect((await get(keys)).json().providerKeys).toEqual({});
  });

  it('serves DEEPGRAM_API_KEY from the env, and changes the ETag when only that key changes', async () => {
    const keys = await keysOf();
    const withEnv = (value: string) =>
      apiBase(buildServer({ pool: t.pool, secrets: withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, { DEEPGRAM_API_KEY: value }) }));
    const first = withEnv(DG_ENV);
    const rotated = withEnv(`${DG_ENV}-rotated`);
    try {
      const before = await first.inject({ method: 'GET', url: '/bot/settings', headers: keys });
      expect(before.json().providerKeys).toEqual({ deepgram: DG_ENV });
      const after = await rotated.inject({ method: 'GET', url: '/bot/settings', headers: { ...keys, 'if-none-match': before.headers.etag as string } });
      expect(after.statusCode).toBe(200);
      expect(after.json().settingsVersion).toBe(before.json().settingsVersion);
      expect(after.json().providerKeys).toEqual({ deepgram: `${DG_ENV}-rotated` });
      expect(after.headers.etag).not.toBe(before.headers.etag);
      expect(after.headers.etag).not.toContain(DG_ENV);
    } finally {
      await first.close();
      await rotated.close();
    }
  });

  it('never logs the deepgram key', () => {
    for (const secret of [DG_KEY, DG_ENV]) expect(lines.join('')).not.toContain(secret);
    expect(lines.join('')).toMatch(/"event":"model_key.set","provider":"deepgram"/);
  });
});

describeDb('GET /bot/settings and the custom endpoint key (QOR-4910)', () => {
  const STORED = 'sk-custom-stored-0123456789-abcd-CUS1';
  const FROM_ENV = 'sk-custom-from-env-0123456789-ab-CUS2';
  const fake = new FakeSecretsManager();
  const t = useRoles({ secrets: () => withEnvFallback(awsSecretStore(fake, 'bwat/test/'), MODEL_KEY_ENV, { CUSTOM_MODEL_API_KEY: FROM_ENV }) });

  it("never serves the card writer's custom key to a bot, stored or from the env", async () => {
    const { bot_token } = await registerBot(t);
    const get = () => t.app.inject({ method: 'GET', url: '/bot/settings', headers: { ...bearer(bot_token), 'x-bwat-provider-keys': 'memory-only' } });
    const fromEnv = await get();
    expect(fromEnv.json().providerKeys).toEqual({});
    expect(fromEnv.body).not.toContain(FROM_ENV);
    const saved = await t.app.inject({ method: 'PUT', url: '/console/model-keys/custom', headers: ADMIN, payload: { key: STORED } });
    expect(saved.json()).toMatchObject({ provider: 'custom', source: 'store' });
    const stored = await get();
    expect(stored.json().providerKeys).toEqual({});
    expect(stored.body).not.toContain(STORED);
  });
});
