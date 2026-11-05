CREATE TABLE cards.card_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES cards.cards(id) ON DELETE CASCADE,
  source_meeting_id uuid NOT NULL REFERENCES bwat.meetings(id) ON DELETE CASCADE,
  link_id uuid REFERENCES cards.card_links(id) ON DELETE CASCADE,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_context_card ON cards.card_context(card_id);
CREATE INDEX card_context_meeting ON cards.card_context(source_meeting_id);
CREATE INDEX card_context_link ON cards.card_context(link_id);
GRANT SELECT, INSERT ON cards.card_context TO bwat_cards;

CREATE FUNCTION cards.touch_context_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cards, pg_temp AS $$
BEGIN
  UPDATE cards.cards SET archived = archived WHERE
    id = CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END OR
    id IN (SELECT to_card_id FROM cards.card_links WHERE kind = 'merges' AND revoked_at IS NULL
           AND from_card_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cards.touch_context_card() FROM PUBLIC;
CREATE TRIGGER card_context_touch AFTER INSERT OR DELETE ON cards.card_context
  FOR EACH ROW EXECUTE FUNCTION cards.touch_context_card();
