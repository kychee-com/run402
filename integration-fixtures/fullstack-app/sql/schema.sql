CREATE TABLE IF NOT EXISTS fs_accounts (
  id serial PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_items (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES fs_accounts(id) ON DELETE CASCADE,
  marker text UNIQUE NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_runtime_events (
  id serial PRIMARY KEY,
  kind text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fs_owned_notes (
  id serial PRIMARY KEY,
  owner_id text NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fs_items_account_id_idx ON fs_items(account_id);
CREATE INDEX IF NOT EXISTS fs_runtime_events_kind_created_idx ON fs_runtime_events(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS fs_owned_notes_owner_id_idx ON fs_owned_notes(owner_id);

CREATE OR REPLACE FUNCTION fs_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fs_runtime_events_touch_updated_at ON fs_runtime_events;
CREATE TRIGGER fs_runtime_events_touch_updated_at
BEFORE UPDATE ON fs_runtime_events
FOR EACH ROW
EXECUTE FUNCTION fs_touch_updated_at();
