import { beforeEach, describe, expect, it } from 'vitest';
import { zoomApi, ZoomUnavailable } from '../src/zoom-api.ts';
import { fakeZoom, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';

describe('the Zoom Server-to-Server OAuth client (QOR-4581)', () => {
  let zoom: ReturnType<typeof fakeZoom>;
  let secrets: ReturnType<typeof zoomSecrets>;
  let clock: number;
  let api: ReturnType<typeof zoomApi>;
  beforeEach(() => {
    zoom = fakeZoom();
    secrets = zoomSecrets({ ...ZOOM_S2S });
    clock = Date.parse('2026-10-02T12:00:00Z');
    api = zoomApi({ getSecret: secrets, fetch: zoom.fetch, now: () => clock, timeoutMs: 200 });
  });

  it('asks for an account_credentials token with Basic auth and a form body, then calls the API with it', async () => {
    expect(await api.recordingToken('250000001', true)).toEqual({ token: 'recording-250000001', expiresAt: new Date(clock + 120_000) });
    const [token, call] = zoom.calls;
    expect(token).toMatchObject({ method: 'POST', url: 'https://zoom.us/oauth/token' });
    const basic = Buffer.from(`${ZOOM_S2S['zoom.s2s_client_id']}:${ZOOM_S2S['zoom.s2s_client_secret']}`).toString('base64');
    expect(token!.authorization).toBe(`Basic ${basic}`);
    expect(Object.fromEntries(new URLSearchParams(token!.body!))).toEqual({
      grant_type: 'account_credentials',
      account_id: ZOOM_S2S['zoom.s2s_account_id'],
    });
    expect(call).toMatchObject({
      method: 'GET',
      url: 'https://api.zoom.us/v2/meetings/250000001/jointoken/local_recording?bypass_waiting_room=true',
      authorization: 'Bearer access-1',
    });
  });

  it('keeps the access token until shortly before it expires, then asks for a new one', async () => {
    await api.recordingToken('250000001', true);
    clock += 3600_000 - 5 * 60_000 - 1;
    await api.recordingToken('250000001', true);
    expect(zoom.tokenCalls()).toHaveLength(1);
    clock += 1;
    await api.recordingToken('250000001', true);
    expect(zoom.tokenCalls()).toHaveLength(2);
    expect(zoom.apiCalls().map((c) => c.authorization)).toEqual(['Bearer access-1', 'Bearer access-1', 'Bearer access-2']);
  });

  it('asks for one token at a time: callers that arrive during a refresh wait for it', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://zoom.us/') ? { ...zoom.standard(call), delayMs: 50 } : undefined);
    await Promise.all(Array.from({ length: 5 }, () => api.recordingToken('250000001', true)));
    expect(zoom.tokenCalls()).toHaveLength(1);
    expect(zoom.apiCalls()).toHaveLength(5);
  });

  it('answers ZoomUnavailable (status 401) for a refused token without asking again, and drops it for the next call', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 401 } : undefined);
    await expect(api.recordingToken('250000001', true)).rejects.toMatchObject({ code: 'zoom_unavailable', status: 401 });
    expect(zoom.apiCalls()).toHaveLength(1);
    expect(zoom.tokenCalls()).toHaveLength(1);
    zoom.answer = () => undefined;
    expect(await api.recordingToken('250000001', true)).toMatchObject({ token: 'recording-250000001' });
    expect(zoom.tokenCalls()).toHaveLength(2);
  });

  it('reads the credentials on every call: a rotated secret gets a new token at once', async () => {
    await api.recordingToken('250000001', true);
    secrets.values = { ...ZOOM_S2S, 'zoom.s2s_client_secret': 'rotated-s2s-secret-0123456789' };
    await api.recordingToken('250000001', true);
    expect(zoom.tokenCalls()).toHaveLength(2);
    expect(zoom.tokenCalls()[1]!.authorization).toBe(`Basic ${Buffer.from(`test-s2s-client-id:rotated-s2s-secret-0123456789`).toString('base64')}`);
  });

  it('is not configured, and calls nothing, while any of the three S2S secrets is unset', async () => {
    for (const missing of Object.keys(ZOOM_S2S)) {
      secrets.values = { ...ZOOM_S2S };
      delete secrets.values[missing];
      expect(await api.recordingToken('250000001', true), missing).toBeNull();
      expect(await api.meeting('250000001'), missing).toBeNull();
    }
    expect(zoom.calls).toEqual([]);
  });

  it('fails closed when the secret store cannot be read: the store error, and no call', async () => {
    secrets.failing = true;
    await expect(api.recordingToken('250000001', true)).rejects.toMatchObject({ code: 'secret_unavailable' });
    expect(zoom.calls).toEqual([]);
  });

  it('answers ZoomUnavailable when the token endpoint refuses, fails or is too slow, and caches no failure', async () => {
    for (const answer of [{ status: 400, body: { reason: 'Invalid client_id or client_secret' } }, { status: 503 }, 'network_error', { status: 200, delayMs: 1000 }, { status: 200, body: { nope: 1 } }] as const) {
      zoom.answer = (call) => (call.url.startsWith('https://zoom.us/') ? answer : undefined);
      const failed = await api.recordingToken('250000001', true).catch((err: unknown) => err);
      expect(failed, JSON.stringify(answer)).toBeInstanceOf(ZoomUnavailable);
    }
    zoom.answer = undefined;
    expect(await api.recordingToken('250000001', true)).toMatchObject({ token: 'recording-250000001' });
  });

  it('answers ZoomUnavailable with the status for an API failure or a slow answer', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 500 } : undefined);
    await expect(api.recordingToken('250000001', true)).rejects.toMatchObject({ code: 'zoom_unavailable', status: 500 });
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 200, delayMs: 1000 } : undefined);
    await expect(api.meeting('250000001')).rejects.toMatchObject({ code: 'zoom_unavailable', status: null });
  });

  it('answers ZoomUnavailable (status 404) for a recording token of a meeting this account does not have', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 404, body: { code: 3001 } } : undefined);
    await expect(api.recordingToken('250000001', true)).rejects.toMatchObject({ code: 'zoom_unavailable', status: 404 });
  });

  it("reads a meeting's passcode: the password, or none when it has none", async () => {
    expect(await api.meeting('250000001')).toMatchObject({ passcode: 'looked-up-pass' });
    expect(zoom.apiCalls()[0]).toMatchObject({ method: 'GET', url: 'https://api.zoom.us/v2/meetings/250000001' });
    zoom.passcode = '';
    expect(await api.meeting('250000001')).toMatchObject({ passcode: null });
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 200, body: { id: 250000001 } } : undefined);
    expect(await api.meeting('250000001')).toMatchObject({ passcode: null });
  });

  it("reads a meeting's topic and its host's email, the board's title and host; null when Zoom does not say", async () => {
    expect(await api.meeting('250000001')).toMatchObject({ topic: 'Quarterly numbers', hostEmail: 'grace@example.com' });
    zoom.answer = (call) =>
      call.url.startsWith('https://api.') ? { status: 200, body: { id: 250000001, topic: '  Weekly\n  sync ', host_email: '' } } : undefined;
    expect(await api.meeting('250000001')).toMatchObject({ topic: 'Weekly sync', hostEmail: null });
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 200, body: { id: 250000001, topic: 7 } } : undefined);
    expect(await api.meeting('250000001')).toMatchObject({ topic: null, hostEmail: null });
  });

  it('answers ZoomUnavailable for a meeting it cannot read (404)', async () => {
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 404 } : undefined);
    await expect(api.meeting('250000001')).rejects.toMatchObject({ code: 'zoom_unavailable', status: 404 });
  });

  it('puts only a meeting number (9 to 12 digits) in a Zoom path, and calls nothing for anything else', async () => {
    for (const bad of ['12345678', '1234567890123', '250000001/../../users/me', '250000001?x=1', '']) {
      await expect(api.recordingToken(bad, true), bad).rejects.toThrow('not a meeting number');
      await expect(api.meeting(bad), bad).rejects.toThrow('not a meeting number');
    }
    expect(zoom.calls).toEqual([]);
  });

  // QOR-5111: a join event's email links a Zoom account only once Zoom confirms it here.
  it("reads the email of a user on the install's own account, and fails closed on an answer about anyone else", async () => {
    const account = ZOOM_S2S['zoom.s2s_account_id'];
    const user = (body: object) => (zoom.answer = (call) => (call.url === 'https://api.zoom.us/v2/users/KDcuGIm1QgePTO8WbOqwIQ' ? { status: 200, body } : undefined));
    user({ id: 'KDcuGIm1QgePTO8WbOqwIQ', account_id: account, status: 'active', email: 'ada@example.com' });
    expect(await api.userEmail('KDcuGIm1QgePTO8WbOqwIQ')).toBe('ada@example.com');
    expect(zoom.calls.at(-1)!.authorization).toMatch(/^Bearer access-/);
    for (const other of [
      { id: 'someoneElse', account_id: account, status: 'active', email: 'ada@example.com' },
      { id: 'KDcuGIm1QgePTO8WbOqwIQ', account_id: 'another-account', status: 'active', email: 'ada@example.com' },
      { id: 'KDcuGIm1QgePTO8WbOqwIQ', status: 'active', email: 'ada@example.com' },
      { id: 'KDcuGIm1QgePTO8WbOqwIQ', account_id: account, status: 'pending', email: 'ada@example.com' },
      { id: 'KDcuGIm1QgePTO8WbOqwIQ', account_id: account, email: 'ada@example.com' },
      { id: 'KDcuGIm1QgePTO8WbOqwIQ', account_id: account, status: 'active', email: '' },
    ]) {
      user(other);
      await expect(api.userEmail('KDcuGIm1QgePTO8WbOqwIQ'), JSON.stringify(other)).rejects.toBeInstanceOf(ZoomUnavailable);
    }
  });

  it('asks nothing for a user while the S2S app is not configured', async () => {
    delete secrets.values['zoom.s2s_client_secret'];
    expect(await api.userEmail('KDcuGIm1QgePTO8WbOqwIQ')).toBeNull();
    expect(zoom.calls).toEqual([]);
  });

  it('puts only a Zoom user id in a users path, and calls nothing for anything else', async () => {
    // `me` is the S2S app's own owner, never the person asked about.
    for (const bad of ['me', '../meetings/250000001', 'a?x=1', 'a/b', '', 'x'.repeat(65)]) {
      await expect(api.userEmail(bad), bad).rejects.toBeInstanceOf(ZoomUnavailable);
    }
    expect(zoom.calls).toEqual([]);
  });
});
