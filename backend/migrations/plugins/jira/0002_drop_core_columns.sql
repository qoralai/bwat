
ALTER TABLE cards.cards
  DROP CONSTRAINT cards_jira_together,
  DROP COLUMN jira_key,
  DROP COLUMN jira_url;
