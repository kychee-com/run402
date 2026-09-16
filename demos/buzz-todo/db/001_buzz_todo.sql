-- Buzz To-Do: a tenant app that signs users in with Buzz (Nostr) identities.
-- Everything here is project-local. A Buzz pubkey is a tenant user; nothing in
-- this schema touches Run402 control-plane identity, membership, or authority.

CREATE TABLE IF NOT EXISTS buzz_users (
  pubkey text PRIMARY KEY CHECK (pubkey ~ '^[0-9a-f]{64}$'),
  npub text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);

-- One row per "Sign in with Buzz" click. Buzz Desktop signs a kind-24243 event
-- whose tags must echo these values exactly; expires_at is kept as the exact
-- RFC 3339 string that went into the deep link so the tag comparison is bytewise.
CREATE TABLE IF NOT EXISTS buzz_challenges (
  id uuid PRIMARY KEY,
  nonce text NOT NULL UNIQUE,
  verification_code text NOT NULL,
  origin text NOT NULL,
  expires_at text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  pubkey text
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pubkey text NOT NULL REFERENCES buzz_users(pubkey) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_pubkey_created_idx ON tasks (pubkey, created_at);
CREATE INDEX IF NOT EXISTS buzz_challenges_created_idx ON buzz_challenges (created_at);
