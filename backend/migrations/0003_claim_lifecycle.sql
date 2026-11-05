
ALTER TABLE bwat.claims ADD COLUMN meeting_ended_at timestamptz;
CREATE INDEX claims_ended_occurrence ON bwat.claims (occurrence_uuid) WHERE meeting_ended_at IS NOT NULL;

ALTER TABLE bwat.claims ADD COLUMN last_placement_failure text;

CREATE TABLE bwat.occurrence_epochs (
  occurrence_uuid text PRIMARY KEY,
  highest_epoch   integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON bwat.occurrence_epochs TO bwat_runtime;

ALTER TABLE bwat.claims ALTER COLUMN transcript_epoch DROP NOT NULL;
ALTER TABLE bwat.claims ALTER COLUMN transcript_epoch DROP DEFAULT;

CREATE INDEX claims_pending ON bwat.claims (created_at, id) WHERE state = 'pending';
CREATE INDEX claims_live_lease ON bwat.claims (lease_until)
  WHERE state IN ('claimed', 'attending');
CREATE INDEX bots_ready ON bwat.bots (ready_at, id) WHERE ready_at IS NOT NULL;
