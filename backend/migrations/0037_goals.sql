
CREATE TABLE bwat.goals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_of            date NOT NULL CHECK (extract(isodow FROM week_of) = 1),
  title              text NOT NULL CHECK (char_length(btrim(title)) >= 1 AND char_length(title) <= 80),
  summary            text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 280),
  details            text NOT NULL DEFAULT '' CHECK (char_length(details) <= 10000),
  state              text NOT NULL CHECK (state IN ('draft', 'goal', 'dismissed')),
  position           integer NOT NULL DEFAULT 0,
  outcome            text CHECK (outcome IN ('met', 'missed', 'carried')),
  outcome_unreviewed boolean NOT NULL DEFAULT false,
  proposed_outcome   text CHECK (proposed_outcome IN ('met', 'missed', 'carried')),
  outcome_evidence   text CHECK (char_length(outcome_evidence) <= 1000),
  carried_from       uuid UNIQUE REFERENCES bwat.goals (id) ON DELETE SET NULL,
  source_meeting_id  uuid REFERENCES bwat.meetings (id) ON DELETE SET NULL,
  drafted_by         text NOT NULL CHECK (drafted_by IN ('bwat', 'member')),
  touched            boolean NOT NULL DEFAULT false,
  revision           integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by         uuid,
  updated_by         uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_outcome_on_goal CHECK (outcome IS NULL OR state = 'goal')
);

CREATE INDEX goals_week ON bwat.goals (week_of, position);
CREATE INDEX goals_source_meeting ON bwat.goals (source_meeting_id) WHERE source_meeting_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE ON bwat.goals TO bwat_runtime;

ALTER TABLE bwat.settings DROP CONSTRAINT settings_key_check;
ALTER TABLE bwat.settings ADD CONSTRAINT settings_key_check
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$' AND length(key) <= 64);
