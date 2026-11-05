import { afterEach, beforeEach, expect, it } from 'vitest';
import { createPool } from '../src/db/pool.ts';
import { retentionFromSettings, runRetention, startRetention } from '../src/retention.ts';
import { start } from '../src/server.ts';
import { useApp } from './app.ts';
import { describeDb, useTestDb } from './db/harness.ts';
import { envWithoutDb, runNpmScript } from './npm-script.ts';
import { ADMIN, MEMBER, useRoles } from './people.ts';
import { brief, liveSession, postHandoff } from './sessions.ts';

/** Seeds: one meeting per age, each with one segment, and claims holding a passcode. */
async function seed(pool: import('pg').Pool) {
  await pool.query(`DELETE FROM meetings`);
  const meeting = async (occurrence: string, startedDaysAgo: number, endedDaysAgo: number | null) => {
    const id = (
      await pool.query<{ id: string }>(
        `INSERT INTO meetings (occurrence_uuid, meeting_number, started_at, ended_at)
         VALUES ($1, '123456789', now() - make_interval(days => $2), CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END)
         RETURNING id`,
        [occurrence, startedDaysAgo, endedDaysAgo],
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO transcript_segments (meeting_id, epoch, seq, speaker_label, text, start_ms, end_ms) VALUES ($1, 1, 0, 'A', 'x', 0, 1)`,
      [id],
    );
    // A chat line: meeting content, kept and deleted exactly as speech is.
    await pool.query(
      `INSERT INTO transcript_segments (meeting_id, epoch, seq, speaker_label, text, start_ms, end_ms, source) VALUES ($1, 1, 1, 'A', 'y', 1, 1, 'chat')`,
      [id],
    );
  };
  await meeting('old-ended', 40, 39);
  await meeting('old-never-ended', 40, null);
  await meeting('ended-recently', 40, 10);
  await meeting('recent', 5, 4);
  const claim = (number: string, state: string, endedDaysAgo: number | null) =>
    pool.query(
      `INSERT INTO claims (meeting_number, state, ended_at, briefing)
       VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END, '{"passcode":"p"}')`,
      [number, state, endedDaysAgo],
    );
  await pool.query(`UPDATE claims SET state = 'done', ended_at = coalesce(ended_at, now()) WHERE state <> 'done'`);
  await claim('900000001', 'done', 40);
  await claim('900000002', 'abandoned', 40);
  await claim('900000003', 'done', 5);
  await claim('900000004', 'pending', null);
  // An open claim keeps its passcode whatever its timestamps say: its bot still needs it.
  await claim('900000005', 'pending', 40);
  // Zoom's meeting.ended records (migration 0005): kept as long as the transcripts.
  await pool.query(`DELETE FROM zoom_ended_occurrences`);
  await pool.query(
    `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid, ended_at)
     VALUES ('123456789', 'zoom-old', now() - interval '40 days'), ('123456789', 'zoom-recent', now() - interval '5 days')`,
  );
}

const endedOccurrences = async (pool: import('pg').Pool) =>
  (await pool.query(`SELECT occurrence_uuid FROM zoom_ended_occurrences ORDER BY occurrence_uuid`)).rows.map((r) => r.occurrence_uuid);

const occurrences = async (pool: import('pg').Pool) =>
  (await pool.query(`SELECT occurrence_uuid FROM meetings ORDER BY occurrence_uuid`)).rows.map((r) => r.occurrence_uuid);
/** The meetings whose transcript retention has not expired (D163: an expired one keeps its row). */
const kept = async (pool: import('pg').Pool) =>
  (await pool.query(`SELECT occurrence_uuid FROM meetings WHERE transcript_expired_at IS NULL ORDER BY occurrence_uuid`)).rows.map(
    (r) => r.occurrence_uuid,
  );
const briefings = async (pool: import('pg').Pool) =>
  Object.fromEntries(
    // The latest claim per number: earlier seeds left theirs behind (claims are never deleted).
    (
      await pool.query(
        `SELECT DISTINCT ON (meeting_number) meeting_number, briefing FROM claims
          WHERE meeting_number LIKE '90000000_' ORDER BY meeting_number, created_at DESC`,
      )
    ).rows.map((r) => [
      r.meeting_number,
      r.briefing,
    ]),
  );

describeDb('the retention job (QOR-4577, A255)', () => {
  const t = useApp();

  beforeEach(() => seed(t.pool));

  it('expires the transcripts, and only those, of meetings that ended (or started, if never ended) over N days ago', async () => {
    const result = await runRetention(t.pool, 30);
    expect(result).toEqual({
      transcripts_expired: 2,
      claims_scrubbed: 2,
      ended_occurrences_deleted: 1,
      inbox_messages_deleted: 0,
      handoffs_deleted: 0,
    });
    expect(await kept(t.pool)).toEqual(['ended-recently', 'recent']);
    // D163: the meetings themselves stay.
    expect(await occurrences(t.pool)).toEqual(['ended-recently', 'old-ended', 'old-never-ended', 'recent']);
    const segments = await t.pool.query(`SELECT source, count(*)::int AS n FROM transcript_segments GROUP BY source ORDER BY source`);
    expect(segments.rows).toEqual([
      { source: 'asr', n: 2 },
      { source: 'chat', n: 2 },
    ]);
  });

  it("clears the passcode from ended claims over N days old, and from no other claim", async () => {
    await runRetention(t.pool, 30);
    expect(await briefings(t.pool)).toEqual({
      '900000001': {},
      '900000002': {},
      '900000003': { passcode: 'p' },
      '900000004': { passcode: 'p' },
      '900000005': { passcode: 'p' },
    });
  });

  it("deletes Zoom's meeting.ended records over N days old, and no younger one", async () => {
    await runRetention(t.pool, 30);
    expect(await endedOccurrences(t.pool)).toEqual(['zoom-recent']);
  });

  it('keeps everything younger than N days', async () => {
    expect(await runRetention(t.pool, 60)).toEqual({
      transcripts_expired: 0,
      claims_scrubbed: 0,
      ended_occurrences_deleted: 0,
      inbox_messages_deleted: 0,
      handoffs_deleted: 0,
    });
    expect(await kept(t.pool)).toHaveLength(4);
    expect(await endedOccurrences(t.pool)).toEqual(['zoom-old', 'zoom-recent']);
  });
});

describeDb('the retention job on a backlog (QOR-4577, A255)', () => {
  const t = useApp();

  it('expires in batches, so a backlog longer than one statement may run still goes', async () => {
    await t.pool.query(`DELETE FROM meetings`);
    await t.pool.query(
      `INSERT INTO meetings (occurrence_uuid, meeting_number, started_at)
       SELECT 'backlog-' || n, '123456789', now() - interval '40 days' FROM generate_series(1, 10) AS n`,
    );
    // Each meeting's expiry sleeps 100 ms; a statement may run 500 ms. All ten at once cannot,
    // and one at a time leaves 400 ms of slack for a loaded test database.
    const owner = await t.db.connect('owner');
    const short = createPool(t.db.url('runtime'), { statement_timeout: 500 });
    try {
      await owner.query(`CREATE FUNCTION bwat.slow_meeting() RETURNS trigger LANGUAGE plpgsql AS $$
                           BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$`);
      await owner.query(`CREATE TRIGGER slow_meeting BEFORE UPDATE ON bwat.meetings
                           FOR EACH ROW EXECUTE FUNCTION bwat.slow_meeting()`);
      expect(await runRetention(short, 30, 1)).toMatchObject({ transcripts_expired: 10, claims_scrubbed: 0 });
    } finally {
      await short.end();
      await owner.query(`DROP TRIGGER IF EXISTS slow_meeting ON bwat.meetings`);
      await owner.query(`DROP FUNCTION IF EXISTS bwat.slow_meeting()`);
      await owner.end();
    }
    expect(await kept(t.pool)).toEqual([]);
  });

  it("deletes Zoom's meeting.ended records in batches too", async () => {
    await t.pool.query(`DELETE FROM zoom_ended_occurrences`);
    await t.pool.query(
      `INSERT INTO zoom_ended_occurrences (meeting_number, occurrence_uuid, ended_at)
       SELECT '123456789', 'backlog-' || n, now() - interval '40 days' FROM generate_series(1, 3) AS n`,
    );
    expect(await runRetention(t.pool, 30, 1)).toMatchObject({ ended_occurrences_deleted: 3 });
    expect(await endedOccurrences(t.pool)).toEqual([]);
  });
});

describeDb('the retention job prunes the hand-off inbox (QOR-4589)', () => {
  const t = useApp();

  /** Messages in the owner's inbox, `ages` days old, the even ones read; their subjects are their ages. */
  async function inboxAged(...ages: number[]) {
    await t.pool.query(`DELETE FROM inbox_messages`);
    for (const [i, age] of ages.entries()) {
      await t.pool.query(
        `INSERT INTO inbox_messages (recipient_member_id, sender_member_id, handoff_id, target_client_session, source_kind, source_id, subject, body, created_at, read_at)
         SELECT id, id, gen_random_uuid(), 'session-1', 'card', gen_random_uuid(), $1, 'b', now() - make_interval(days => $2::int),
                CASE WHEN $3 THEN now() END
           FROM members WHERE email = 'owner@test.invalid'`,
        [String(age), age, i % 2 === 0],
      );
    }
  }
  const left = async () => (await t.pool.query(`SELECT subject FROM inbox_messages ORDER BY subject`)).rows.map((r) => r.subject);

  it('deletes every message over N days old, read or unread, and no younger one', async () => {
    await inboxAged(40, 41, 5);
    expect(await runRetention(t.pool, 30)).toMatchObject({ inbox_messages_deleted: 2 });
    expect(await left()).toEqual(['5']);
  });

  it('deletes them in batches', async () => {
    await inboxAged(40, 41, 42, 43, 1);
    expect(await runRetention(t.pool, 30, 2)).toMatchObject({ inbox_messages_deleted: 4 });
    expect(await left()).toEqual(['1']);
  });
});

describeDb('a brief from a meeting goes by its own age, as its meeting stays (QOR-4589, D163)', () => {
  const t = useRoles();

  it("stays when its meeting's transcript expires, and goes once it is N days old itself", async () => {
    const meeting = (
      await t.pool.query<{ id: string }>(
        `INSERT INTO meetings (occurrence_uuid, meeting_number, started_at, ended_at)
         VALUES ('brief-source', '944000111', now() - interval '29 days 1 hour', now() - interval '29 days') RETURNING id`,
      )
    ).rows[0]!.id;
    const fromMeeting = await liveSession(t);
    expect((await postHandoff(t, brief(fromMeeting, { occurrence_id: meeting }))).statusCode).toBe(202);
    const left = async () =>
      (await t.pool.query(`SELECT 1 FROM inbox_messages WHERE target_client_session = $1`, [fromMeeting])).rows.length;
    // A day on: the meeting is 30 days old. Run with 29 days to stand for that day passing.
    expect(await runRetention(t.pool, 29)).toMatchObject({ transcripts_expired: 1, inbox_messages_deleted: 0 });
    expect(await left()).toBe(1);
    await t.pool.query(`UPDATE inbox_messages SET created_at = now() - interval '30 days' WHERE target_client_session = $1`, [fromMeeting]);
    expect(await runRetention(t.pool, 29)).toMatchObject({ inbox_messages_deleted: 1 });
    expect(await left()).toBe(0);
  });
});

describeDb('the retention interval (QOR-4577, A255)', () => {
  const t = useApp();
  let stop: (() => Promise<void>) | undefined;
  afterEach(() => stop?.());

  it('runs at once and then on every interval, reading the setting each time, until stopped', async () => {
    await seed(t.pool);
    let reads = 0;
    const events: string[] = [];
    const push = (o: object) => void events.push((o as { event: string }).event);
    const log = { info: push, error: push };
    stop = startRetention(t.pool, { transcriptRetentionDays: async () => (reads++, 30), keepForever: async () => false }, log, 50);
    await expect.poll(() => reads, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
    await stop();
    const after = reads;
    expect(await kept(t.pool)).toEqual(['ended-recently', 'recent']);
    expect(events).toContain('retention.ran');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reads).toBe(after);
  });

  it('stop waits for a run in progress to finish (QOR-4600)', async () => {
    await seed(t.pool);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const push = (o: object) => void events.push((o as { event: string }).event);
    const log = { info: push, error: push };
    let reads = 0;
    const days = async () => (reads++, await held, 30);
    stop = startRetention(t.pool, { transcriptRetentionDays: days, keepForever: async () => false }, log, 60_000);
    await expect.poll(() => reads).toBe(1);
    const stopping = stop();
    const pending = new Promise((resolve) => setTimeout(() => resolve('pending'), 50));
    expect(await Promise.race([stopping.then(() => 'stopped'), pending])).toBe('pending');
    expect(events).toEqual([]);
    release();
    await stopping;
    expect(events).toEqual(['retention.ran']);
    expect(await kept(t.pool)).toEqual(['ended-recently', 'recent']);
    expect(reads).toBe(1);
  });

  it('logs a failed run by its code and keeps going', async () => {
    const events: { event: string; code?: unknown }[] = [];
    const push = (o: object) => void events.push(o as { event: string });
    const log = { info: push, error: push };
    stop = startRetention(
      t.pool,
      {
        transcriptRetentionDays: async () => Promise.reject(Object.assign(new Error('boom secret'), { code: 'E_X' })),
        keepForever: async () => false,
      },
      log,
      50,
    );
    await expect.poll(() => events.length, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
    expect(events[0]).toEqual({ event: 'retention.failed', code: 'E_X' });
    expect(JSON.stringify(events)).not.toContain('boom secret');
  });
});

describeDb('retention reads its days from settings (QOR-4578, A255)', () => {
  const t = useRoles();
  const revision = async () =>
    (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settings.transcript_retention_days.revision;
  const save = async (value: number | null) =>
    t.app.inject({
      method: 'PUT',
      url: '/console/settings/retention',
      headers: ADMIN,
      payload: { changes: { transcript_retention_days: { value, expectedRevision: await revision() } } },
    });
  const runOnce = async () => runRetention(t.pool, await retentionFromSettings(t.pool).transcriptRetentionDays());

  it('a saved transcript_retention_days changes what the next run expires; a reset falls back to the default', async () => {
    await seed(t.pool);
    expect((await save(null)).statusCode).toBe(200);
    // Nothing stored: the default 90 days keep all four.
    expect((await runOnce()).transcripts_expired).toBe(0);
    expect((await save(30)).statusCode).toBe(200);
    expect((await runOnce()).transcripts_expired).toBe(2);
    expect(await kept(t.pool)).toEqual(['ended-recently', 'recent']);
    expect((await save(3)).statusCode).toBe(200);
    expect((await runOnce()).transcripts_expired).toBe(2);
    expect(await kept(t.pool)).toEqual([]);
    expect((await save(null)).statusCode).toBe(200);
    expect(await retentionFromSettings(t.pool).transcriptRetentionDays()).toBe(90);
  });

  it('defaults to 90 days in the catalogue, refuses 0, and never runs on a stored value outside the range', async () => {
    const settings = (await t.app.inject({ method: 'GET', url: '/console/settings', headers: MEMBER })).json().settings;
    expect(settings.transcript_retention_days.default).toBe(90);
    expect((await save(0)).statusCode).toBe(400);
    // A value the panel would refuse (0 would expire every ended meeting) is ignored: the default applies.
    for (const bad of [0, -1, 1.5, '30', true]) {
      await t.pool.query(
        `INSERT INTO settings (key, value, revision) VALUES ('transcript_retention_days', $1::jsonb, 1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(bad)],
      );
      expect(await retentionFromSettings(t.pool).transcriptRetentionDays(), String(bad)).toBe(90);
    }
  });
});

