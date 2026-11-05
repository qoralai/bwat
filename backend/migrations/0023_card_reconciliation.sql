CREATE TABLE cards.reconciliation_jobs (
  meeting_id uuid PRIMARY KEY REFERENCES bwat.meetings(id) ON DELETE CASCADE,
  position jsonb NOT NULL,
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON cards.reconciliation_jobs TO bwat_cards;

ALTER TABLE cards.card_links DROP CONSTRAINT card_links_kind_check;
ALTER TABLE cards.card_links ADD CONSTRAINT card_links_kind_check
  CHECK (kind IN ('supersedes', 'answers', 'merges', 'todo_twin', 'related'));
