import { beforeEach, expect, it } from 'vitest';
import {
  botPost,
  claimRow,
  heldClaim,
  lapsingLease,
  raceBehindLock,
  registerBot,
  resetAllocationsBeforeEach,
  signedIn,
  untilLapsed,
  useApp,
} from './app.ts';
import { describeDb } from './db/harness.ts';
import { decodeJwt, fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';

describeDb('POST /assignment/join-token (QOR-4581)', () => {
  const secrets = zoomSecrets({});
  const zoom = fakeZoom();
  const t = useApp({ authenticatePerson: signedIn, getSecret: secrets, zoomFetch: zoom.fetch });
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    secrets.values = { ...ZOOM_APP };
    secrets.failing = false;
    secrets.unreadable = [];
    zoom.calls.length = 0;
    zoom.answer = undefined;
  });

  const joinToken = (token: string, payload: object) => botPost(t, '/assignment/join-token', token, payload);

  it('mints a Meeting SDK JWT for the claim meeting, role 0, signed with the client secret, and no recording token (not_configured) without the S2S app', async () => {
    const { bot, claimId } = await heldClaim(t, '250000001');
    const before = Math.floor(Date.now() / 1000);
    const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['recording_token', 'recording_token_error', 'recording_token_expires_at', 'sdk_jwt', 'sdk_jwt_expires_at']);
    expect(body).toMatchObject({ recording_token: null, recording_token_expires_at: null, recording_token_error: 'not_configured' });

    const jwt = decodeJwt(body.sdk_jwt, ZOOM_APP['zoom.client_secret']);
    expect(jwt.verified).toBe(true);
    expect(jwt.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    const { iat, exp, tokenExp, ...rest } = jwt.payload;
    expect(rest).toEqual({ appKey: 'test-sdk-client-id', sdkKey: 'test-sdk-client-id', mn: '250000001', role: 0 });
    // The SDK refuses a token with 1800 s or less left (QOR-4702); iat is back-dated 30 s for clock skew, exp is an hour out.
    expect(iat).toBeGreaterThanOrEqual(before - 30);
    expect(iat).toBeLessThanOrEqual(before - 29);
    expect(exp - iat).toBe(3630);
    expect(tokenExp).toBe(exp);
    expect(Date.parse(body.sdk_jwt_expires_at)).toBe(exp * 1000);
    expect(zoom.calls).toEqual([]);
  });

  it('does not verify under any other secret', async () => {
    const { bot, claimId } = await heldClaim(t, '250000002');
    const body = (await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 })).json();
    expect(decodeJwt(body.sdk_jwt, 'another-secret').verified).toBe(false);
  });

  it('answers 503 not_configured without the Zoom app client id or secret', async () => {
    for (const missing of ['zoom.client_id', 'zoom.client_secret'] as const) {
      const { bot, claimId } = await heldClaim(t, missing === 'zoom.client_id' ? '250000003' : '250000004');
      secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
      delete secrets.values[missing];
      zoom.calls.length = 0; // the send asks Zoom for the meeting's schedule; the join token must not
      const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
      expect(res.statusCode, missing).toBe(503);
      expect(res.json()).toEqual({ error: 'not_configured' });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(zoom.calls, missing).toEqual([]);
    }
  });

  it('answers 503 secret_unavailable when the Zoom app secrets cannot be read', async () => {
    const { bot, claimId } = await heldClaim(t, '250000005');
    secrets.failing = true;
    const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'secret_unavailable' });
  });

  it('answers 409 stale_claim for a generation the bot does not hold, before it reads any secret', async () => {
    const { bot, claimId } = await heldClaim(t, '250000006');
    secrets.failing = true;
    for (const generation of [0, 2]) {
      const res = await joinToken(bot.bot_token, { claim_id: claimId, generation });
      expect(res.statusCode, `generation ${generation}`).toBe(409);
      expect(res.json()).toEqual({ error: 'stale_claim' });
    }
  });

  it("answers 409 stale_claim for another bot's claim, an ended claim and a lapsed lease", async () => {
    const { claimId } = await heldClaim(t, '250000007');
    const other = await registerBot(t);
    expect((await joinToken(other.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(409);

    const ended = await heldClaim(t, '250000008');
    await t.pool.query(`UPDATE claims SET state = 'done' WHERE id = $1`, [ended.claimId]);
    expect((await joinToken(ended.bot.bot_token, { claim_id: ended.claimId, generation: 1 })).statusCode).toBe(409);

    const lapsed = await heldClaim(t, '250000009');
    await t.pool.query(`UPDATE claims SET lease_until = now() - interval '1 second' WHERE id = $1`, [lapsed.claimId]);
    expect((await joinToken(lapsed.bot.bot_token, { claim_id: lapsed.claimId, generation: 1 })).statusCode).toBe(409);
  });

  it('judges the lease after it holds the claim: one that lapsed while a lock that changed nothing held it is refused', async () => {
    const { bot, claimId } = await heldClaim(t, '250000010');
    await lapsingLease(t, claimId, 1500);
    const res = await raceBehindLock(
      t,
      { sql: `SELECT 1 FROM claims WHERE id = $1 FOR UPDATE`, params: [claimId] },
      () => joinToken(bot.bot_token, { claim_id: claimId, generation: 1 }),
      () => untilLapsed(t, claimId),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'stale_claim' });
  });

  it('ends a claim whose drain ran out, as a heartbeat does: 409 stale_claim', async () => {
    const { bot, claimId } = await heldClaim(t, '250000011');
    await t.pool.query(`UPDATE claims SET drain_until = now() - interval '1 second' WHERE id = $1`, [claimId]);
    expect((await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 })).statusCode).toBe(409);
    expect(await claimRow(t, claimId)).toMatchObject({ state: 'done', refused_reason: 'drain_expired' });
  });

  it('adds the recording join token from the S2S app when it is configured', async () => {
    const { bot, claimId } = await heldClaim(t, '250000013');
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    const before = Date.now();
    const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recording_token).toBe('recording-250000013');
    expect(body).not.toHaveProperty('recording_token_error');
    const expires = Date.parse(body.recording_token_expires_at);
    expect(expires).toBeGreaterThanOrEqual(before + 120_000 - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/250000013/jointoken/local_recording?bypass_waiting_room=true']);
  });

  it('asks for a recording token that waits in the waiting room once the admin turns "Skip the waiting room" off (QOR-4893)', async () => {
    const { bot, claimId } = await heldClaim(t, '250000018');
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    const save = (value: string) =>
      t.pool.query(`INSERT INTO settings (key, value, revision) VALUES ('bypass_waiting_room', $1::jsonb, 1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);
    await save('false');
    try {
      expect((await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 })).json().recording_token).toBe('recording-250000018');
      expect(zoom.apiCalls().map((c) => c.url)).toEqual(['https://api.zoom.us/v2/meetings/250000018/jointoken/local_recording?bypass_waiting_room=false']);
    } finally {
      await save('null'); // reset: the default again
    }
  });

  it('answers no recording token (not_found), and still the SDK JWT, for a meeting the S2S account does not have (404)', async () => {
    const { bot, claimId } = await heldClaim(t, '250000014');
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 404, body: { code: 3001 } } : undefined);
    const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recording_token: null, recording_token_expires_at: null, recording_token_error: 'not_found' });
    expect(decodeJwt(res.json().sdk_jwt, ZOOM_APP['zoom.client_secret']).verified).toBe(true);
  });

  it('still answers 200 with the SDK JWT when Zoom fails the recording token (a 5xx, the token endpoint refusing, no answer): zoom_unavailable', async () => {
    const { bot, claimId } = await heldClaim(t, '250000015');
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    for (const answer of [{ status: 500 }, 'network_error'] as const) {
      zoom.answer = () => answer;
      const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
      expect(res.statusCode, JSON.stringify(answer)).toBe(200);
      expect(res.json()).toMatchObject({ recording_token: null, recording_token_expires_at: null, recording_token_error: 'zoom_unavailable' });
      expect(decodeJwt(res.json().sdk_jwt, ZOOM_APP['zoom.client_secret']).verified).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('still answers 200 with the SDK JWT when only the S2S secrets cannot be read: secret_unavailable', async () => {
    const { bot, claimId } = await heldClaim(t, '250000017');
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    secrets.unreadable = ['zoom.s2s_client_secret'];
    const res = await joinToken(bot.bot_token, { claim_id: claimId, generation: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recording_token: null, recording_token_expires_at: null, recording_token_error: 'secret_unavailable' });
    expect(decodeJwt(res.json().sdk_jwt, ZOOM_APP['zoom.client_secret']).verified).toBe(true);
    expect(zoom.calls).toEqual([]);
  });

  it('refuses a body without a usable fence (400) and a caller without a bot token (401)', async () => {
    const { bot, claimId } = await heldClaim(t, '250000012');
    for (const payload of [{}, { claim_id: claimId }, { claim_id: 'nope', generation: 1 }, { claim_id: claimId, generation: -1 }]) {
      expect((await joinToken(bot.bot_token, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await joinToken('bwb_nobody', { claim_id: claimId, generation: 1 })).statusCode).toBe(401);
  });
});

describeDb('POST /assignment/join-token on the server clock (QOR-4581)', () => {
  const at = Date.parse('2026-10-02T12:00:00Z');
  const t = useApp({ authenticatePerson: signedIn, getSecret: zoomSecrets({ ...ZOOM_APP }), zoomFetch: fakeZoom().fetch, clock: () => at });
  resetAllocationsBeforeEach(t);

  it('dates the JWT by the server clock: iat 30 s back, exp and tokenExp 3600 s on (QOR-4702)', async () => {
    const { bot, claimId } = await heldClaim(t, '250000016');
    const body = (await botPost(t, '/assignment/join-token', bot.bot_token, { claim_id: claimId, generation: 1 })).json();
    const { iat, exp, tokenExp } = decodeJwt(body.sdk_jwt, ZOOM_APP['zoom.client_secret']).payload;
    expect({ iat, exp, tokenExp }).toEqual({ iat: at / 1000 - 30, exp: at / 1000 + 3600, tokenExp: at / 1000 + 3600 });
    expect(body.sdk_jwt_expires_at).toBe('2026-10-02T13:00:00.000Z');
  });
});
