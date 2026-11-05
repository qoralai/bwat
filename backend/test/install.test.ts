import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, it } from 'vitest';
import { cardsClient } from '../src/cards-client.ts';
import { issueCardsCredential, issueInstallCredential } from '../src/credentials.ts';
import { bearer, PERSON, signedIn, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

// QOR-4334: the onboarding page's credential (bwi_) reads GET /install/status, the facts
// its checks tick steps from, and nothing else; it lapses after 30 days or when revoked.

const TOKEN = 'cards-backend-token-0123456789-abcdef-0123456789';
let cardCount = 0;
const fake = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}` || req.url !== '/v1/card-count') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count: cardCount }));
});
await new Promise<void>((listening) => fake.listen(0, '127.0.0.1', listening));
afterAll(() => { fake.close(); });

describeDb('the onboarding page\'s credential and GET /install/status (QOR-4334)', () => {
  const t = useApp({ authenticatePerson: signedIn, cards: cardsClient(`http://127.0.0.1:${(fake.address() as AddressInfo).port}`, TOKEN) });
  const status = (token: string) => t.app.inject({ method: 'GET', url: '/install/status', headers: bearer(token) });

  it('answers the facts the checks need, and no secret, name or content', async () => {
    const token = await issueInstallCredential(t.pool, 'onboard');
    cardCount = 0;
    const res = await status(token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ owner_signed_in: true, claude_connected: false, meeting_transcribed: false, cards: 0 });
    expect(body.zoom.ready).toBe(false);
    expect(body.zoom.problems.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(['cards', 'claude_connected', 'meeting_transcribed', 'owner_signed_in', 'zoom']);
    cardCount = 3;
    expect((await status(token)).json().cards).toBe(3);
  });

  it('says Claude Code is connected once a signed-in session has registered', async () => {
    const token = await issueInstallCredential(t.pool);
    // The runtime role may not delete sessions, so the row stays: each test file has its own
    // database, and the one test that wants no session runs before this one.
    await t.pool.query(`INSERT INTO sessions (member_id, session_id, instance_id, client)
      SELECT id, 'install-test-session', 'i1', '{}'::jsonb FROM members WHERE role = 'owner' LIMIT 1
      ON CONFLICT DO NOTHING`);
    expect((await status(token)).json().claude_connected).toBe(true);
  });

  it('says no owner has signed in yet before onboarding', async () => {
    const token = await issueInstallCredential(t.pool);
    await t.pool.query(`UPDATE members SET activated_at = NULL WHERE role = 'owner'`);
    try {
      expect((await status(token)).json().owner_signed_in).toBe(false);
    } finally {
      await t.pool.query(`UPDATE members SET activated_at = now() WHERE role = 'owner'`);
    }
  });

  it('is refused once revoked, and for anyone else', async () => {
    const revoked = await issueInstallCredential(t.pool);
    await t.pool.query(`UPDATE install_credentials SET revoked_at = now() WHERE token_sha256 = sha256($1::bytea)`, [Buffer.from(revoked)]);
    expect((await status(revoked)).statusCode).toBe(401);
    expect((await status(`bwi_${'A'.repeat(43)}`)).statusCode).toBe(401);
    expect((await status(await issueCardsCredential(t.pool))).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/install/status', headers: PERSON })).statusCode).toBe(401);
  });

  it('lapses 30 days after it is made', async () => {
    const token = await issueInstallCredential(t.pool);
    const { rows } = await t.pool.query<{ days: number }>(
      `SELECT extract(epoch FROM expires_at - created_at) / 86400 AS days FROM install_credentials ORDER BY created_at DESC LIMIT 1`);
    expect(Number(rows[0]!.days)).toBe(30);
    const owner = await t.db.connect('owner');
    try {
      await owner.query(`UPDATE bwat.install_credentials SET expires_at = now() - interval '1 second' WHERE token_sha256 = sha256($1::bytea)`,
        [Buffer.from(token)]);
    } finally {
      await owner.end();
    }
    expect((await status(token)).statusCode).toBe(401);
  });

  it('revokes itself, after which it reaches nothing', async () => {
    const token = await issueInstallCredential(t.pool);
    const other = await issueInstallCredential(t.pool);
    expect((await t.app.inject({ method: 'POST', url: '/install/revoke', headers: bearer(token) })).statusCode).toBe(204);
    expect((await status(token)).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/install/revoke', headers: bearer(token) })).statusCode).toBe(401);
    expect((await status(other)).statusCode).toBe(200);
  });

  it('reaches no other route', async () => {
    const token = await issueInstallCredential(t.pool);
    for (const url of ['/fleet', '/meetings', '/members', '/console/secrets', '/assignment']) {
      expect((await t.app.inject({ method: 'GET', url, headers: bearer(token) })).statusCode, url).toBe(401);
    }
  });
});
