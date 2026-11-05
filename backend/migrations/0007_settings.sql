
CREATE TABLE bwat.settings (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value      jsonb NOT NULL,
  revision   integer NOT NULL CHECK (revision >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.settings_version (
  id      boolean PRIMARY KEY DEFAULT true CHECK (id),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO bwat.settings_version (id, version) VALUES (true, 0);

CREATE TABLE bwat.dictionary (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  payload    jsonb NOT NULL CHECK (jsonb_typeof(payload) IN ('object', 'null')),
  revision   integer NOT NULL CHECK (revision >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bwat.secrets (
  name       text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9/_.-]{0,127}$'),
  ciphertext text NOT NULL CHECK (ciphertext LIKE 'pk1:%'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON bwat.settings TO bwat_runtime;
GRANT SELECT, UPDATE ON bwat.settings_version TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE ON bwat.dictionary TO bwat_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.secrets TO bwat_runtime;
