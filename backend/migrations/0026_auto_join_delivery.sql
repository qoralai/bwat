CREATE TABLE bwat.auto_join_delivery (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  configuration text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('meeting.started', 'meeting.ended', 'meeting.participant_joined')),
  received_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.auto_join_delivery TO bwat_runtime;
