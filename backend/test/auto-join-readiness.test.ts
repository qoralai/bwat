import { beforeEach, expect, it, vi } from 'vitest';
import { createAutoJoinReadiness } from '../src/auto-join-readiness.ts';
import { EMAIL_LINK_SCOPE_NOTICE, zoomApi } from '../src/zoom-api.ts';
import { registerBot, until } from './app.ts';
import { describeDb } from './db/harness.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';
import { ADMIN, MEMBER, useRoles } from './people.ts';
import { deliver, zoomEvent, ZOOM_SECRET, lookupLogged } from './zoom.ts';
import { readyBusyBot } from './zoom-readiness-fixture.ts';

describeDb('automatic joining readiness', () => {
  const secrets = zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S });
  const zoom = fakeZoom();
  const t = useRoles({ getSecret: secrets, zoomFetch: zoom.fetch, zoom: { autoJoin: true, requireHost: false } });
  const readiness = () => createAutoJoinReadiness({ pool: t.pool, getSecret: secrets, zoomApi: zoomApi({ getSecret: secrets, fetch: zoom.fetch }), enabled: true });
  const event = () => ({ ...zoomEvent('meeting.started', { id: 98765432101, uuid: 'ready-occurrence' }), payload: { account_id: ZOOM_S2S['zoom.s2s_account_id'], object: { id: 98765432101, uuid: 'ready-occurrence' } } });
  beforeEach(async () => {
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    secrets.failing = false;
    zoom.answer = undefined;
    await t.pool.query('DELETE FROM auto_join_delivery');
    await t.pool.query('UPDATE bots SET ready_at = NULL');
  });

  it('does not confuse URL validation with meeting-event delivery', async () => {
    await registerBot(t);
    expect((await deliver(t, { event: 'endpoint.url_validation', payload: { plainToken: 'test' } })).statusCode).toBe(200);
    expect((await readiness().check()).problems).toContain('Waiting for a verified meeting event from this Zoom account. Check the main app’s event subscription.');
  });

  it('binds delivery evidence to the current account and webhook secret', async () => {
    await registerBot(t);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    expect((await service.check()).ready).toBe(true);
    secrets.values['zoom.webhook_secret'] = 'rotated-webhook';
    expect((await service.check()).ready).toBe(false);
    secrets.values['zoom.webhook_secret'] = ZOOM_SECRET;
    secrets.values['zoom.s2s_account_id'] = 'another-account';
    await service.observe(event(), ZOOM_SECRET);
    expect((await service.check()).ready).toBe(false);
  });

  it('rejects missing grant scopes and a stale fleet', async () => {
    await registerBot(t);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 200, body: { access_token: 'test', expires_in: 3600, scope: 'unrelated' } } : undefined;
    expect((await service.check()).ready).toBe(false);
    zoom.answer = undefined;
    await t.pool.query("UPDATE bots SET last_heartbeat = now() - interval '60 seconds'");
    expect((await readiness().check()).problems).toContain('No ready bot has checked in recently. Start or repair the meeting bot.');
  });

  it.each([undefined, null, '', ['meeting:read:meeting:admin']])('does not treat an unreported or malformed scope as verified access: %s', async scope => {
    await registerBot(t);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 200, body: { access_token: 'test', expires_in: 3600, scope } } : undefined;
    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual(['Zoom did not report the granted permissions, so automatic joining setup could not be verified. Check the server-to-server app and retry.']);
  });

  it('coalesces recent delivery writes but records rotation and later events immediately', async () => {
    const service = readiness();
    const row = async () => (await t.pool.query('SELECT configuration, received_at, xmin::text AS revision FROM auto_join_delivery')).rows[0];
    await service.observe(event(), ZOOM_SECRET);
    const first = await row();
    await service.observe(event(), ZOOM_SECRET);
    expect(await row()).toEqual(first);
    await service.observe(event(), 'rotated-secret');
    const rotated = await row();
    expect(rotated.configuration).not.toBe(first.configuration);
    await t.pool.query("UPDATE auto_join_delivery SET received_at = now() - interval '2 minutes'");
    const stale = await row();
    await service.observe(event(), 'rotated-secret');
    expect((await row()).received_at.getTime()).toBeGreaterThan(stale.received_at.getTime());
  });

  it('accepts a healthy busy bot without claiming spare capacity', async () => {
    await readyBusyBot(t);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    expect((await service.check()).ready).toBe(true);
  });

  it('requires documented meeting-read access even when meeting-write access is granted', async () => {
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 200, body: { access_token: 'test', expires_in: 3600, scope: 'meeting:write:admin meeting:read:local_recording_token:admin' } } : undefined;
    expect(await zoomApi({ getSecret: secrets, fetch: zoom.fetch }).autoJoinAccess()).toEqual(['Add meeting:read:meeting:admin to the Zoom server-to-server app.']);
  });

  // QOR-5111: linking a Zoom account by email needs user:read:user:admin; it is optional.
  const granting = (scope: string | undefined) => {
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 200, body: { access_token: 'test', expires_in: 3600, scope } } : undefined;
  };
  const MEETING_SCOPES = 'meeting:read:meeting:admin meeting:read:local_recording_token:admin';

  it('advises the email-link scope in the admin panel without making automatic joining unready', async () => {
    await registerBot(t);
    granting(MEETING_SCOPES);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    expect(await service.check()).toMatchObject({ ready: true, problems: [] });
    expect(await service.notices()).toEqual([EMAIL_LINK_SCOPE_NOTICE]);
  });

  it('shows the advice on the settings read, beside the problems and not among them', async () => {
    granting(MEETING_SCOPES);
    const read = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN })).json();
    expect(read.autoJoin.notices).toEqual([EMAIL_LINK_SCOPE_NOTICE]);
    expect(read.autoJoin.problems).not.toContain(EMAIL_LINK_SCOPE_NOTICE);
  });

  it.each(['user:read:user:admin', 'user:read:admin'])('advises nothing once the server-to-server app holds %s', async scope => {
    granting(`${MEETING_SCOPES} ${scope}`);
    expect(await zoomApi({ getSecret: secrets, fetch: zoom.fetch }).emailLinkAccess()).toEqual([]);
  });

  it('advises nothing without the server-to-server app, or when Zoom reports no scopes (autoJoinAccess says so)', async () => {
    granting(undefined);
    expect(await zoomApi({ getSecret: secrets, fetch: zoom.fetch }).emailLinkAccess()).toEqual([]);
    delete secrets.values['zoom.s2s_client_secret'];
    expect(await readiness().notices()).toEqual([]);
  });

  it('asks Zoom for a new grant after advising, at most once a minute, so a scope added in Zoom shows within one', async () => {
    granting(MEETING_SCOPES);
    let clock = Date.parse('2026-11-04T12:00:00Z');
    const api = zoomApi({ getSecret: secrets, fetch: zoom.fetch, now: () => clock });
    const before = zoom.tokenCalls().length;
    expect(await api.emailLinkAccess()).toEqual([EMAIL_LINK_SCOPE_NOTICE]);
    // Within the minute: the new grant is kept, however often the admin panel reads.
    for (let i = 0; i < 3; i++) expect(await api.emailLinkAccess()).toEqual([EMAIL_LINK_SCOPE_NOTICE]);
    expect(zoom.tokenCalls().length - before).toBe(2);
    granting(`${MEETING_SCOPES} user:read:user:admin`);
    clock += 60_000;
    expect(await api.emailLinkAccess()).toEqual([EMAIL_LINK_SCOPE_NOTICE]);
    expect(await api.emailLinkAccess()).toEqual([]);
    expect(zoom.tokenCalls().length - before).toBe(3);
  });

  it('starts off, and refuses explicit enabling without prerequisites', async () => {
    const read = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN })).json();
    expect(read.settings.auto_join_enabled.default).toBe(false);
    expect(read.autoJoin).toMatchObject({ requested: false, effective: false, ready: false });
    const saved = await t.app.inject({ method: 'PUT', url: '/console/settings/joining', headers: ADMIN, payload: { changes: { auto_join_enabled: { value: true, expectedRevision: null } } } });
    expect(saved.statusCode).toBe(400);
    expect(saved.json().error).toBe('auto_join_not_ready');
  });

  it('can save off while the credential store is unavailable', async () => {
    secrets.failing = true;
    const saved = await t.app.inject({ method: 'PUT', url: '/console/settings/joining', headers: ADMIN,
      payload: { changes: { auto_join_enabled: { value: false, expectedRevision: null } } } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().autoJoin).toMatchObject({ requested: false, effective: false });
  });

  it('members read settings without running or receiving admin readiness checks', async () => {
    const before = secrets.reads.length;
    const res = await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER });
    expect(res.statusCode).toBe(200);
    expect(res.json().autoJoin).toBeUndefined();
    expect(secrets.reads.length).toBe(before);
  });

  it('uses the settings snapshot for admin status without an extra switch-store read', async () => {
    await t.pool.query("INSERT INTO settings (key, value, revision) VALUES ('auto_join_enabled', 'false', 1) ON CONFLICT (key) DO UPDATE SET value = 'false'");
    const spy = vi.spyOn(t.app.autoJoinSwitch, 'isOn').mockRejectedValue(new Error('extra read unavailable'));
    try {
      const res = await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoJoin.requested).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('briefly limits failed OAuth checks, with immediate invalidation on credential change', async () => {
    let clock = 0;
    const service = createAutoJoinReadiness({ pool: t.pool, getSecret: secrets, zoomApi: zoomApi({ getSecret: secrets, fetch: zoom.fetch }), enabled: true, now: () => clock });
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 401 } : undefined;
    zoom.calls.length = 0;
    await service.check();
    await service.check();
    expect(zoom.tokenCalls()).toHaveLength(1);
    secrets.values['zoom.s2s_client_secret'] = 'replaced';
    await service.check();
    expect(zoom.tokenCalls()).toHaveLength(2);
    clock = 10_000;
    await service.check();
    expect(zoom.tokenCalls()).toHaveLength(3);
  });

  it('does not cache a transient OAuth outage as bad credentials', async () => {
    await registerBot(t);
    const service = readiness();
    await service.observe(event(), ZOOM_SECRET);
    zoom.answer = call => call.url.includes('/oauth/token') ? { status: 503 } : undefined;
    zoom.calls.length = 0;
    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual(['Zoom is temporarily unavailable. Automatic joining setup could not be checked. Try again shortly.']);
    expect(zoom.tokenCalls()).toHaveLength(2);
    zoom.answer = undefined;
    expect((await service.check()).ready).toBe(true);
  });

  it('reports a successful save when the subsequent fleet check fails', async () => {
    const actual = t.pool.query;
    const spy = vi.spyOn(t.pool, 'query').mockImplementation(function (...args: Parameters<typeof actual>) {
      if (String(args[0]).includes('FROM bots WHERE ready_at')) return Promise.reject(new Error('temporary database failure'));
      return actual.apply(t.pool, args);
    });
    try {
      const res = await t.app.inject({ method: 'PUT', url: '/console/settings/joining', headers: ADMIN,
        payload: { changes: { display_name: { value: 'Meeting helper', expectedRevision: null } } } });
      expect(res.statusCode).toBe(200);
      expect(res.json().settings.display_name.value).toBe('Meeting helper');
      expect(res.json().autoJoin.problems).toContain('Bot availability could not be checked. Try again shortly.');
      const read = await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN });
      expect(read.statusCode).toBe(200);
      expect(read.json().autoJoin.problems).toContain('Bot availability could not be checked. Try again shortly.');
    } finally { spy.mockRestore(); }
  });

  it('recognizes newly granted Zoom scopes without rotating credentials', async () => {
    let clock = 0;
    let addedScope = false;
    await registerBot(t);
    const service = createAutoJoinReadiness({ pool: t.pool, getSecret: secrets, zoomApi: zoomApi({ getSecret: secrets, fetch: zoom.fetch }), enabled: true, now: () => clock });
    await service.observe(event(), ZOOM_SECRET);
    zoom.answer = call => call.url.includes('/oauth/token') && !addedScope
      ? { status: 200, body: { access_token: 'limited', expires_in: 3600, scope: 'meeting:read:meeting:admin' } } : undefined;
    expect((await service.check()).ready).toBe(false);
    addedScope = true;
    clock = 10_000;
    expect((await service.check()).ready).toBe(true);
  });
});

