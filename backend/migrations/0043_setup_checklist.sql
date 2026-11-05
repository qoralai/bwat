
CREATE TABLE bwat.setup_checklist_items (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  position   integer NOT NULL,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail     text NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  link       text CHECK (link ~ '^https://' AND length(link) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at    timestamptz,
  done_by    uuid
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.setup_checklist_items TO bwat_runtime;
