import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { endMeeting } from '../src/claims.ts';
import { start } from '../src/server.ts';
import { apiBase, PERSON, postAllocation, resetAllocationsBeforeEach, signedIn, useApp, type TestApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { botInMeeting, meetingIdOf, pushTranscript, segment } from './meetings.ts';
import { envWithoutDb, runNpmScript } from './npm-script.ts';

/** Members by role (QOR-4575): admin means owner or admin, read from members. */
const ADMIN_ID = '00000000-0000-4000-8000-0000000000ad';
const OWNER_ID = '00000000-0000-4000-8000-0000000000ae';
const MEMBER_ID = '00000000-0000-4000-8000-0000000000af';
const as = (id: string) => ({ authorization: `Member ${id}` });
const ADMIN = as(ADMIN_ID);
const ADA = '00000000-0000-4000-8000-00000000ada0';
const BOB = '00000000-0000-4000-8000-00000000b0b0';

/** Two meetings: in each, Ada speaks linked and once unlinked under her label, and Bob speaks. */
async function seed(t: TestApp, tag: string) {
  await t.pool.query(`DELETE FROM meetings`);
  const ids: Record<string, string> = {};
  for (const [n, number] of [
    ['one', '933444551'],
    ['two', '933444552'],
  ] as const) {
    const occurrence = `${tag}-${n}`;
    const bot = await botInMeeting(t, occurrence, number);
    await pushTranscript(t, occurrence, bot.bot_token, {
      epoch: 1,
      segments: [
        segment(0, { speaker_label: 'Ada Lovelace', speaker_member_id: ADA, text: `ada ${n}` }),
        segment(1, { speaker_label: 'Ada Lovelace', text: `ada unlinked ${n}` }),
        segment(2, { speaker_label: 'Bob', speaker_member_id: BOB, text: `bob ${n}` }),
        segment(3, { speaker_label: 'Speaker 3', text: `other ${n}` }),
        // Linked to Bob under Ada's name (a mislabel): it is Bob's, but the name is Ada's.
        segment(4, { speaker_label: 'Ada Lovelace', speaker_member_id: BOB, text: `bob as ada ${n}` }),
        // Chat is meeting content too: Ada's chat line goes with her speech.
        segment(5, { source: 'chat', speaker_label: 'Ada Lovelace', speaker_member_id: ADA, text: `ada chat ${n}` }),
        segment(6, { source: 'chat', speaker_label: 'Bob', speaker_member_id: BOB, text: `bob chat ${n}` }),
      ],
    });
    ids[n] = await meetingIdOf(t, occurrence);
    ids[`${n}-claim`] = bot.claim_id;
  }
  // A third meeting where someone else is labelled "Ada Lovelace" and Ada never spoke linked.
  const occurrence = `${tag}-three`;
  const bot = await botInMeeting(t, occurrence, '933444553');
  await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0, { speaker_label: 'Ada Lovelace', text: 'namesake' })] });
  ids.three = await meetingIdOf(t, occurrence);
  // The claims end, keeping their passcodes, as a real meeting's would.
  await t.pool.query(`UPDATE claims SET briefing = '{"passcode":"p"}', state = 'done', ended_at = now() WHERE id = ANY($1)`, [
    [ids['one-claim'], ids['two-claim']],
  ]);
  return ids;
}

const segmentsOf = async (t: TestApp, meetingId: string) =>
  (
    await t.pool.query(
      `SELECT seq, speaker_label, speaker_member_id, text FROM transcript_segments WHERE meeting_id = $1 ORDER BY epoch, seq`,
      [meetingId],
    )
  ).rows;

