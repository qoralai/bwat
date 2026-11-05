
CREATE SCHEMA goals;
GRANT USAGE ON SCHEMA goals TO bwat_runtime;

CREATE TABLE goals.lists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  cadence    text NOT NULL DEFAULT 'week' CHECK (cadence IN ('week', '2weeks', 'month', 'quarter')),
  timezone   text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  anchor     date NOT NULL DEFAULT '2024-01-01' CHECK (extract(isodow FROM anchor) = 1),
  revision   integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO goals.lists (name) VALUES ('Company goals');

CREATE TABLE goals.goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id      uuid NOT NULL REFERENCES goals.lists (id),
  period_start date NOT NULL,
  title        text NOT NULL CHECK (char_length(btrim(title)) >= 1 AND char_length(title) <= 80),
  summary      text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 280),
  details      text NOT NULL DEFAULT '' CHECK (char_length(details) <= 10000),
  state        text NOT NULL CHECK (state IN ('draft', 'goal', 'dismissed')),
  position     integer NOT NULL DEFAULT 0,
  outcome      text CHECK (outcome IN ('met', 'missed', 'carried')),
  carried_from uuid UNIQUE REFERENCES goals.goals (id),
  touched      boolean NOT NULL DEFAULT false,
  revision     integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by   uuid,
  updated_by   uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_outcome_on_goal CHECK (outcome IS NULL OR state = 'goal')
);

CREATE INDEX goals_list_period ON goals.goals (list_id, period_start, position);

GRANT SELECT, UPDATE ON goals.lists TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE ON goals.goals TO bwat_runtime;

CREATE TABLE goals.card_links (
  card_id    uuid PRIMARY KEY REFERENCES cards.cards (id) ON DELETE CASCADE,
  goal_id    uuid NOT NULL REFERENCES goals.goals (id),
  set_by     uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX card_links_goal ON goals.card_links (goal_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON goals.card_links TO bwat_runtime;
