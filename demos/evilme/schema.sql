-- EvilMe villain database schema
CREATE TABLE IF NOT EXISTS villains (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  real_name TEXT NOT NULL,
  fact TEXT NOT NULL,
  appearance TEXT DEFAULT '',
  villain_name TEXT NOT NULL,
  origin_story TEXT NOT NULL,
  evil_catchphrase TEXT NOT NULL,
  weakness TEXT NOT NULL,
  evil_power TEXT NOT NULL,
  threat_level TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  creator_ip TEXT DEFAULT '',
  elo_rating INTEGER NOT NULL DEFAULT 1200,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_villains_elo ON villains(elo_rating DESC);
CREATE INDEX IF NOT EXISTS idx_villains_created ON villains(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_villains_ip ON villains(creator_ip, created_at);
