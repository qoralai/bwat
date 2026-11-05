import { beforeEach, expect, it } from 'vitest';
import type { ZoomConfig } from '../src/config.ts';
import { botPost, heldClaim, occurrenceUuid, PERSON, resetAllocationsBeforeEach, signedIn, until } from './app.ts';
import { describeDb } from './db/harness.ts';
import { ZOOM_S2S } from './fake-zoom.ts';
import { useAutoJoinApp } from './zoom.ts';

const ON: ZoomConfig = { autoJoin: true, requireHost: false };

/**
 * The board names a meeting by its Zoom topic and shows its host, as the prototype board
 * did: once the bot reports where it is, the backend asks Zoom ("Get a meeting") and keeps both.
 */
describeDb('a meeting takes its title and host from Zoom once the bot is in it', () => {
  const t = useAutoJoinApp({ authenticatePerson: signedIn, zoom: ON, autoJoinCacheMs: 0 });
  const { zoom, secrets } = t;
  resetAllocationsBeforeEach(t);
  beforeEach(() => {
    secrets.values = { ...ZOOM_S2S };
    zoom.calls.length = 0;
    zoom.answer = undefined;
  });

  const listed = async (occurrence: string) =>
    (await t.app.inject({ method: 'GET', url: '/meetings', headers: PERSON }))
      .json()
      .meetings.find((m: { occurrence_id: string }) => m.occurrence_id === occurrence);

  it('lists the meeting under its Zoom topic, with its host', async () => {
    const { bot, claimId } = await heldClaim(t, '230000001');
    const uuid = occurrenceUuid();
    const res = await botPost(t, '/assignment/occurrence', bot.bot_token, { claim_id: claimId, generation: 1, occurrence_uuid: uuid });
    expect(res.statusCode).toBe(200);
    expect(await until(async () => (await listed(uuid))?.title !== null)).toBe(true);
    expect(await listed(uuid)).toMatchObject({ title: 'Quarterly numbers', host_email: 'grace@example.com' });
    expect(zoom.apiCalls().map((c) => c.url)).toContain('https://api.zoom.us/v2/meetings/230000001');
  });

  it('keeps the title from the joined SDK session without requiring a REST lookup', async () => {
    secrets.values = {};
    const { bot, claimId } = await heldClaim(t, '230000002');
    const uuid = occurrenceUuid();
    const report = (meeting_title: unknown, occurrence_uuid = uuid) => botPost(t, '/assignment/occurrence', bot.bot_token,
      { claim_id: claimId, generation: 1, occurrence_uuid, meeting_title });
    expect((await report('  daily\n artifact temp meet  ')).statusCode).toBe(200);
    expect(await listed(uuid)).toMatchObject({ title: 'daily artifact temp meet', host_email: null });
    expect((await report(null)).statusCode).toBe(200);
    expect((await report({ malformed: true })).statusCode).toBe(200);
    expect((await report('invalid\0title')).statusCode).toBe(200);
    expect((await report('   ')).statusCode).toBe(200);
    expect(await listed(uuid)).toMatchObject({ title: 'daily artifact temp meet' });
    expect((await botPost(t, '/assignment/occurrence', bot.bot_token,
      { claim_id: claimId, generation: 0, occurrence_uuid: uuid, meeting_title: 'Stale caller' })).statusCode).toBe(409);
    expect(await listed(uuid)).toMatchObject({ title: 'daily artifact temp meet' });
    expect((await report('Other meeting', occurrenceUuid())).statusCode).toBe(409);
    expect(await listed(uuid)).toMatchObject({ title: 'daily artifact temp meet' });
  });

  it('does not allow the later REST lookup to replace the SDK title', async () => {
    const { bot, claimId } = await heldClaim(t, '230000003');
    const uuid = occurrenceUuid();
    await botPost(t, '/assignment/occurrence', bot.bot_token,
      { claim_id: claimId, generation: 1, occurrence_uuid: uuid, meeting_title: 'Actual meeting title' });
    expect(await until(async () => (await listed(uuid))?.host_email === 'grace@example.com')).toBe(true);
    expect(await listed(uuid)).toMatchObject({ title: 'Actual meeting title', host_email: 'grace@example.com' });
  });

  it('fills an existing unnamed meeting and bounds the reported title', async () => {
    secrets.values = {};
    const { bot, claimId } = await heldClaim(t, '230000004');
    const uuid = occurrenceUuid();
    const body = { claim_id: claimId, generation: 1, occurrence_uuid: uuid };
    expect((await botPost(t, '/assignment/occurrence', bot.bot_token, body)).statusCode).toBe(200);
    expect(await listed(uuid)).toMatchObject({ title: null });
    expect((await botPost(t, '/assignment/occurrence', bot.bot_token, { ...body, meeting_title: '😀'.repeat(201) })).statusCode).toBe(200);
    expect(await listed(uuid)).toMatchObject({ title: '😀'.repeat(200) });
    const version = async () => (await t.pool.query('SELECT xmin::text AS version FROM meetings WHERE occurrence_uuid = $1', [uuid])).rows[0].version;
    const before = await version();
    await botPost(t, '/assignment/occurrence', bot.bot_token, { ...body, meeting_title: '😀'.repeat(201) });
    await botPost(t, '/assignment/occurrence', bot.bot_token, body);
    expect(await version()).toBe(before);
  });

  it('keeps an existing REST title when the SDK later reports a different title', async () => {
    const { bot, claimId } = await heldClaim(t, '230000005');
    const uuid = occurrenceUuid();
    const body = { claim_id: claimId, generation: 1, occurrence_uuid: uuid };
    await botPost(t, '/assignment/occurrence', bot.bot_token, body);
    expect(await until(async () => (await listed(uuid))?.title === 'Quarterly numbers')).toBe(true);
    await botPost(t, '/assignment/occurrence', bot.bot_token, { ...body, meeting_title: 'Different SDK title' });
    expect(await listed(uuid)).toMatchObject({ title: 'Quarterly numbers' });
  });
});
