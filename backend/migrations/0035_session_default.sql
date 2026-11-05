ALTER TABLE bwat.sessions ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX sessions_one_default ON bwat.sessions (member_id) WHERE is_default;
