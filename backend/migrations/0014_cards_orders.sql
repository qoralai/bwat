
CREATE TABLE cards.card_orders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  member_id   uuid REFERENCES bwat.members (id) ON DELETE CASCADE,
  card_ids    jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(card_ids) = 'array'),
  version     integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by  uuid REFERENCES bwat.members (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((meeting_id IS NULL) <> (member_id IS NULL))
);

CREATE UNIQUE INDEX card_orders_meeting ON cards.card_orders (meeting_id) WHERE meeting_id IS NOT NULL;
CREATE UNIQUE INDEX card_orders_member ON cards.card_orders (member_id) WHERE member_id IS NOT NULL;
CREATE INDEX card_orders_updated_by ON cards.card_orders (updated_by) WHERE updated_by IS NOT NULL;

GRANT SELECT, INSERT ON cards.card_orders TO bwat_cards;
GRANT UPDATE (card_ids, version, updated_by, updated_at) ON cards.card_orders TO bwat_cards;
