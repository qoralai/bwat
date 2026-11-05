
CREATE TABLE bwat.presence_image (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bwat.presence_image TO bwat_runtime;
