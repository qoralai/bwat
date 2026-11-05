
ALTER TABLE bwat.members ADD COLUMN joined_by_code boolean NOT NULL DEFAULT false;

CREATE TABLE bwat.code_sessions (
  refresh_sha256 bytea PRIMARY KEY CHECK (octet_length(refresh_sha256) = 32),
  member_id      uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  code_tag       text NOT NULL CHECK (code_tag ~ '^[0-9a-f]{16}$'),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX code_sessions_member ON bwat.code_sessions (member_id);

GRANT SELECT, INSERT, DELETE ON bwat.code_sessions TO bwat_runtime;
