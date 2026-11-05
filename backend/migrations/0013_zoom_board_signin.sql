
CREATE TABLE bwat.zoom_board_sessions (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  member_id    uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.zoom_links (
  code_sha256  bytea PRIMARY KEY CHECK (octet_length(code_sha256) = 32),
  zoom_user_id text NOT NULL CHECK (length(zoom_user_id) BETWEEN 1 AND 64),
  wrong_codes  integer NOT NULL DEFAULT 0,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.zoom_pairings (
  code_sha256  bytea PRIMARY KEY CHECK (octet_length(code_sha256) = 32),
  member_id    uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON bwat.zoom_board_sessions TO bwat_runtime;
GRANT SELECT, INSERT, DELETE ON bwat.zoom_links TO bwat_runtime;
GRANT UPDATE (wrong_codes) ON bwat.zoom_links TO bwat_runtime;
GRANT SELECT, INSERT, DELETE ON bwat.zoom_pairings TO bwat_runtime;
