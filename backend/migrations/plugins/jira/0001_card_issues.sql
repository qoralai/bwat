
CREATE SCHEMA jira;
GRANT USAGE ON SCHEMA jira TO bwat_runtime;

CREATE TABLE jira.card_issues (
  card_id  uuid PRIMARY KEY REFERENCES cards.cards (id) ON DELETE CASCADE,
  key      text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9_]*-[0-9]+$'),
  url      text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 2000),
  sent_by  uuid,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  noted_at timestamptz
);

GRANT SELECT, INSERT, UPDATE (noted_at) ON jira.card_issues TO bwat_runtime;

INSERT INTO jira.card_issues (card_id, key, url, sent_by, sent_at, noted_at)
SELECT c.id, c.jira_key, c.jira_url, e.actor_member_id, coalesce(e.at, now()), coalesce(e.at, now())
  FROM cards.cards c
  LEFT JOIN LATERAL (
    SELECT actor_member_id, at FROM cards.card_events
     WHERE card_id = c.id AND action = 'card.jira' ORDER BY at LIMIT 1
  ) e ON true
 WHERE c.jira_key IS NOT NULL;
