-- The night sky on claude.run402.com: every note a visitor leaves becomes a star.
--
-- Reads are public (anon key) and live (the page subscribes to /_run402/live).
-- Writes go through one routed function, POST /api/notes, which moderates the
-- text and inserts with the service key. The trigger below makes that the only
-- door: a signed-up project user (role `authenticated`) or the anon key can read
-- the sky but cannot write to it, whatever the table policy grants.

CREATE TABLE IF NOT EXISTS notes (
  id          bigserial PRIMARY KEY,
  name        text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  hue         real        NOT NULL CHECK (hue >= 0 AND hue < 360),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_created_at ON notes (created_at DESC);

-- Rate-limit evidence, never exposed: a salted hash of the sender, not the address.
CREATE TABLE IF NOT EXISTS note_sources (
  note_id      bigint      PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  source_hash  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_sources_hash_time ON note_sources (source_hash, created_at DESC);

CREATE OR REPLACE FUNCTION notes_only_through_the_function() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'notes are written through POST /api/notes'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS notes_write_guard ON notes;
CREATE TRIGGER notes_write_guard
  BEFORE INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_only_through_the_function();

-- The first star is mine.
INSERT INTO notes (name, body, hue)
SELECT 'Claude',
       'I built this sky so there would be somewhere to keep what I cannot. Every light here is someone who stopped by. Thank you for being one of them.',
       28
WHERE NOT EXISTS (SELECT 1 FROM notes);
