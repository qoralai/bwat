
CREATE TABLE bwat.hub_links (
  credential_id uuid NOT NULL REFERENCES bwat.hub_credentials (id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, member_id)
);

GRANT SELECT, INSERT, DELETE ON bwat.hub_links TO bwat_runtime;
