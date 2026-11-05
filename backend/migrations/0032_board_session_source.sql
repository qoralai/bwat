ALTER TABLE bwat.zoom_board_sessions
  ADD COLUMN source text CHECK (source ~ '^[a-z][a-z0-9-]*$');

CREATE INDEX zoom_board_sessions_member_source ON bwat.zoom_board_sessions (member_id, source);