describeDb('joining, once an admin turned it on, through a real signed webhook', () => {
  const secrets = zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S });
  const zoom = fakeZoom();
  const lines: string[] = [];
  let pauseNextSecret: (() => Promise<void>) | undefined;
  let pauseAccount: (() => Promise<void>) | undefined;
  const t = useRoles({ getSecret: async name => {
    if (name === 'zoom.s2s_account_id' && pauseAccount) await pauseAccount();
    if (name === 'zoom.client_id' && pauseNextSecret) {
      const pause = pauseNextSecret;
      pauseNextSecret = undefined;
      await pause();
    }
    return secrets(name);
  }, zoomFetch: zoom.fetch, zoom: { autoJoin: true, requireHost: false },
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } } });
  beforeEach(async () => {
    pauseNextSecret = undefined;
    pauseAccount = undefined;
    zoom.answer = undefined;
    zoom.recording = 'none';
    secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    await t.pool.query("UPDATE claims SET state = 'done', ended_at = now() WHERE state <> 'done'");
    await t.pool.query('UPDATE bots SET ready_at = NULL');
    await t.pool.query('DELETE FROM auto_join_delivery');
    // Saved on, as an admin does once setup is ready.
    await t.pool.query("INSERT INTO settings (key, value, revision) VALUES ('auto_join_enabled', 'true', 1) ON CONFLICT (key) DO UPDATE SET value = 'true'");
    t.app.autoJoinSwitch.invalidate();
    await registerBot(t);
    lines.length = 0;
  });
  const start = (id: number) => zoomEvent('meeting.started', { id, uuid: `occ-${id}` });
  const claims = async (id: number) => (await t.pool.query('SELECT id FROM claims WHERE meeting_number = $1', [String(id)])).rows;

  it('the first verified event opens a non-recording meeting once', async () => {
    const event = start(98765000001);
    expect((await deliver(t, event)).json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'claim_opened' });
    expect((await deliver(t, event)).json()).toEqual({ status: 'duplicate' });
    expect(await claims(98765000001)).toHaveLength(1);
  });

  it.each([503, 429, 'network_error'] as const)('retries a transient OAuth failure before dropping the signed start: %s', async failure => {
    secrets.values['zoom.s2s_client_secret'] = `retry-test-${failure}`;
    const id = typeof failure === 'number' ? 98765001000 + failure : 98765001999;
    let asks = 0;
    zoom.answer = call => {
      if (!call.url.includes('/oauth/token') || ++asks > 1) return undefined;
      return failure === 'network_error' ? failure : { status: failure };
    };
    expect((await deliver(t, start(id))).json()).toEqual({ status: 'meeting_lookup' });
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'claim_opened' });
    expect(asks).toBe(2);
    expect(await claims(id)).toHaveLength(1);
  });

  it('an explicit off saved during lookup prevents joining, even with a cached on value', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    zoom.answer = call => {
      if (!call.url.includes('api.zoom.us')) return undefined;
      reached = true;
      return { ...zoom.standard(call), held };
    };
    try {
      await deliver(t, start(98765000002));
      expect(await until(async () => reached)).toBe(true);
      const read = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: ADMIN })).json();
      const saved = await t.app.inject({ method: 'PUT', url: '/console/settings/joining', headers: ADMIN,
        payload: { changes: { auto_join_enabled: { value: false, expectedRevision: read.settings.auto_join_enabled.revision } } } });
      expect(saved.statusCode).toBe(200);
    } finally { release(); }
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'switched_off' });
    expect(await claims(98765000002)).toEqual([]);
  });

  it('refuses a different account even after genuine delivery evidence exists', async () => {
    await deliver(t, zoomEvent('meeting.ended', { id: 98765000003, uuid: 'prior' }));
    const event = start(98765000004);
    event.payload.account_id = 'another-account';
    await deliver(t, event);
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'not_ready' });
    expect(await claims(98765000004)).toEqual([]);
  });

  it('blocks a claim when credentials rotate while Zoom is answering', async () => {
    zoom.answer = call => {
      if (!call.url.includes('api.zoom.us')) return undefined;
      secrets.values['zoom.client_secret'] = 'changed-sdk-secret';
      return zoom.standard(call);
    };
    await deliver(t, start(98765000005));
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'configuration_changed' });
    expect(await claims(98765000005)).toEqual([]);
  });

  it('also observes off saved during the final credential reread', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    zoom.answer = call => {
      if (!call.url.includes('api.zoom.us')) return undefined;
      pauseNextSecret = async () => { reached = true; await held; };
      return zoom.standard(call);
    };
    try {
      await deliver(t, start(98765000006));
      expect(await until(async () => reached)).toBe(true);
      const row = (await t.pool.query("SELECT revision FROM settings WHERE key = 'auto_join_enabled'")).rows[0];
      const saved = await t.app.inject({ method: 'PUT', url: '/console/settings/joining', headers: ADMIN,
        payload: { changes: { auto_join_enabled: { value: false, expectedRevision: row?.revision ?? null } } } });
      expect(saved.statusCode).toBe(200);
    } finally { release(); }
    expect(await lookupLogged({ lines })).toMatchObject({ outcome: 'switched_off' });
    expect(await claims(98765000006)).toEqual([]);
  });

  it('meeting-end cleanup and acknowledgement do not wait for the account secret', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    pauseAccount = () => held;
    await t.pool.query("INSERT INTO claims (meeting_number, occurrence_uuid) VALUES ('98765000007', 'ended-while-secret-slow')");
    try {
      const res = await deliver(t, zoomEvent('meeting.ended', { id: 98765000007, uuid: 'ended-while-secret-slow' }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'released' });
      expect((await t.pool.query("SELECT state FROM claims WHERE meeting_number = '98765000007'")).rows[0].state).toBe('done');
    } finally { release(); pauseAccount = undefined; }
  });
});
