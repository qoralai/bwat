
CREATE TABLE bwat.fleet_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.bots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_credential_id uuid NOT NULL REFERENCES bwat.fleet_credentials (id),
  token_sha256        bytea NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  version             text,
  capabilities        jsonb NOT NULL DEFAULT '{}',
  registered_at       timestamptz NOT NULL DEFAULT now(),
  ready_at            timestamptz,
  last_heartbeat      timestamptz NOT NULL DEFAULT now(),
  status              jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE bwat.claims (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_number   text NOT NULL CHECK (meeting_number ~ '^[0-9]{9,12}$'),
  occurrence_uuid  text,
  state            text NOT NULL DEFAULT 'pending'
                     CHECK (state IN ('pending', 'claimed', 'attending', 'done', 'abandoned')),
  bot_id           uuid REFERENCES bwat.bots (id),
  generation       integer NOT NULL DEFAULT 0,
  allocation_count integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,
  pending_until    timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
  transcript_epoch integer NOT NULL DEFAULT 0,
  refused_reason   text,
  briefing         jsonb NOT NULL DEFAULT '{}',
  settings         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  allocated_at     timestamptz,
  ended_at         timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX claims_one_open_per_meeting ON bwat.claims (meeting_number)
  WHERE state IN ('pending', 'claimed', 'attending');

CREATE UNIQUE INDEX claims_one_live_per_bot ON bwat.claims (bot_id)
  WHERE state IN ('claimed', 'attending');

GRANT SELECT, INSERT ON bwat.fleet_credentials TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE ON bwat.bots TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE ON bwat.claims TO bwat_runtime;
