
CREATE TABLE bwat.meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_uuid  text NOT NULL UNIQUE CHECK (length(occurrence_uuid) BETWEEN 1 AND 128),
  meeting_number   text NOT NULL CHECK (meeting_number ~ '^[0-9]{9,12}$'),
  title            text,
  started_at       timestamptz(3) NOT NULL DEFAULT now(),
  ended_at         timestamptz(3),
  duration_seconds integer GENERATED ALWAYS AS (extract(epoch FROM ended_at - started_at)::integer) STORED,
  attendee_count   integer CHECK (attendee_count >= 0),
  finalization     text NOT NULL DEFAULT 'open' CHECK (finalization IN ('open', 'transcript_complete')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meetings_history ON bwat.meetings (started_at DESC, id DESC);

CREATE TABLE bwat.transcript_segments (
  meeting_id        uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  epoch             integer NOT NULL CHECK (epoch >= 0),
  seq               integer NOT NULL CHECK (seq >= 0),
  speaker_label     text NOT NULL,
  speaker_member_id uuid,
  text              text NOT NULL,
  start_ms          integer NOT NULL CHECK (start_ms >= 0),
  end_ms            integer NOT NULL CHECK (end_ms >= start_ms),
  source            text NOT NULL DEFAULT 'asr' CHECK (source IN ('asr', 'chat')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, epoch, seq)
);

CREATE INDEX transcript_segments_speaker ON bwat.transcript_segments (speaker_member_id)
  WHERE speaker_member_id IS NOT NULL;

CREATE TABLE bwat.erased_segments (
  meeting_id uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  epoch      integer NOT NULL,
  seq        integer NOT NULL,
  PRIMARY KEY (meeting_id, epoch, seq)
);

CREATE TABLE bwat.deleted_occurrences (
  occurrence_uuid text PRIMARY KEY CHECK (length(occurrence_uuid) BETWEEN 1 AND 128),
  deleted_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bwat.claims ADD COLUMN drain_until timestamptz;

CREATE INDEX claims_occurrence ON bwat.claims (occurrence_uuid) WHERE occurrence_uuid IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.meetings TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.transcript_segments TO bwat_runtime;
GRANT SELECT, INSERT ON bwat.erased_segments TO bwat_runtime;
GRANT SELECT, INSERT ON bwat.deleted_occurrences TO bwat_runtime;
