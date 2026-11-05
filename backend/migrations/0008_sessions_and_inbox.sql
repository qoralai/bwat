
CREATE TABLE bwat.sessions (
  member_id    uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  session_id   text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9._-]{8,128}$'),
  instance_id  text NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 128),
  client       jsonb NOT NULL CHECK (jsonb_typeof(client) = 'object'),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  ended_at     timestamptz(3),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, session_id)
);

CREATE INDEX sessions_live ON bwat.sessions (member_id, last_seen_at) WHERE ended_at IS NULL;

CREATE TABLE bwat.handoffs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_member_id uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  request_key      text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_member_id, request_key)
);

CREATE TABLE bwat.inbox_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_member_id   uuid NOT NULL REFERENCES bwat.members (id) ON DELETE CASCADE,
  sender_member_id      uuid NOT NULL,
  message_type          text NOT NULL DEFAULT 'handoff' CHECK (message_type = 'handoff'),
  handoff_id            uuid NOT NULL UNIQUE,
  target_client_session text NOT NULL CHECK (target_client_session ~ '^[A-Za-z0-9._-]{8,128}$'),
  source_kind           text NOT NULL CHECK (source_kind IN ('card', 'todo')),
  source_id             uuid NOT NULL,
  occurrence_id         uuid REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  subject               text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  body                  text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at            timestamptz(3) NOT NULL DEFAULT now(),
  read_at               timestamptz(3)
);

CREATE INDEX inbox_messages_recipient ON bwat.inbox_messages (recipient_member_id, created_at, id);
CREATE INDEX inbox_messages_session ON bwat.inbox_messages (recipient_member_id, target_client_session, created_at, id);
CREATE INDEX inbox_messages_meeting ON bwat.inbox_messages (occurrence_id);
CREATE INDEX inbox_messages_age ON bwat.inbox_messages (created_at);

GRANT SELECT, INSERT, UPDATE ON bwat.sessions TO bwat_runtime;
GRANT SELECT, INSERT ON bwat.handoffs TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.inbox_messages TO bwat_runtime;
