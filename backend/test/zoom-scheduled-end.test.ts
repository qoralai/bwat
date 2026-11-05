import { readyBusyBot } from './zoom-readiness-fixture.ts';
import { beforeEach, expect, it } from 'vitest';
import type { ZoomConfig } from '../src/config.ts';
import { bearer, registerBot, resetAllocationsBeforeEach, signedIn } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_APP, ZOOM_S2S } from './fake-zoom.ts';
import { autoJoined, storedSwitch, useAutoJoinApp, zoomEvent } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };
const START = '2026-10-19T15:25:27Z';

const started = (id: string, uuid: string, schedule: Record<string, unknown>) =>
  zoomEvent('meeting.started', { id, uuid, host_id: 'host-1', topic: 'Weekly sync', start_time: START, ...schedule });

describeDb("a meeting's scheduled end reaches its bot on the assignment", () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  resetAllocationsBeforeEach(t);
  beforeEach(() => readyBusyBot(t));
  beforeEach(() => {
    storedSwitch(t).value = true;
    t.secrets.values = { ...ZOOM_APP, ...ZOOM_S2S };
    t.zoom.passcode = 'looked-up-pass';
  });

  const briefing = async (meeting: string, schedule: Record<string, unknown>) => {
    const bot = await registerBot(t);
    expect(await autoJoined(t, started(meeting, `occ-${meeting}==`, schedule))).toBe('claim_opened');
    const assignment = (await t.app.inject({ method: 'GET', url: '/assignment', headers: bearer(bot.bot_token) })).json();
    return assignment.briefing;
  };

  it('is the start plus the scheduled duration, for a one-off meeting and a recurring one at a fixed time', async () => {
    expect(await briefing('270000001', { type: 2, duration: 30 })).toEqual({
      passcode: 'looked-up-pass',
      scheduled_end: '2026-10-19T15:55:27.000Z',
    });
    expect((await briefing('270000002', { type: 8, duration: 45 })).scheduled_end).toBe('2026-10-19T16:10:27.000Z');
  });

  it('is absent for any other kind of meeting: an instant one, a recurring one with no fixed time, a personal room', async () => {
    for (const [meeting, type] of [['270000003', 1], ['270000004', 3], ['270000005', 4], ['270000006', undefined]] as const) {
      expect(await briefing(meeting, { type, duration: 30 }), String(type)).toEqual({ passcode: 'looked-up-pass' });
    }
  });
});
