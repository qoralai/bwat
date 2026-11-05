
CREATE TABLE bwat.zoom_deliveries (
  body_sha256 bytea PRIMARY KEY CHECK (octet_length(body_sha256) = 32),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zoom_deliveries_by_age ON bwat.zoom_deliveries (received_at);

CREATE TABLE bwat.zoom_ended_occurrences (
  meeting_number  text NOT NULL CHECK (meeting_number ~ '^[0-9]{9,12}$'),
  occurrence_uuid text NOT NULL CHECK (length(occurrence_uuid) BETWEEN 1 AND 128),
  ended_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_number, occurrence_uuid)
);
CREATE INDEX zoom_ended_occurrences_by_age ON bwat.zoom_ended_occurrences (ended_at);
CREATE INDEX zoom_ended_occurrences_by_occurrence ON bwat.zoom_ended_occurrences (occurrence_uuid);

CREATE INDEX claims_by_meeting ON bwat.claims (meeting_number, created_at);

GRANT SELECT, INSERT, DELETE ON bwat.zoom_deliveries TO bwat_runtime;
GRANT SELECT, INSERT, DELETE ON bwat.zoom_ended_occurrences TO bwat_runtime;
