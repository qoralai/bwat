ALTER TABLE bwat.zoom_pairings
  ADD COLUMN audience text NOT NULL DEFAULT 'zoom' CHECK (audience ~ '^[a-z][a-z0-9-]*$');
