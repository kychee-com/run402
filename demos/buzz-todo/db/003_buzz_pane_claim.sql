-- In-pane sign-in: the tab that started the challenge can claim the session
-- after another tab (or the system browser) completed it. The claim token is
-- known only to the starting tab (it is not in the deep link), stored hashed.
ALTER TABLE buzz_challenges ADD COLUMN IF NOT EXISTS claim_token_hash text;
ALTER TABLE buzz_challenges ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
