
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bwat_cards') THEN
    RAISE EXCEPTION 'role bwat_cards is missing: create it with the other roles (docker/postgres/10-roles.sql locally, backend/README.md for an install)';
  END IF;
END $$;

CREATE SCHEMA cards;
GRANT USAGE ON SCHEMA cards TO bwat_cards;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO bwat_cards', current_database());
END $$;

CREATE SEQUENCE cards.decision_numbers;
CREATE SEQUENCE cards.todo_numbers;
CREATE SEQUENCE cards.question_numbers;
CREATE SEQUENCE cards.risk_numbers;

CREATE TABLE cards.cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('decision', 'todo', 'question', 'risk')),
  display_number  integer NOT NULL CHECK (display_number > 0),
  display_id      text GENERATED ALWAYS AS (
                    CASE kind WHEN 'decision' THEN 'D' WHEN 'todo' THEN 'A' WHEN 'question' THEN 'Q' ELSE 'R' END
                    || display_number::text) STORED,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  detail_html     text NOT NULL DEFAULT '' CHECK (length(detail_html) <= 20000),
  owner_member_id uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'wont_do')),
  archived        boolean NOT NULL DEFAULT false,
  version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, display_number),
  UNIQUE (id, meeting_id)
);

CREATE INDEX cards_meeting ON cards.cards (meeting_id, created_at);
CREATE INDEX cards_owner ON cards.cards (owner_member_id) WHERE owner_member_id IS NOT NULL;

CREATE FUNCTION cards.bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    NEW.created_at := now();
  ELSE
    NEW.version := OLD.version + 1;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cards.bump_version() FROM PUBLIC;

CREATE TRIGGER cards_bump BEFORE INSERT OR UPDATE ON cards.cards
  FOR EACH ROW EXECUTE FUNCTION cards.bump_version();

CREATE TABLE cards.evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           uuid NOT NULL,
  meeting_id        uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, meeting_id) REFERENCES cards.cards (id, meeting_id) ON DELETE CASCADE,
  epoch             integer NOT NULL CHECK (epoch >= 0),
  seq               integer NOT NULL CHECK (seq >= 0),
  speaker_member_id uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  speaker_label     text NOT NULL CHECK (length(speaker_label) BETWEEN 1 AND 200),
  text              text NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  source            text NOT NULL CHECK (source IN ('asr', 'chat')),
  UNIQUE (card_id, epoch, seq)
);

CREATE INDEX evidence_speaker ON cards.evidence (speaker_member_id) WHERE speaker_member_id IS NOT NULL;
CREATE INDEX evidence_meeting ON cards.evidence (meeting_id);

CREATE TABLE cards.card_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid NOT NULL,
  meeting_id      uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, meeting_id) REFERENCES cards.cards (id, meeting_id) ON DELETE CASCADE,
  at              timestamptz NOT NULL DEFAULT now(),
  action          text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  actor_kind      text NOT NULL CHECK (actor_kind IN ('member', 'writer', 'system')),
  actor_member_id uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  before          jsonb,
  after           jsonb,
  cause           jsonb
);

CREATE INDEX card_events_card ON cards.card_events (card_id, at);
CREATE INDEX card_events_meeting ON cards.card_events (meeting_id);
CREATE INDEX card_events_actor ON cards.card_events (actor_member_id) WHERE actor_member_id IS NOT NULL;

CREATE TABLE cards.card_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  from_card_id uuid NOT NULL,
  to_card_id   uuid REFERENCES cards.cards (id) ON DELETE CASCADE,
  to_todo_id   text CHECK (length(to_todo_id) BETWEEN 1 AND 64),
  kind         text NOT NULL CHECK (kind IN ('supersedes', 'answers', 'merges', 'todo_twin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  revoked_by   uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  FOREIGN KEY (from_card_id, meeting_id) REFERENCES cards.cards (id, meeting_id) ON DELETE CASCADE,
  CHECK (CASE WHEN kind = 'todo_twin' THEN to_todo_id IS NOT NULL AND to_card_id IS NULL
              ELSE to_card_id IS NOT NULL AND to_todo_id IS NULL END),
  CHECK (to_card_id IS DISTINCT FROM from_card_id)
);

CREATE UNIQUE INDEX card_links_active ON cards.card_links (from_card_id, kind, to_card_id, to_todo_id)
  NULLS NOT DISTINCT WHERE revoked_at IS NULL;
CREATE INDEX card_links_from ON cards.card_links (from_card_id, meeting_id);
CREATE INDEX card_links_to ON cards.card_links (to_card_id) WHERE to_card_id IS NOT NULL;
CREATE INDEX card_links_meeting ON cards.card_links (meeting_id);
CREATE INDEX card_links_revoked_by ON cards.card_links (revoked_by) WHERE revoked_by IS NOT NULL;

CREATE FUNCTION cards.touch_linked_cards() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = cards, pg_temp AS $$
DECLARE link cards.card_links;
BEGIN
  link := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  UPDATE cards.cards SET archived = archived WHERE id IN (link.from_card_id, link.to_card_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cards.touch_linked_cards() FROM PUBLIC;

CREATE TRIGGER card_links_touch AFTER INSERT OR UPDATE OR DELETE ON cards.card_links
  FOR EACH ROW EXECUTE FUNCTION cards.touch_linked_cards();

CREATE TABLE cards.capture_positions (
  meeting_id uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  epoch      integer NOT NULL CHECK (epoch >= 0),
  last_seq   integer NOT NULL CHECK (last_seq >= -1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, epoch)
);

CREATE FUNCTION cards.advance_position() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seq < OLD.last_seq THEN
    RAISE EXCEPTION 'capture position moves forward only' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION cards.advance_position() FROM PUBLIC;

CREATE TRIGGER capture_positions_advance BEFORE UPDATE ON cards.capture_positions
  FOR EACH ROW EXECUTE FUNCTION cards.advance_position();

GRANT SELECT, INSERT ON cards.cards TO bwat_cards;
GRANT UPDATE (title, detail_html, owner_member_id, status, archived) ON cards.cards TO bwat_cards;
GRANT SELECT, INSERT ON cards.evidence TO bwat_cards;
GRANT SELECT, INSERT ON cards.card_events TO bwat_cards;
GRANT SELECT, INSERT ON cards.card_links TO bwat_cards;
GRANT UPDATE (revoked_at, revoked_by) ON cards.card_links TO bwat_cards;
GRANT SELECT, INSERT ON cards.capture_positions TO bwat_cards;
GRANT UPDATE (last_seq) ON cards.capture_positions TO bwat_cards;
GRANT USAGE ON SEQUENCE cards.decision_numbers, cards.todo_numbers, cards.question_numbers, cards.risk_numbers TO bwat_cards;
