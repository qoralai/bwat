CREATE TABLE cards.card_checks (
  card_id    uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES bwat.meetings (id) ON DELETE CASCADE,
  FOREIGN KEY (card_id, meeting_id) REFERENCES cards.cards (id, meeting_id) ON DELETE CASCADE,
  event_id   uuid NOT NULL,
  event_at   timestamptz NOT NULL,
  state      text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  dup_card_id    uuid REFERENCES cards.cards (id) ON DELETE SET NULL,
  dup_confidence double precision CHECK (dup_confidence BETWEEN 0 AND 1),
  rel_card_id    uuid REFERENCES cards.cards (id) ON DELETE SET NULL,
  rel_confidence double precision CHECK (rel_confidence BETWEEN 0 AND 1),
  threshold_pct integer CHECK (threshold_pct BETWEEN 0 AND 100),
  attempts   integer NOT NULL DEFAULT 0,
  retry_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_checks_due ON cards.card_checks (retry_at) WHERE state = 'pending';
CREATE INDEX card_checks_meeting ON cards.card_checks (meeting_id);
CREATE INDEX card_checks_dup_card ON cards.card_checks (dup_card_id) WHERE dup_card_id IS NOT NULL;
CREATE INDEX card_checks_rel_card ON cards.card_checks (rel_card_id) WHERE rel_card_id IS NOT NULL;
GRANT SELECT, INSERT, UPDATE ON cards.card_checks TO bwat_cards;

ALTER TABLE cards.card_links DROP CONSTRAINT card_links_kind_check;
ALTER TABLE cards.card_links ADD CONSTRAINT card_links_kind_check
  CHECK (kind IN ('supersedes', 'answers', 'merges', 'todo_twin', 'related', 'not_duplicate', 'not_related'));
