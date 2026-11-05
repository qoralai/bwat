import { bearer, postAllocation, registerBot, type TestApp } from './app.ts';

/** Helpers for the meeting and transcript tests (QOR-4577). */

/** A ready bot sent to `meetingNumber`, whose claim has reached the occurrence with this transcript epoch. */
export async function botInMeeting(t: TestApp, occurrence: string, meetingNumber: string, epoch = 1) {
  const bot = await registerBot(t);
  const claim = (await postAllocation(t, { zoom_url: `https://zoom.us/j/${meetingNumber}` })).json();
  await t.pool.query(`UPDATE claims SET occurrence_uuid = $2, transcript_epoch = $3 WHERE id = $1`, [
    claim.id,
    occurrence,
    epoch,
  ]);
  return { ...bot, claim_id: claim.id as string };
}

export const segment = (seq: number, over: object = {}) => ({
  seq,
  speaker_label: 'Ada Lovelace',
  text: `segment ${seq}`,
  start_ms: seq * 1000,
  end_ms: seq * 1000 + 900,
  ...over,
});

export const pushTranscript = (t: TestApp, occurrence: string, token: string, payload: object) =>
  t.app.inject({
    method: 'POST',
    url: `/meetings/${encodeURIComponent(occurrence)}/transcript`,
    headers: bearer(token),
    payload,
  });

/** The id of the meeting opened for `occurrence`. */
export const meetingIdOf = async (t: TestApp, occurrence: string): Promise<string> =>
  (await t.pool.query(`SELECT id FROM meetings WHERE occurrence_uuid = $1`, [occurrence])).rows[0].id;

/** Runs `fn` while each segment insert sleeps 300 ms, holding a push open mid-transaction. */
export async function withSlowSegmentInserts<T>(t: TestApp, fn: () => Promise<T>): Promise<T> {
  const owner = await t.db.connect('owner');
  try {
    await owner.query(`CREATE FUNCTION bwat.slow_segment() RETURNS trigger LANGUAGE plpgsql AS $$
                         BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER slow_segment BEFORE INSERT ON bwat.transcript_segments
                         FOR EACH ROW EXECUTE FUNCTION bwat.slow_segment()`);
    return await fn();
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS slow_segment ON bwat.transcript_segments`);
    await owner.query(`DROP FUNCTION IF EXISTS bwat.slow_segment()`);
    await owner.end();
  }
}
