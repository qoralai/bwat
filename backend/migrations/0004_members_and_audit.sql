
CREATE TABLE bwat.members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE CHECK (email = lower(email) AND email LIKE '%_@_%' AND length(email) <= 320),
  display_name text CHECK (length(display_name) <= 200),
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  zoom_user_id text UNIQUE CHECK (length(zoom_user_id) <= 64),
  zoom_email   text CHECK (zoom_email = lower(zoom_email) AND length(zoom_email) <= 320),
  google_sub   text UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  activated_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_type text NOT NULL,
  target_id   uuid,
  before      jsonb,
  after       jsonb
);

CREATE INDEX audit_target ON bwat.audit (target_type, target_id, at);

GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.members TO bwat_runtime;
GRANT SELECT, INSERT ON bwat.audit TO bwat_runtime;
