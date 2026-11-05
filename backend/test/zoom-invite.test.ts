import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { describeDb } from './db/harness.ts';
import { ADMIN, ADMIN_ID, MEMBER, MEMBER_ID, useRoles } from './people.ts';
import { botPost, registerBot, resetAllocations } from './app.ts';
import { ZOOM_S2S } from './fake-zoom.ts';
import { endMeeting, inviteOccurrence, lockMeeting } from '../src/claims.ts';

const SECRET = 'board-test-secret';
function context(mid: string | null, more: object = {}) {
  const iv = randomBytes(12), aad = Buffer.from('zoom');
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(SECRET).digest(), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ uid: 'viewer', mid, ts: Date.now(), exp: Date.now() + 60000, ...more })), cipher.final()]);
  const a = Buffer.alloc(2), b = Buffer.alloc(4);
  a.writeUInt16LE(aad.length); b.writeUInt32LE(encrypted.length);
  return Buffer.concat([Buffer.from([iv.length]), iv, a, aad, b, encrypted, cipher.getAuthTag()]).toString('base64url');
}

describeDb('invite the current Zoom meeting bot without a pasted link', () => {
  let occurrence = '', apiCalls: string[] = [], lookupStatus = 200;
  const t = useRoles({
    getSecret: async name => name === 'zoom.board_client_secret' ? SECRET : (ZOOM_S2S as Record<string, string>)[name] ?? null,
    zoomFetch: async (input) => {
      const url = String(input); apiCalls.push(url);
      // Reproduce observed Zoom 404s: once-encoded pluses and slashes lose their
      // identity during Zoom's extra decoding/routing, before meeting lookup.
      if (/%2[BF]/i.test(new URL(url).pathname)) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(url.includes('/oauth/token') ? { access_token: 'test', expires_in: 3600 } :
        { id: 230000001, uuid: occurrence, password: 'private-passcode' }), { status: url.includes('/oauth/token') ? 200 : new URL(url).searchParams.get('type') === 'live' ? lookupStatus : 404 });
    },
  });
  beforeEach(async () => {
    await resetAllocations(t);
    await t.pool.query('UPDATE members SET zoom_user_id = $1 WHERE id = $2', ['viewer', MEMBER_ID]);
    occurrence = randomBytes(16).toString('base64'); apiCalls = []; lookupStatus = 200;
  });
  const call = (invite = false, ctx = context(occurrence), headers = MEMBER) => t.app.inject({
    method: 'POST', url: '/zoom/meeting-bot', headers, payload: { context: ctx, invite },
  });
  it('reports absent without Zoom calls; an ordinary member invites once even with concurrent clicks', async () => {
    expect((await call()).json()).toMatchObject({ state: 'absent', can_invite: true });
    expect(apiCalls).toHaveLength(0);
    const responses = await Promise.all([call(true), call(true)]);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: 'queued', can_invite: false });
      expect(response.body).not.toContain('private-passcode');
    }
    const rows = (await t.pool.query('SELECT briefing FROM claims WHERE occurrence_uuid = $1', [occurrence])).rows;
    expect(rows).toEqual([{ briefing: { passcode: 'private-passcode' } }]);
  });
  it('requires matching signed Zoom identity, valid context and a main meeting', async () => {
    expect((await call(true, context(occurrence), {} as typeof MEMBER)).statusCode).toBe(401);
    expect((await call(true, 'tampered')).statusCode).toBe(400);
    expect((await call(true, context(occurrence, { uid: 'someone-else' }))).statusCode).toBe(403);
    expect((await call(true, context(occurrence, { exp: 1 }))).statusCode).toBe(400);
    expect((await call(true, context(occurrence, { bmid: 'breakout' }))).json().state).toBe('breakout');
    expect((await call(true, context(null))).json().state).toBe('outside_meeting');
    expect(apiCalls).toHaveLength(0);
  });
  it('reports joining, waiting, presence and stale status; allows a deliberate reinvite after departure', async () => {
    const bot = await registerBot(t);
    expect((await call(true)).json().state).toBe('joining');
    await t.pool.query(`UPDATE bots SET last_heartbeat = now(), status = '{"state":"waiting_room","joined":false}' WHERE id = $1`, [bot.bot_id]);
    expect((await call()).json().state).toBe('waiting_room');
    await t.pool.query(`UPDATE bots SET status = '{"state":"in_meeting","joined":true}' WHERE id = $1`, [bot.bot_id]);
    // A bot's leftover report alone is not proof it joined this claim.
    expect((await call()).json().state).toBe('joining');
    await t.pool.query(`UPDATE claims SET state = 'attending', joined_at = '2026-10-21T10:02:00Z' WHERE occurrence_uuid = $1`, [occurrence]);
    // When it joined, for the board's "bwat joined at".
    expect((await call()).json()).toMatchObject({ state: 'present', joined_at: '2026-10-21T10:02:00.000Z' });
    await t.pool.query(`UPDATE bots SET last_heartbeat = now() - interval '50 seconds' WHERE id = $1`, [bot.bot_id]);
    expect((await call()).json()).toMatchObject({ state: 'checking', can_invite: false });
    await t.pool.query(`UPDATE claims SET state = 'done', ended_at = now(), refused_reason = 'removed' WHERE occurrence_uuid = $1`, [occurrence]);
    expect((await call()).json().can_invite).toBe(true);
    expect((await call(true)).json().state).toBe('queued');
    expect((await t.pool.query('SELECT count(*)::int AS n FROM claims WHERE occurrence_uuid = $1', [occurrence])).rows[0].n).toBe(2);
  });
  it('does not invite when Zoom lookup fails', async () => {
    lookupStatus = 403;
    expect((await call(true)).statusCode).toBe(503);
    expect((await t.pool.query('SELECT id FROM claims WHERE occurrence_uuid = $1', [occurrence])).rowCount).toBe(0);
  });
  it('only an admin or the signed current host may recall this occurrence', async () => {
    await call(true);
    const leave = (ctx: string, headers = MEMBER) => t.app.inject({ method: 'POST', url: '/zoom/meeting-bot', headers, payload: { context: ctx, leave: true } });
    expect((await leave(context(occurrence))).statusCode).toBe(403);
    expect((await leave(context(occurrence, { attendrole: 'co-host' }))).statusCode).toBe(403);
    expect((await leave(context(occurrence, { attendrole: 'host', ts: Date.now() - 31_000 }))).statusCode).toBe(403);
    expect((await leave(context(occurrence, { attendrole: 'host', exp: 1 }))).statusCode).toBe(400);
    const claim = (await t.pool.query('SELECT id FROM claims WHERE occurrence_uuid = $1', [occurrence])).rows[0];
    expect((await t.app.inject({ method: 'PATCH', url: `/allocations/${claim.id}`, headers: MEMBER, payload: { recall: true } })).statusCode).toBe(403);
    expect((await leave(context('another-meeting', { attendrole: 'host' }))).statusCode).toBe(200);
    expect((await call()).json().state).toBe('queued');
    expect((await leave(context(occurrence, { attendrole: 'host' }))).json().state).toBe('leaving');
    expect((await t.pool.query('SELECT refused_reason FROM claims WHERE id = $1', [claim.id])).rows[0].refused_reason).toBe('recalled');
    await call(true);
    await t.pool.query('UPDATE members SET zoom_user_id = $1 WHERE id = $2', ['admin-viewer', ADMIN_ID]);
    expect((await leave(context(occurrence, { uid: 'admin-viewer' }), ADMIN)).json().state).toBe('leaving');
  });
  it('double-encodes a plus in the signed meeting UUID', async () => {
    occurrence = 'example+meeting+uuid==';
    expect((await call(true)).statusCode).toBe(200);
    expect(apiCalls).toContain('https://api.zoom.us/v2/meetings/example%252Bmeeting%252Buuid%253D%253D?type=live');
  });
  it.each(['in_meeting', 'joining', 'waiting_room'])('holds reinvites while a recalled bot is still %s', async state => {
    const bot = await registerBot(t);
    await call(true);
    await t.pool.query('UPDATE bots SET last_heartbeat = now(), status = $2 WHERE id = $1', [bot.bot_id, { state, joined: state === 'in_meeting' }]);
    const leave = await t.app.inject({ method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER,
      payload: { context: context(occurrence, { attendrole: 'host' }), leave: true } });
    expect(leave.json().state).toBe('leaving');
    expect((await call()).json()).toMatchObject({ state: 'leaving', can_invite: false });
    expect((await call(true)).json()).toMatchObject({ state: 'leaving', can_invite: false });
    // An invite that already passed its status read must also be refused inside the transaction.
    expect(await inviteOccurrence(t.pool, { meetingNumber: '230000001', occurrenceUuid: occurrence, briefing: {} })).toMatchObject({ error: 'bot_leaving' });
    expect((await t.pool.query('SELECT id FROM claims WHERE occurrence_uuid = $1', [occurrence])).rowCount).toBe(1);
    expect((await botPost(t, '/assignment/heartbeat', bot.bot_token, { state: 'idle', joined: false })).statusCode).toBe(200);
    expect((await call()).json()).toMatchObject({ state: 'absent', can_invite: true });
    expect((await call(true)).json().state).toBe('joining');
  });
  it('bounds recall waiting when the bot never reports again', async () => {
    await registerBot(t);
    await call(true);
    await t.app.inject({ method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER,
      payload: { context: context(occurrence, { attendrole: 'host' }), leave: true } });
    expect((await call()).json().state).toBe('leaving');
    await t.pool.query(`UPDATE claims SET ended_at = now() - interval '91 seconds' WHERE occurrence_uuid = $1`, [occurrence]);
    expect((await call()).json()).toMatchObject({ state: 'absent', can_invite: true });
  });
  it.each([
    'plainMeetingUuid==',
    'plainMeetingUuid=',
    'middle/slash==',
    '/leadingSlash==',
    'double//slash==',
    'mixed+plus/slash==',
    'url_safe-uuid',
  ])('invites and preserves the exact occurrence for UUID %s', async (uuid) => {
    occurrence = uuid;
    const response = await call(true);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'queued', occurrence_id: uuid });
    expect(response.body).not.toContain('private-passcode');
    expect((await t.pool.query('SELECT occurrence_uuid, meeting_number FROM claims WHERE occurrence_uuid = $1', [uuid])).rows).toEqual([
      { occurrence_uuid: uuid, meeting_number: '230000001' },
    ]);
  });
  it("records the panel viewer's own participant id for an attended meeting only", async () => {
    const status = (participant_id: unknown) => t.app.inject({
      method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER, payload: { context: context(occurrence), participant_id },
    });
    const speakers = async () => (await t.pool.query(
      'SELECT speaker_zoom_id, zoom_user_id, conflicted FROM zoom_speakers WHERE occurrence_uuid = $1 ORDER BY speaker_zoom_id', [occurrence])).rows;
    expect((await status('16778240')).json().state).toBe('absent');
    expect(await speakers()).toEqual([]);
    await call(true);
    expect((await status('16778240')).statusCode).toBe(200);
    expect((await status('0')).statusCode).toBe(200);
    expect((await status('4294967296')).statusCode).toBe(200);
    expect((await status('a-participant-id-zoom-may-one-day-send')).json().state).toBe('queued');
    expect(await speakers()).toEqual([{ speaker_zoom_id: '16778240', zoom_user_id: 'viewer', conflicted: false }]);
    await t.pool.query(`INSERT INTO zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id) VALUES ($1, '16779264', 'zoom-other')`, [occurrence]);
    await status('16779264');
    // The panel's participant id is the client's word: it never changes a mapping already stored.
    expect((await speakers())[1]).toEqual({ speaker_zoom_id: '16779264', zoom_user_id: 'zoom-other', conflicted: false });
  });
  it("does not take the meeting's lock again once the participant id is mapped", async () => {
    const status = (participant_id: string) => t.app.inject({
      method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER, payload: { context: context(occurrence), participant_id },
    });
    await call(true);
    await status('16778240');
    await t.pool.query(`INSERT INTO zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id, conflicted) VALUES ($1, '16779264', 'zoom-other', false)`, [occurrence]);
    const holder = await t.pool.connect();
    try {
      await holder.query('BEGIN');
      await lockMeeting(holder, '230000001');
      for (const id of ['16778240', '16779264']) {
        const answered = await Promise.race([status(id).then(r => r.statusCode), new Promise(r => setTimeout(() => r('blocked'), 1000))]);
        expect(answered).toBe(200);
      }
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
  it('leaves a mapping alone that Zoom stored while the panel was waiting for the lock', async () => {
    await call(true);
    const holder = await t.pool.connect();
    let polled;
    try {
      await holder.query('BEGIN');
      await lockMeeting(holder, '230000001');
      polled = t.app.inject({ method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER,
        payload: { context: context(occurrence), participant_id: '16780288' } });
      await new Promise(r => setTimeout(r, 300));
      await t.pool.query(`INSERT INTO zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id) VALUES ($1, '16780288', 'zoom-other')`, [occurrence]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await polled).statusCode).toBe(200);
    expect((await t.pool.query(`SELECT zoom_user_id, conflicted FROM zoom_speakers WHERE occurrence_uuid = $1`, [occurrence])).rows)
      .toEqual([{ zoom_user_id: 'zoom-other', conflicted: false }]);
  });
  it('answers the status check when recording the viewer fails', async () => {
    await call(true);
    const owner = await t.db.connect('owner');
    try {
      await owner.query(`CREATE FUNCTION bwat.refuse_speaker() RETURNS trigger LANGUAGE plpgsql AS $$
                           BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END $$`);
      await owner.query(`CREATE TRIGGER refuse_speaker BEFORE INSERT ON bwat.zoom_speakers
                           FOR EACH ROW EXECUTE FUNCTION bwat.refuse_speaker()`);
      const res = await t.app.inject({
        method: 'POST', url: '/zoom/meeting-bot', headers: MEMBER, payload: { context: context(occurrence), participant_id: '16778240' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().state).toBe('queued');
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS refuse_speaker ON bwat.zoom_speakers`);
      await owner.query(`DROP FUNCTION IF EXISTS bwat.refuse_speaker()`);
      await owner.end();
    }
  });
  it('double-encodes special UUIDs and never reopens an ended meeting', async () => {
    occurrence = '/A//B+C==';
    expect((await call(true)).statusCode).toBe(200);
    expect(apiCalls).toContain('https://api.zoom.us/v2/meetings/%252FA%252F%252FB%252BC%253D%253D?type=live');
    await endMeeting(t.pool, { meetingNumber: '230000001', occurrenceUuid: occurrence, deliveryKey: randomBytes(32), drainSeconds: 1 });
    expect((await call(true)).json()).toMatchObject({ state: 'ended', can_invite: false });
  });
});
