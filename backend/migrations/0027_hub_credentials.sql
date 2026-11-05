
CREATE TABLE bwat.hub_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

GRANT SELECT, INSERT, UPDATE (revoked_at) ON bwat.hub_credentials TO bwat_runtime;
