
ALTER TABLE cards.cards
  DROP COLUMN goal_id,
  DROP COLUMN goal_set_by;

DROP TABLE bwat.goals;

WITH gone AS (
  DELETE FROM bwat.settings WHERE key IN ('goals.timezone', 'goals.review_meeting_patterns') RETURNING 1
)
UPDATE bwat.settings_version SET version = version + 1 WHERE EXISTS (SELECT 1 FROM gone);
ALTER TABLE bwat.settings DROP CONSTRAINT settings_key_check;
ALTER TABLE bwat.settings ADD CONSTRAINT settings_key_check CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$');
