CREATE TABLE cards.card_carries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES cards.cards (id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  link_id    uuid REFERENCES cards.card_links (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES bwat.members (id) ON DELETE SET NULL
);

CREATE INDEX card_carries_card ON cards.card_carries (card_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX card_carries_meeting ON cards.card_carries (meeting_id);
CREATE INDEX card_carries_link ON cards.card_carries (link_id) WHERE link_id IS NOT NULL;
CREATE INDEX card_carries_revoked_by ON cards.card_carries (revoked_by) WHERE revoked_by IS NOT NULL;
CREATE UNIQUE INDEX card_carries_once ON cards.card_carries (card_id, meeting_id) WHERE link_id IS NULL;

CREATE FUNCTION cards.touch_carried_card() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = cards, pg_temp AS $$
BEGIN
  UPDATE cards.cards SET archived = archived
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cards.touch_carried_card() FROM PUBLIC;

CREATE TRIGGER card_carries_touch AFTER INSERT OR UPDATE OR DELETE ON cards.card_carries
  FOR EACH ROW EXECUTE FUNCTION cards.touch_carried_card();

GRANT SELECT, INSERT ON cards.card_carries TO bwat_cards;
GRANT UPDATE (revoked_at, revoked_by) ON cards.card_carries TO bwat_cards;
