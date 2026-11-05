import type pg from 'pg';
import { lockMeeting, OPEN } from './claims.ts';
import { withTransaction } from './db/pool.ts';

/** The account id is always one Zoom signed. From a verified webhook, Zoom also vouches for the
 * participant id, and a mapping that disagrees with one already stored marks it `conflicted`,
 * which resolves to nobody (fails closed). From the bwat panel (`clientSupplied`) only the account
 * is signed and the participant id is the client's word, an accepted gap: it only fills an id
 * nobody has mapped, never changing or conflicting an existing row. Names and deprecated IDs are
 * deliberately ignored: neither proves which Zoom account owns an audio stream.
 * `awaitingHost`: auto-join will attend once the host arrives, so an earlier arrival is
 * kept before any claim; one never claimed goes when the meeting ends (forgetUnattendedSpeakers)
 * or after a day (retention). */
export async function recordZoomSpeaker(
  pool: pg.Pool, meetingNumber: string, occurrence: string, participant: unknown,
  { awaitingHost = false, clientSupplied = false }: { awaitingHost?: boolean; clientSupplied?: boolean } = {},
): Promise<void> {
  if (!participant || typeof participant !== 'object') return;
  const p = participant as Record<string, unknown>;
  const node = p.user_id;
  if (typeof node !== 'string' || !/^[1-9][0-9]{0,9}$/.test(node) || Number(node) > 4_294_967_295) return;
  const account = typeof p.participant_user_id === 'string' && p.participant_user_id.length > 0 && p.participant_user_id.length <= 200
    ? p.participant_user_id : null;
  await withTransaction(pool, async (client) => {
    // Same fence/order as deletion. A replay cannot restore erased meeting metadata.
    await lockMeeting(client, meetingNumber);
    const erased = await client.query(`SELECT 1 FROM deleted_occurrences WHERE occurrence_uuid = $1
      UNION ALL SELECT 1 FROM meetings WHERE occurrence_uuid = $1 AND transcript_expired_at IS NOT NULL`, [occurrence]);
    if (erased.rowCount) return;
    const attended = await client.query(`SELECT 1 FROM meetings WHERE occurrence_uuid = $1
      UNION ALL SELECT 1 FROM claims WHERE occurrence_uuid = $1
        OR (occurrence_uuid IS NULL AND meeting_number = $2 AND state IN (${OPEN}))`,
    [occurrence, meetingNumber]);
    if (!attended.rowCount && !awaitingHost) return;
    await client.query(`INSERT INTO zoom_speakers (occurrence_uuid, speaker_zoom_id, zoom_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (occurrence_uuid, speaker_zoom_id) ${clientSupplied ? 'DO NOTHING' : `DO UPDATE
        SET conflicted = zoom_speakers.conflicted OR zoom_speakers.zoom_user_id IS DISTINCT FROM EXCLUDED.zoom_user_id`}`,
    [occurrence, node, account]);
  });
}

/** An occurrence's speakers kept while waiting for the host, once it ends with no claim or meeting. */
export async function forgetUnattendedSpeakers(pool: pg.Pool, occurrence: string): Promise<void> {
  await pool.query(`DELETE FROM zoom_speakers z WHERE z.occurrence_uuid = $1
    AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.occurrence_uuid = $1)
    AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.occurrence_uuid = $1)`, [occurrence]);
}