describeDb('the server runs retention (QOR-4577, A255)', () => {
  const db = useTestDb();

  it('expires old transcripts once started, using the stored transcript_retention_days', async () => {
    const owner = await db.connect('owner');
    try {
      await owner.query(
        `INSERT INTO bwat.meetings (occurrence_uuid, meeting_number, started_at) VALUES ('stored-wins', '123456789', now() - interval '20 days')`,
      );
      await owner.query(`INSERT INTO bwat.settings (key, value, revision) VALUES ('transcript_retention_days', '10', 1)`);
      // Keep forever is on by default (QOR-4760): off, so the days apply.
      await owner.query(`INSERT INTO bwat.settings (key, value, revision) VALUES ('transcript_keep_forever', 'false', 1)`);
    } finally {
      await owner.end();
    }
    const app = await start({ BWAT_DB_URL: db.url('runtime'), PORT: '0', NODE_ENV: 'test' });
    try {
      const runtime = await db.connect('runtime');
      try {
        await expect
          .poll(async () => (await runtime.query(`SELECT count(*)::int AS n FROM bwat.meetings WHERE transcript_expired_at IS NULL`)).rows[0].n, {
            timeout: 3000,
          })
          .toBe(0);
      } finally {
        await runtime.end();
      }
    } finally {
      await app.close();
    }
  });
});

describeDb('npm run retention (QOR-4577, A255)', () => {
  const t = useApp();

  it('runs the job once as the runtime role, with the saved retention days, and prints the counts', async () => {
    await seed(t.pool);
    await t.pool.query(`INSERT INTO settings (key, value, revision) VALUES ('transcript_retention_days', '30', 1), ('transcript_keep_forever', 'false', 1)`);
    try {
      const run = await runNpmScript('retention', { ...envWithoutDb(), BWAT_DB_URL: t.db.url('runtime') });
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe(
        'retention (30 days): 2 transcripts expired, 2 claim briefings cleared, 1 ended occurrences deleted, 0 inbox messages deleted, 0 hand-off keys deleted',
      );
      expect(await kept(t.pool)).toEqual(['ended-recently', 'recent']);
    } finally {
      await t.pool.query(`UPDATE settings SET value = 'null'::jsonb WHERE key IN ('transcript_retention_days', 'transcript_keep_forever')`);
    }
  }, 30_000);

  it('fails, naming the missing variable', async () => {
    const run = await runNpmScript('retention', envWithoutDb());
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('retention failed: BWAT_DB_URL is not set');
  }, 30_000);
});
