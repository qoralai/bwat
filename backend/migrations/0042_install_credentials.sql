
CREATE TABLE bwat.install_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '30 days',
  revoked_at   timestamptz
);

GRANT SELECT, INSERT ON bwat.install_credentials TO bwat_runtime;
GRANT UPDATE (revoked_at) ON bwat.install_credentials TO bwat_runtime;
