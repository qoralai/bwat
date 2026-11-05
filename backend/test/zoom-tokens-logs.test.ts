import { expect, it } from 'vitest';
import type { ZoomConfig } from '../src/config.ts';
import { botPost, heldClaim, registerBot, signedIn, until } from './app.ts';
import { describeDb } from './db/harness.ts';
import { fakeZoom, ZOOM_APP, ZOOM_S2S, zoomSecrets } from './fake-zoom.ts';
import { deliver, storedSwitch, useZoomApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

describeDb('Zoom tokens and the meeting lookup: what they log (QOR-4581)', () => {
  const secrets = zoomSecrets({ ...ZOOM_APP, ...ZOOM_S2S });
  const zoom = fakeZoom();
  const lines: string[] = [];
  const t = useZoomApp({
    authenticatePerson: signedIn,
    zoom: ON,
    autoJoinCacheMs: 0,
    getSecret: secrets,
    zoomFetch: zoom.fetch,
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });

  it('logs events, ids and codes only: never a credential, a token or a passcode', async () => {
    storedSwitch(t).value = true;
    zoom.passcode = 'leakypasscode';
    const { bot, claimId } = await heldClaim(t, '270000001');
    const minted = (await botPost(t, '/assignment/join-token', bot.bot_token, { claim_id: claimId, generation: 1 })).json();
    expect(minted.recording_token).toBe('recording-270000001');
    zoom.answer = (call) => (call.url.startsWith('https://api.') ? { status: 503 } : undefined);
    const failed = (await botPost(t, '/assignment/join-token', bot.bot_token, { claim_id: claimId, generation: 1 })).json();
    expect(failed.recording_token_error).toBe('zoom_unavailable');
    zoom.answer = undefined;

    await registerBot(t);
    await deliver(t, zoomEvent('meeting.started', { id: '270000002', uuid: 'occ-G1==', host_id: 'h', start_time: new Date().toISOString() }));
    expect(await until(async () => lines.some((l) => l.includes('"zoom.meeting_lookup"')))).toBe(true);
    expect(lines.join('\n')).toContain('"outcome":"claim_opened"');

    const logged = lines.join('\n');
    for (const secret of [
      ...Object.values(ZOOM_APP).filter((v) => v.includes('secret')),
      ZOOM_S2S['zoom.s2s_client_secret'],
      'access-1',
      'recording-270000001',
      minted.sdk_jwt,
      minted.sdk_jwt.split('.')[2],
      'leakypasscode',
      'Basic ',
      'Bearer ',
    ]) {
      expect(logged, secret).not.toContain(secret);
    }
    expect(logged).toContain('"event":"zoom.join_token"');
    expect(logged).toContain('"event":"zoom.unavailable"');
  });
});
