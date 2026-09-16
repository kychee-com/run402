-- Cached Nostr profile (kind 0) for each Buzz user, read from the Buzz relay by
-- the app's own member identity. Display only; identity stays the pubkey.
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS picture text;
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS about text;
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS nip05 text;
ALTER TABLE buzz_users ADD COLUMN IF NOT EXISTS profile_fetched_at timestamptz;
