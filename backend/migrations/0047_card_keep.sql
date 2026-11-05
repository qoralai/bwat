CREATE INDEX card_events_keep ON cards.card_events (card_id) WHERE action = 'card.keep';
