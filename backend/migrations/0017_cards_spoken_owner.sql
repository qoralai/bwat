
ALTER TABLE cards.cards ADD COLUMN owner_name text CHECK (length(owner_name) BETWEEN 1 AND 200);

GRANT UPDATE (owner_name) ON cards.cards TO bwat_cards;
