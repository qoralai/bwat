
ALTER TABLE cards.cards
  ADD COLUMN goal_id uuid REFERENCES bwat.goals (id) ON DELETE SET NULL,
  ADD COLUMN goal_set_by text CHECK (goal_set_by IN ('bwat', 'member'));

CREATE INDEX cards_goal ON cards.cards (goal_id) WHERE goal_id IS NOT NULL;

GRANT UPDATE (goal_id, goal_set_by) ON cards.cards TO bwat_cards;
