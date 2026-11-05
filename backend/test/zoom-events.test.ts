import { expect, it } from 'vitest';
import { readyBusyBot } from './zoom-readiness-fixture.ts';
import { describeDb } from './db/harness.ts';
import { autoJoined, deliver, storedSwitch, useAutoJoinApp, useZoomApp, ZOOM_SECRET, zoomEvent } from './zoom.ts';

const ZOOM = { autoJoin: true, requireHost: false };

describeDb('POST /callbacks/zoom/events: who may call it (QOR-4576)', () => {
  const t = useZoomApp({ zoom: ZOOM });

  it('answers Zoom endpoint validation with the plain token and its HMAC, once signed', async () => {
    const res = await deliver(t, { event: 'endpoint.url_validation', payload: { plainToken: 'abc123' }, event_ts: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plainToken: 'abc123',
      // HMAC-SHA256('zoom-test-secret-token', 'abc123'), computed with Python's hmac.
      encryptedToken: 'cacf67dae3b8002c243051c2bf41bf0a4c0ad401e599b2f8439dfd028018829e',
    });
  });

  it('refuses an unsigned, wrongly signed or stale delivery with 401, validation included', async () => {
    const challenge = { event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } };
    for (const [why, options] of [
      ['unsigned', { signature: null }],
      ['wrong secret', { secret: 'not-the-secret' }],
      ['six minutes old', { at: Math.floor(Date.now() / 1000) - 360 }],
    ] as const) {
      const res = await deliver(t, challenge, options);
      expect(res.statusCode, why).toBe(401);
      expect(res.json(), why).toEqual({ error: 'unauthorized' });
    }
  });

  it('refuses a signed body that is not JSON, and a validation without a plain token', async () => {
    expect((await deliver(t, 'not json')).statusCode).toBe(400);
    expect((await deliver(t, { event: 'endpoint.url_validation', payload: {} })).statusCode).toBe(400);
  });

  it('is served at the contract path /callbacks/zoom/events; the old /zoom/events answers 404', async () => {
    const body = { event: 'endpoint.url_validation', payload: { plainToken: 'path' } };
    const post = (url: string) => deliver(t, body, { url });
    const current = await post('/callbacks/zoom/events');
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ plainToken: 'path' });
    const old = await post('/zoom/events');
    expect(old.statusCode).toBe(404);
    expect(old.json()).toEqual({ error: 'not_found' });
  });

  const recorded = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM zoom_deliveries`)).rows[0].n;

  it('acts on a delivery once: a re-delivery of the same body is answered as a duplicate', async () => {
    const event = zoomEvent('meeting.ended', { id: 123456789, uuid: 'occ-dup' });
    const first = await deliver(t, event);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'tombstoned' });
    const again = await deliver(t, event);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'duplicate' });
    expect(await recorded()).toBe(1);
  });

  it('records no delivery it does not act on: an ignored type, or an arrival nobody waits for', async () => {
    const before = await recorded();
    for (const event of [
      zoomEvent('recording.completed', { id: 123456780 }),
      zoomEvent('meeting.participant_joined', { id: 123456781, uuid: 'occ-x', participant: { id: 'p' } }),
    ]) {
      expect((await deliver(t, event)).json()).toEqual({ status: 'ignored' });
      expect((await deliver(t, event)).json()).toEqual({ status: 'ignored' });
    }
    expect(await recorded()).toBe(before);
  });

  it('sweeps deliveries older than a day when it records one', async () => {
    await t.pool.query(
      `INSERT INTO zoom_deliveries (body_sha256, received_at)
       VALUES (sha256('old'), now() - interval '25 hours'), (sha256('recent'), now() - interval '23 hours')`,
    );
    await deliver(t, zoomEvent('meeting.ended', { id: 123456782, uuid: 'occ-sweep' }));
    const { rows } = await t.pool.query(
      `SELECT body_sha256 = sha256('recent') AS recent FROM zoom_deliveries WHERE body_sha256 IN (sha256('old'), sha256('recent'))`,
    );
    expect(rows).toEqual([{ recent: true }]);
  });

  it('does not record validation challenges as deliveries', async () => {
    const challenge = { event: 'endpoint.url_validation', payload: { plainToken: 'twice' }, event_ts: 2 };
    expect((await deliver(t, challenge)).statusCode).toBe(200);
    expect((await deliver(t, challenge)).json()).toMatchObject({ plainToken: 'twice' });
  });
});

describeDb('POST /callbacks/zoom/events without a webhook secret (QOR-4576)', () => {
  const t = useZoomApp({ zoom: ZOOM, getSecret: async () => null });

  it('refuses every delivery: nothing can be verified', async () => {
    const res = await deliver(t, { event: 'endpoint.url_validation', payload: { plainToken: 'abc' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'not_configured' });
  });
});

describeDb('POST /callbacks/zoom/events reads the webhook secret through getSecret (QOR-4576)', () => {
  const asked: string[] = [];
  let current: string | Error = 'first-secret';
  const lines: string[] = [];
  const t = useZoomApp({
    zoom: ZOOM,
    getSecret: async (name) => {
      asked.push(name);
      if (current instanceof Error) throw current;
      return current;
    },
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });
  const validate = { event: 'endpoint.url_validation', payload: { plainToken: 'abc' } };

  it('asks for zoom.webhook_secret on every delivery, so a rotated secret is used at once', async () => {
    expect((await deliver(t, validate, { secret: 'first-secret' })).statusCode).toBe(200);
    current = 'rotated-secret';
    expect((await deliver(t, validate, { secret: 'first-secret' })).statusCode).toBe(401);
    expect((await deliver(t, validate, { secret: 'rotated-secret' })).statusCode).toBe(200);
    expect(asked).toEqual(['zoom.webhook_secret', 'zoom.webhook_secret', 'zoom.webhook_secret']);
  });

  it('answers 503 secret_unavailable when the store cannot be read, logging the code only', async () => {
    current = new Error('store down: leaky-detail');
    const res = await deliver(t, validate, { secret: 'rotated-secret' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'secret_unavailable' });
    const log = lines.join('');
    expect(log).toContain('"event":"zoom.secret_unavailable"');
    expect(log).not.toContain('leaky-detail');
    expect(log).not.toContain('rotated-secret');
  });
});

describeDb('POST /callbacks/zoom/events asks the secret store only for a delivery shaped like Zoom’s (QOR-4576)', () => {
  const asked: string[] = [];
  // The store is down: an answer of 401, not 503, shows it was never asked.
  const t = useZoomApp({
    zoom: ZOOM,
    getSecret: async (name) => {
      asked.push(name);
      throw new Error('store down');
    },
  });
  const validate = { event: 'endpoint.url_validation', payload: { plainToken: 'abc' } };
  const now = () => Math.floor(Date.now() / 1000);
  const hex64 = 'a'.repeat(64);

  it('refuses 401 without asking: no or malformed signature, no, malformed or stale timestamp', async () => {
    asked.length = 0;
    for (const [why, options] of [
      ['unsigned', { signature: null }],
      ['short hex', { signature: 'v0=abc' }],
      ['other scheme', { signature: `v1=${hex64}` }],
      ['not hex', { signature: `v0=${'z'.repeat(64)}` }],
      ['six minutes old', { at: now() - 360, signature: `v0=${hex64}` }],
      ['six minutes ahead', { at: now() + 360, signature: `v0=${hex64}` }],
    ] as const) {
      const res = await deliver(t, validate, options);
      expect(res.statusCode, why).toBe(401);
      expect(res.json(), why).toEqual({ error: 'unauthorized' });
    }
    for (const timestamp of [undefined, 'soon']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/callbacks/zoom/events',
        headers: { 'content-type': 'application/json', 'x-zm-signature': `v0=${hex64}`, ...(timestamp ? { 'x-zm-request-timestamp': timestamp } : {}) },
        payload: JSON.stringify(validate),
      });
      expect(res.statusCode, String(timestamp)).toBe(401);
    }
    expect(asked).toEqual([]);
  });

  it('asks for a fresh, well-formed one, whose HMAC only the secret can check', async () => {
    asked.length = 0;
    const res = await deliver(t, validate, { signature: `v0=${hex64}` });
    expect(res.statusCode).toBe(503);
    expect(asked).toEqual(['zoom.webhook_secret']);
  });
});

describeDb('POST /callbacks/zoom/events logs (QOR-4576)', () => {
  const t = useAutoJoinApp({ zoom: { ...ZOOM, requireHost: true }, autoJoinCacheMs: 0 });
  const { lines } = t;

  it('records event types and outcomes, never the payload, topic, names, emails, meeting or tokens', async () => {
    await readyBusyBot(t);
    const object = {
      id: 987654321,
      uuid: 'Zq9/uuid+leak==',
      host_id: 'hostleakid',
      host_email: 'host.leak@example.com',
      topic: 'Topic leak: acquisition of Initech',
      start_time: new Date().toISOString(),
      participant: { id: 'hostleakid', user_name: 'Leaky McName', email: 'leaky@example.com' },
    };
    storedSwitch(t).value = true;
    await deliver(t, { event: 'endpoint.url_validation', payload: { plainToken: 'plainleaktoken' } });
    await deliver(t, zoomEvent('meeting.started', object));
    expect(await autoJoined(t, zoomEvent('meeting.participant_joined', object))).toBe('claim_opened');
    await deliver(t, zoomEvent('meeting.ended', object));
    await deliver(t, zoomEvent('meeting.ended', object), { secret: 'wrong' });
    await deliver(t, zoomEvent('webinar.leaky_type_name', object));

    const log = lines.join('');
    for (const event of ['zoom.url_validation', 'zoom.handled', 'zoom.rejected', 'claim.released']) {
      expect(log).toContain(`"event":"${event}"`);
    }
    expect(log).toContain('"outcome":"waiting_for_host"');
    expect(log).toContain('"kind":"other"');
    for (const secret of [
      '987654321',
      'uuid+leak',
      'hostleakid',
      'host.leak@example.com',
      'Topic leak',
      'Leaky McName',
      'leaky@example.com',
      'plainleaktoken',
      'leaky_type_name',
      ZOOM_SECRET,
      'x-zm-signature',
    ]) {
      expect(log, secret).not.toContain(secret);
    }
  });
});
