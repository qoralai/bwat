ALTER TABLE bwat.transcript_segments ADD COLUMN speaker_zoom_id text
  CHECK (speaker_zoom_id ~ '^[1-9][0-9]{0,9}$' AND speaker_zoom_id::bigint <= 4294967295);

CREATE TABLE bwat.zoom_speakers (
  occurrence_uuid text NOT NULL CHECK (length(occurrence_uuid) BETWEEN 1 AND 128),
  speaker_zoom_id text NOT NULL CHECK (speaker_zoom_id ~ '^[1-9][0-9]{0,9}$' AND speaker_zoom_id::bigint <= 4294967295),
  zoom_user_id text CHECK (length(zoom_user_id) BETWEEN 1 AND 200),
  conflicted boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occurrence_uuid, speaker_zoom_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.zoom_speakers TO bwat_runtime;

CREATE VIEW bwat.v_transcript_speakers AS
  SELECT s.meeting_id, s.epoch, s.seq, s.speaker_zoom_id,
         CASE WHEN s.speaker_zoom_id IS NULL THEN s.speaker_member_id
              WHEN NOT z.conflicted THEN p.id END AS speaker_member_id
    FROM bwat.transcript_segments s
    JOIN bwat.meetings m ON m.id = s.meeting_id
    LEFT JOIN bwat.zoom_speakers z ON z.occurrence_uuid = m.occurrence_uuid AND z.speaker_zoom_id = s.speaker_zoom_id
    LEFT JOIN bwat.members p ON p.zoom_user_id = z.zoom_user_id AND p.activated_at IS NOT NULL;
GRANT SELECT ON bwat.v_transcript_speakers TO bwat_runtime, bwat_cards;
