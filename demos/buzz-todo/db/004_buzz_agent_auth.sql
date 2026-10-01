-- Single-use NIP-98 authorization events for the MCP agent entrance. A request
-- is accepted only if its event id is new; rows older than the 60-second
-- freshness window are swept on later requests.
CREATE TABLE IF NOT EXISTS buzz_nostr_auth_seen (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f]{64}$'),
  seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS buzz_nostr_auth_seen_at_idx ON buzz_nostr_auth_seen (seen_at);
