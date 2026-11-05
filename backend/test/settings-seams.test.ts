import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { ZOOM_SECRET_ENV, type ZoomConfig } from '../src/config.ts';
import { SECRET } from '../src/secret-names.ts';
import { localSecretStore, withEnvFallback, type SecretStore } from '../src/secrets/store.ts';
import { registerBot, until } from './app.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, useRoles } from './people.ts';
import { deliver, zoomEvent } from './zoom.ts';

const ENV_SECRET = 'zoom-secret-from-the-env';
const STORED_SECRET = 'zoom-secret-from-the-store';
const validation = () => ({ event: 'endpoint.url_validation', payload: { plainToken: 'plain-token' }, event_ts: Date.now() });

describeDb('the Zoom webhook secret reads the secret store, the env its fallback (QOR-4576, QOR-4578)', () => {
  let store: SecretStore | undefined;
  // No getSecret given: the server's own seam, over the suite's store, is under test.
  const t = useRoles({
    secrets: (pool) => (store = withEnvFallback(localSecretStore(pool, randomBytes(32)), ZOOM_SECRET_ENV, { BWAT_ZOOM_WEBHOOK_SECRET: ENV_SECRET })),
  });

  it('verifies with the env secret while nothing is stored, then with the stored one, which overrides it', async () => {
    expect((await deliver(t, validation(), { secret: ENV_SECRET })).statusCode).toBe(200);
    expect((await deliver(t, validation(), { secret: STORED_SECRET })).statusCode).toBe(401);

    await store!.put(SECRET.zoomWebhookSecret, STORED_SECRET);
    const res = await deliver(t, validation(), { secret: STORED_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json().plainToken).toBe('plain-token');
    expect((await deliver(t, validation(), { secret: ENV_SECRET })).statusCode).toBe(401);
  });
});

describeDb('the auto-join switch reads the stored settings, and a save is seen at once (QOR-4576, QOR-4578)', () => {
  const ON: ZoomConfig = { autoJoin: true, requireHost: false };
  // The default cache (60 s) and the server's own reader: only an invalidation shows the save.
  const zoom = fakeZoom();
  const t = useRoles({ zoom: ON, getSecret: zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S }), zoomFetch: zoom.fetch });
  const started = (uuid: string) =>
    zoomEvent('meeting.started', { id: 260000001, uuid, host_id: 'host-1', topic: 'Weekly', start_time: new Date().toISOString() });

  it('explicit off stays off until an admin enables ready automatic joining', async () => {
    await registerBot(t);
    await t.pool.query(`INSERT INTO settings (key, value, revision) VALUES ('auto_join_enabled', 'false', 1)`);

    expect((await deliver(t, started('occ-fresh'))).json()).toEqual({ status: 'switched_off' });
    // The delivery is recorded as evidence after Zoom is answered; enabling needs it.
    const recorded = async () => (await t.pool.query(`SELECT 1 FROM auto_join_delivery`)).rowCount === 1;
    expect(await until(recorded)).toBe(true);

    const saved = await t.app.inject({
      method: 'PUT',
      url: '/console/settings/joining',
      headers: ADMIN,
      payload: { changes: { auto_join_enabled: { value: true, expectedRevision: 1 } } },
    });
    expect(saved.statusCode).toBe(200);

    // Joined once Zoom, looked up after the answer, says the meeting records.
    expect((await deliver(t, started('occ-after-save'))).json()).toEqual({ status: 'meeting_lookup' });
    const claimed = async () => (await t.pool.query(`SELECT 1 FROM claims WHERE meeting_number = '260000001'`)).rowCount === 1;
    expect(await until(claimed)).toBe(true);
  });
});
