
CREATE TABLE bwat.removed_members (
  email      text PRIMARY KEY CHECK (email = lower(email)),
  google_sub text,
  removed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX removed_members_google_sub ON bwat.removed_members (google_sub);

GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.removed_members TO bwat_runtime;
