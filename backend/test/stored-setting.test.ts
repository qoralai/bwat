import { expect, it } from 'vitest';
import { SETTINGS } from '../src/settings/catalogue.ts';
import { readStoredSetting } from '../src/settings/store.ts';
import { describeDb } from './db/harness.ts';
import { ADMIN, useRoles } from './people.ts';
import { registerBot } from './app.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';
import { deliver, zoomEvent } from './zoom.ts';

// The zoom track's readAutoJoinSwitch is this reader: the raw stored value, never the
// catalogue default, so an explicit off choice remains distinguishable from unset.
describeDb('readStoredSetting (QOR-4578)', () => {
  const zoom = fakeZoom();
  const t = useRoles({ getSecret: zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S }), zoomFetch: zoom.fetch });
  const save = (value: unknown, expectedRevision: number | null) =>
    t.app.inject({
      method: 'PUT',
      url: '/console/settings/joining',
      headers: ADMIN,
      payload: { changes: { auto_join_enabled: { value, expectedRevision } } },
    });

  it('reads undefined for a key never saved, never the catalogue default', async () => {
    expect(SETTINGS.find((s) => s.key === 'auto_join_enabled')?.codeDefault).toBe(false);
    expect(await readStoredSetting(t.pool, 'auto_join_enabled')).toBeUndefined();
  });

  it('reads the saved value, and JSON null once it is reset to the default', async () => {
    await registerBot(t);
    await deliver(t, zoomEvent('meeting.ended', { id: 98765432001, uuid: 'ended' }));
    expect((await save(false, null)).statusCode).toBe(200);
    expect(await readStoredSetting(t.pool, 'auto_join_enabled')).toBe(false);
    expect((await save(true, 1)).statusCode).toBe(200);
    expect(await readStoredSetting(t.pool, 'auto_join_enabled')).toBe(true);
    expect((await save(null, 2)).statusCode).toBe(200);
    expect(await readStoredSetting(t.pool, 'auto_join_enabled')).toBeNull();
  });
});