describeDb('admin deletes (QOR-4577, legal blocker 3)', () => {
  const lines: string[] = [];
  const t = useApp({
    authenticatePerson: async (req) => {
      const id = req.headers.authorization?.match(/^Member (\S+)$/)?.[1];
      return id ? { id } : signedIn(req);
    },
    logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
  });
  resetAllocationsBeforeEach(t);
  beforeAll(async () => {
    for (const [id, role] of [
      [ADMIN_ID, 'admin'],
      [OWNER_ID, 'owner'],
      [MEMBER_ID, 'member'],
    ]) {
      await t.pool.query(`INSERT INTO members (id, email, role, activated_at) VALUES ($1, $2, $3, now())`, [id, `${role}-deletes@test.invalid`, role]);
    }
  });
  // The audit is append-only, so each test reads only the entries written since it began.
  let since: Date;
  beforeEach(async () => {
    since = (await t.pool.query(`SELECT clock_timestamp() AS at`)).rows[0].at;
  });
  const audits = async () =>
    (
      await t.pool.query(
        `SELECT action, actor_id, target_type, target_id FROM audit
          WHERE at >= $1 AND action = 'meeting.deleted' ORDER BY at`,
        [since],
      )
    ).rows;

  const del = (url: string, headers: Record<string, string> = ADMIN) => t.app.inject({ method: 'DELETE', url, headers });

  it('needs a signed-in owner or admin: a plain member, or someone who is no member, is refused', async () => {
    const ids = await seed(t, 'auth');
    const url = `/meetings/${ids.one}`;
    expect((await del(url, {})).statusCode).toBe(401);
    for (const headers of [PERSON, as(MEMBER_ID)]) {
      const refused = await del(url, headers);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden' });
    }
    expect(await segmentsOf(t, ids.one!)).toHaveLength(7);
    expect(await audits()).toEqual([]);
    // An owner may.
    expect((await del(`/meetings/${ids.one}`, as(OWNER_ID))).statusCode).toBe(200);
    expect(await audits()).toEqual([{ action: 'meeting.deleted', actor_id: OWNER_ID, target_type: 'meeting', target_id: ids.one }]);
  });

  it('deletes one meeting and everything about it, and nothing else', async () => {
    const ids = await seed(t, 'meeting');
    // A claim open for the meeting's next sitting keeps its passcode: its bot still needs it.
    const open = (
      await t.pool.query(
        `INSERT INTO claims (meeting_number, occurrence_uuid, briefing) VALUES ('933444551', 'meeting-one-next', '{"passcode":"p"}') RETURNING id`,
      )
    ).rows[0].id;
    const res = await del(`/meetings/${ids.one}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ meeting_id: ids.one, segments_deleted: 7, claims_cleared: 1 });
    expect((await t.pool.query(`SELECT 1 FROM meetings WHERE id = $1`, [ids.one])).rowCount).toBe(0);
    expect(await segmentsOf(t, ids.one!)).toEqual([]);
    const claims = await t.pool.query(`SELECT id, briefing FROM claims WHERE id = ANY($1) ORDER BY id`, [
      [ids['one-claim'], ids['two-claim'], open],
    ]);
    expect(Object.fromEntries(claims.rows.map((c) => [c.id, c.briefing]))).toEqual({
      [ids['one-claim']!]: {},
      [ids['two-claim']!]: { passcode: 'p' },
      [open]: { passcode: 'p' },
    });
    expect(await segmentsOf(t, ids.two!)).toHaveLength(7);
    expect(await audits()).toEqual([{ action: 'meeting.deleted', actor_id: ADMIN_ID, target_type: 'meeting', target_id: ids.one }]);
    expect((await del(`/meetings/${ids.one}`)).statusCode).toBe(404);
    expect((await del(`/meetings/not-a-uuid`)).statusCode).toBe(404);
  });

  it("has no per-person speech erasure (QOR-4616): an admin's DELETE /members/{id}/speech is 404 and leaves their speech", async () => {
    const ids = await seed(t, 'no-erase');
    const before = await segmentsOf(t, ids.one!);
    expect((await del(`/members/${ADA}/speech`)).statusCode).toBe(404);
    expect(await segmentsOf(t, ids.one!)).toEqual(before);
    expect(before.filter((s) => s.speaker_member_id === ADA)).toHaveLength(2);
    expect(await audits()).toEqual([]);
  });

  /** A meeting its bot is still in: opened by one push, the claim held. */
  async function liveMeeting(occurrence: string, meetingNumber: string) {
    await t.pool.query(`DELETE FROM meetings`);
    const bot = await botInMeeting(t, occurrence, meetingNumber);
    expect((await pushTranscript(t, occurrence, bot.bot_token, { epoch: 1, segments: [segment(0)] })).statusCode).toBe(204);
    return { bot, meetingId: await meetingIdOf(t, occurrence) };
  }
  const endClaims = (meetingNumber: string) =>
    t.pool.query(`UPDATE claims SET state = 'abandoned', ended_at = now(), lease_until = NULL WHERE meeting_number = $1 AND state <> 'done'`, [
      meetingNumber,
    ]);
  const expectRefusedLive = async (meetingId: string) => {
    const res = await del(`/meetings/${meetingId}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'meeting_live' });
    expect(await segmentsOf(t, meetingId)).toHaveLength(1);
  };

  it('refuses 409 meeting_live while a claim is open on the occurrence, and deletes once it ends', async () => {
    const { meetingId } = await liveMeeting('live-delete-occ', '933444556');
    await expectRefusedLive(meetingId);
    expect(await audits()).toEqual([]);
    await endClaims('933444556');
    expect((await del(`/meetings/${meetingId}`)).statusCode).toBe(200);
  });

  it('refuses while the bot still holds its claim after the final push', async () => {
    const { bot, meetingId } = await liveMeeting('live-final-occ', '933444557');
    expect((await pushTranscript(t, 'live-final-occ', bot.bot_token, { epoch: 1, complete: true, segments: [] })).statusCode).toBe(204);
    await expectRefusedLive(meetingId);
  });

  it("refuses while a claim sent to the meeting has no occurrence yet, unless the meeting's end is recorded", async () => {
    const { meetingId } = await liveMeeting('live-pending-occ', '933444558');
    await endClaims('933444558');
    await t.pool.query(`UPDATE bots SET ready_at = NULL`); // no bot: the new claim stays pending
    expect((await postAllocation(t, { zoom_url: 'https://zoom.us/j/933444558' })).statusCode).toBeLessThan(300);
    await expectRefusedLive(meetingId);
    await endMeeting(t.pool, { meetingNumber: '933444558', occurrenceUuid: 'live-pending-occ', deliveryKey: randomBytes(32) });
    expect((await del(`/meetings/${meetingId}`)).statusCode).toBe(200);
  });

  it('logs the event and ids, never a name or a title', async () => {
    const log = lines.join('');
    expect(log).toContain('"event":"meeting.deleted"');
    for (const content of ['Ada Lovelace', 'Bob"', 'ada unlinked', 'ada chat', 'bob chat', 'namesake', '93344455']) expect(log).not.toContain(content);
  });
});

