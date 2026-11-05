
ALTER TABLE cards.cards DROP CONSTRAINT cards_status_check;
ALTER TABLE cards.cards ADD CONSTRAINT cards_status_check
  CHECK (status IN ('draft', 'open', 'done', 'wont_do', 'no_response'));

ALTER TABLE cards.cards ADD COLUMN live_at timestamptz DEFAULT now(), ADD COLUMN accepted_at timestamptz;
ALTER TABLE cards.cards DISABLE TRIGGER cards_bump;
UPDATE cards.cards SET accepted_at = now() WHERE owner_member_id IS NOT NULL;
ALTER TABLE cards.cards ENABLE TRIGGER cards_bump;

CREATE INDEX cards_live ON cards.cards (live_at) WHERE status = 'open' AND NOT archived;
CREATE INDEX cards_drafts ON cards.cards (meeting_id) WHERE status = 'draft';
CREATE INDEX card_events_member ON cards.card_events (card_id, at) WHERE actor_kind = 'member';

GRANT UPDATE (live_at, accepted_at) ON cards.cards TO bwat_cards;

ALTER TABLE cards.reconciliation_jobs ADD COLUMN queued_at timestamptz NOT NULL DEFAULT now();
