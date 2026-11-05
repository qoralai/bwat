
CREATE TABLE bwat.cards_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON bwat.cards_credentials TO bwat_runtime;
