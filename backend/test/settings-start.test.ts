import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { start } from '../src/server.ts';
import { zoomSignature } from '../src/zoom-signature.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { FakeSecretsManager } from './fake-secrets-manager.ts';

const DEV = 'd'.repeat(40);

describeDb('starting the server with a secret store (QOR-4578)', () => {
  const db = useTestDb();
  const env = (extra: NodeJS.ProcessEnv) => ({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', BWAT_DEV_PERSON_TOKEN: DEV, ...extra });

  it('refuses to start with a BWAT_ENC_KEY that is not a key, naming the variable only', async () => {
    await expect(start(env({ BWAT_ENC_KEY: 'not-a-key-at-all' }))).rejects.toThrow(/^BWAT_ENC_KEY must be 32 bytes/);
  });

  it('starts with BWAT_ENC_KEY_FILE, stores a model key, and a stored key overrides the env one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwat-start-'));
    writeFileSync(join(dir, 'enc'), `${randomBytes(32).toString('base64')}\n`);
    const app = await start(env({ BWAT_ENC_KEY_FILE: join(dir, 'enc'), OPENAI_API_KEY: 'sk-from-env-0123456789-ENVX' }));
    try {
      const { port } = app.server.address() as { port: number };
      const call = (method: string, path: string, body?: object) =>
        fetch(`http://127.0.0.1:${port}/v1${path}`, {
          method,
          headers: { authorization: `Bearer ${DEV}`, ...(body && { 'content-type': 'application/json' }) },
          ...(body && { body: JSON.stringify(body) }),
        });
      const before = (await (await call('GET', '/console/model-keys')).json()).keys[0];
      expect(before).toEqual({ provider: 'openai', set: true, source: 'env', last4: 'ENVX' });
      const put = await call('PUT', '/console/model-keys/openai', { key: 'sk-stored-0123456789-abcdef-STOR' });
      expect(await put.json()).toEqual({ provider: 'openai', set: true, source: 'store', last4: 'STOR' });
    } finally {
      await app.close();
    }
  });

  it('takes BWAT_DB_URL_FILE over BWAT_DB_URL, logging one warning that names the winner and not the value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwat-start-'));
    writeFileSync(join(dir, 'db'), `${db.url('runtime')}\n`);
    const lines: string[] = [];
    const logger = { level: 'info', stream: { write: (line: string) => void lines.push(line) } };
    const app = await start(env({ BWAT_DB_URL_FILE: join(dir, 'db'), BWAT_DB_URL: 'postgres://bwat_runtime:not-used@127.0.0.1:1/none' }), { logger });
    await app.close();
    const warnings = lines.filter((l) => l.includes('config.secret_precedence'));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toMatchObject({ level: 40, event: 'config.secret_precedence', name: 'BWAT_DB_URL', winner: 'BWAT_DB_URL_FILE' });
    expect(lines.join('')).not.toContain('not-used');
    expect(lines.join('')).not.toContain(db.url('runtime'));
  });

  it('in aws mode, reads BWAT_DB_URL from Secrets Manager as <prefix>BWAT_DB_URL when the env has none', async () => {
    const fake = new FakeSecretsManager();
    fake.secrets.set('bwat/test/BWAT_DB_URL', { value: db.url('runtime'), scheduled: false });
    const noUrl: NodeJS.ProcessEnv = env({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/' });
    delete noUrl.BWAT_DB_URL;
    const app = await start(noUrl, { awsClient: fake });
    await app.close();
    expect(fake.calls[0]).toBe('GetSecretValueCommand');
  });

  it('verifies Zoom webhooks with the stored zoom.webhook_secret, and with BWAT_ZOOM_WEBHOOK_SECRET while none is stored', async () => {
    const fake = new FakeSecretsManager();
    const app = await start(env({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/', BWAT_ZOOM_WEBHOOK_SECRET: 'zoom-env-secret' }), {
      awsClient: fake,
    });
    try {
      const { port } = app.server.address() as { port: number };
      const deliver = (secret: string) => {
        const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'plain' }, event_ts: Date.now() });
        const at = String(Math.floor(Date.now() / 1000));
        return fetch(`http://127.0.0.1:${port}/v1/callbacks/zoom/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': at, 'x-zm-signature': zoomSignature(secret, at, Buffer.from(body)) },
          body,
        });
      };
      expect((await deliver('zoom-env-secret')).status).toBe(200);
      fake.secrets.set('bwat/test/zoom.webhook_secret', { value: 'zoom-stored-secret', scheduled: false });
      expect((await deliver('zoom-stored-secret')).status).toBe(200);
      expect((await deliver('zoom-env-secret')).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('answers 503 to every delivery while the store is unavailable: a rotated-away env secret is not accepted again (B2)', async () => {
    const fake = new FakeSecretsManager();
    fake.secrets.set('bwat/test/zoom.webhook_secret', { value: 'zoom-secret-B', scheduled: false });
    const app = await start(env({ BWAT_SECRET_STORE: 'aws', BWAT_SECRET_PREFIX: 'bwat/test/', BWAT_ZOOM_WEBHOOK_SECRET: 'zoom-secret-A' }), {
      awsClient: fake,
    });
    try {
      const { port } = app.server.address() as { port: number };
      const deliver = async (secret: string) => {
        const body = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'plain' }, event_ts: Date.now() });
        const at = String(Math.floor(Date.now() / 1000));
        const res = await fetch(`http://127.0.0.1:${port}/v1/callbacks/zoom/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-zm-request-timestamp': at, 'x-zm-signature': zoomSignature(secret, at, Buffer.from(body)) },
          body,
        });
        return { status: res.status, body: await res.json() };
      };
      fake.failWith = 'ServiceUnavailableException';
      expect(await deliver('zoom-secret-A')).toEqual({ status: 503, body: { error: 'secret_unavailable' } });
      expect(await deliver('zoom-secret-B')).toEqual({ status: 503, body: { error: 'secret_unavailable' } });
      fake.failWith = null;
      expect((await deliver('zoom-secret-B')).status).toBe(200);
      expect((await deliver('zoom-secret-A')).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
