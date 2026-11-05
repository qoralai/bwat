import { beforeAll, expect, it } from 'vitest';
import { bearer, postAllocation, registerBot, useApp } from './app.ts';
import { describeDb } from './db/harness.ts';

describeDb('errors and request logs (QOR-4571 review)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: async () => ({ id: 'p' }),
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });
  const logs = () => lines.join('');

  beforeAll(() => {
    // Under /v1, where t.app.inject sends them. A real PostgreSQL error whose CONTEXT quotes the request's data back.
    t.app.post('/v1/test/pg-error', async () => {
      await t.pool.query('SELECT $1::int', ['PG_SECRET']);
    });
    // Text a route stores, carrying a NUL Postgres refuses (22P05 for jsonb).
    t.app.post('/v1/test/pg-nul', async () => {
      await t.pool.query('SELECT $1::jsonb', [JSON.stringify({ passcode: 'NUL_SECRET\u0000' })]);
    });
    t.app.get('/v1/test/throw', async () => {
      throw Object.assign(new Error('THROWN_SECRET'), { detail: 'THROWN_DETAIL' });
    });
  });

  it('never logs a passcode from a link that breaks jsonb (NUL), sent through the real route', async () => {
    await registerBot(t);
    const res = await postAllocation(t, { zoom_url: 'https://zoom.us/j/84949765022?pwd=REVIEW_SECRET%00' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'not_a_zoom_meeting_link' });
    expect(res.body).not.toContain('REVIEW_SECRET');
    expect(logs()).not.toContain('REVIEW_SECRET');
  });

  it('logs a database error as its event and code only, and answers a generic 500', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/test/pg-error' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal' });
    expect(logs()).toMatch(/"event":"request\.failed","code":"22P02"/);
    expect(logs()).not.toContain('PG_SECRET');
  });

  it("answers text Postgres cannot store (a NUL: 22P05, 22021) as the caller's bad body, 400, logging the code only", async () => {
    const res = await t.app.inject({ method: 'POST', url: '/test/pg-nul' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body' });
    expect(logs()).toMatch(/"event":"request\.rejected","code":"22P05"/);
    expect(logs()).not.toContain('NUL_SECRET');
  });

  it('answers a body of a type no route parses 415 unsupported_media_type, and one over the limit 413 too_large', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/allocations', headers: { 'content-type': 'application/xml' }, payload: '<x>MEDIA_SECRET</x>' });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: 'unsupported_media_type' });
    expect(logs()).toMatch(/"event":"request\.rejected","code":"FST_ERR_CTP_INVALID_MEDIA_TYPE"/);
    expect(logs()).not.toContain('MEDIA_SECRET');
    const big = await t.app.inject({ method: 'POST', url: '/allocations', payload: { zoom_url: 'x'.repeat(1_100_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toEqual({ error: 'too_large' });
  });

  it('logs a thrown error as its event and status only, and answers a generic 500', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/test/throw' });
    expect(res.json()).toEqual({ error: 'internal' });
    expect(res.statusCode).toBe(500);
    expect(logs()).toMatch(/"event":"request\.failed","code":500/);
    for (const secret of ['THROWN_SECRET', 'THROWN_DETAIL']) expect(logs()).not.toContain(secret);
  });

  it('keeps a 4xx for a body that is not JSON, without echoing it', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/allocations',
      headers: { 'content-type': 'application/json' },
      payload: '{"zoom_url": "BODY_SECRET',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('BODY_SECRET');
    expect(logs()).not.toContain('BODY_SECRET');
  });

  it('an unknown route or wrong method answers a generic 404 and never logs or echoes the raw URL', async () => {
    for (const [method, url] of [['POST', '/assignment?pwd=NOTFOUND_SECRET'], ['GET', '/nowhere?pwd=NOTFOUND_SECRET']] as const) {
      const res = await t.app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
      expect(res.body).not.toContain('NOTFOUND_SECRET');
    }
    expect(logs()).not.toContain('NOTFOUND_SECRET');
  });

  it('never logs a query string', async () => {
    const bot = await registerBot(t);
    await t.app.inject({ method: 'GET', url: '/assignment?pwd=QUERY_SECRET', headers: bearer(bot.bot_token) });
    expect(logs()).toContain('"url":"/v1/assignment"');
    expect(logs()).not.toContain('QUERY_SECRET');
  });
});
