CREATE OR REPLACE FUNCTION cards.touch_context_card() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = cards, pg_temp AS $$
DECLARE
  context_card_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.card_id ELSE NEW.card_id END;
BEGIN
  UPDATE cards.cards SET archived = archived WHERE id IN (
    SELECT context_card_id
    UNION ALL
    SELECT to_card_id FROM cards.card_links
      WHERE kind = 'merges' AND revoked_at IS NULL AND from_card_id = context_card_id
  );
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cards.touch_context_card() FROM PUBLIC;