describeDb('npm run delete-meeting (QOR-4577)', () => {
  const t = useApp();
  resetAllocationsBeforeEach(t);

  it('delete-meeting deletes one meeting as the runtime role and prints the counts', async () => {
    const ids = await seed(t, 'cli-meeting');
    const run = await runNpmScript('delete-meeting', { ...envWithoutDb(), BWAT_DB_URL: t.db.url('runtime') }, ['--meeting', ids.one!]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(`meeting ${ids.one} deleted: 7 segments, 1 claim briefings cleared`);
    expect((await t.pool.query(`SELECT 1 FROM meetings WHERE id = $1`, [ids.one])).rowCount).toBe(0);
  }, 30_000);

  it('delete-meeting fails for an unknown meeting, a missing id, or a meeting its bot is still in', async () => {
    const env = { ...envWithoutDb(), BWAT_DB_URL: t.db.url('runtime') };
    const ids = await seed(t, 'cli-live');
    const live = await runNpmScript('delete-meeting', env, ['--meeting', ids.three!]);
    expect(live.code).toBe(1);
    expect(live.stderr).toContain('delete-meeting failed: the meeting is live (a claim is open for it)');
    const unknown = await runNpmScript('delete-meeting', env, ['--meeting', '00000000-0000-4000-8000-000000000000']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('delete-meeting failed: no such meeting');
    const missing = await runNpmScript('delete-meeting', env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('delete-meeting failed: --meeting <uuid> is required');
  }, 30_000);
});

describeDb('admin routes on the started server (QOR-4577)', () => {
  const db = useTestDb();
  const token = 'dev-person-token-for-admin-tests-0123456789';
  const MEETING = '00000000-0000-4000-8000-00000000c0c0';

  const deleteUnknown = async (env: NodeJS.ProcessEnv, authorization?: string) => {
    const app = apiBase(await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test', ...env }));
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/meetings/${MEETING}`,
        headers: authorization ? { authorization } : {},
      });
      return res.statusCode;
    } finally {
      await app.close();
    }
  };

  it("lets the local stack's dev person (the first owner of an install with none) act as admin, and nobody otherwise", async () => {
    // Admitted, the dev person finds no such meeting: 404, where a non-admin gets 401 or 403.
    expect(await deleteUnknown({ BWAT_DEV_PERSON_TOKEN: token }, `Bearer ${token}`)).toBe(404);
    expect(await deleteUnknown({ BWAT_DEV_PERSON_TOKEN: token })).toBe(401);
    expect(await deleteUnknown({})).toBe(401);
  });
});
