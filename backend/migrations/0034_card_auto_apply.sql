ALTER TABLE cards.cards
  ADD COLUMN auto_apply_confidence smallint CHECK (auto_apply_confidence BETWEEN 0 AND 100),
  ADD COLUMN suggested_action text CHECK (suggested_action IN ('act', 'investigate', 'leave'));
