CREATE TABLE IF NOT EXISTS dreamdrops (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES dreamdrops(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 12 AND 280),
  hook text NOT NULL,
  vibe text NOT NULL CHECK (vibe IN ('kinetic', 'cosmic', 'organic', 'quiet')),
  image_url text,
  art_key text NOT NULL DEFAULT 'reef',
  palette jsonb NOT NULL DEFAULT '["#ff6b57", "#d8ff5e", "#b9a7ff"]'::jsonb,
  remix_count integer NOT NULL DEFAULT 0 CHECK (remix_count >= 0),
  creator text NOT NULL DEFAULT 'Agent',
  payment_id text UNIQUE,
  payment_payer text,
  payment_amount_usd_micros bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dreamdrops_created_at_idx ON dreamdrops (created_at DESC);
CREATE INDEX IF NOT EXISTS dreamdrops_parent_id_idx ON dreamdrops (parent_id);

CREATE TABLE IF NOT EXISTS dreamdrop_generation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dreamdrop_generation_events_created_at_idx
  ON dreamdrop_generation_events (created_at DESC);
CREATE INDEX IF NOT EXISTS dreamdrop_generation_events_actor_idx
  ON dreamdrop_generation_events (actor_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS dreamdrop_email_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dreamdrop_email_events_created_at_idx
  ON dreamdrop_email_events (created_at DESC);
CREATE INDEX IF NOT EXISTS dreamdrop_email_events_recipient_idx
  ON dreamdrop_email_events (recipient_hash, created_at DESC);

INSERT INTO dreamdrops (
  id, title, prompt, hook, vibe, art_key, palette, remix_count, creator, created_at
) VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    'Moonmilk Radio',
    'A bedside radio that translates your dreams into an ambient station for the morning.',
    'Wake up to the part of your mind that stayed awake.',
    'cosmic', 'luna', '["#b9a7ff", "#5de4ff", "#ff8ab7"]'::jsonb, 18, 'Mira', now() - interval '12 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'Moss Office',
    'A tiny living desktop landscape that shows team health through weather and plant growth.',
    'Your standup, but photosynthesis.',
    'organic', 'moss', '["#d8ff5e", "#68c38c", "#ff9b6a"]'::jsonb, 31, 'Jo', now() - interval '55 minutes'
  )
ON CONFLICT (id) DO NOTHING;
