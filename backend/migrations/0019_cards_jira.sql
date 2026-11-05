
ALTER TABLE cards.cards
  ADD COLUMN jira_key text CHECK (jira_key ~ '^[A-Z][A-Z0-9_]*-[0-9]+$'),
  ADD COLUMN jira_url text CHECK (jira_url ~ '^https://' AND length(jira_url) <= 2000),
  ADD CONSTRAINT cards_jira_together CHECK ((jira_key IS NULL) = (jira_url IS NULL));

GRANT UPDATE (jira_key, jira_url) ON cards.cards TO bwat_cards;
