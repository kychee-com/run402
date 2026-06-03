-- EvilMe — schema + Row-Level Security.
--
-- The modern run402 RLS model: policies key off run402.current_user_id() (the
-- cookie-session user the gateway resolves), NOT a hand-parsed JWT claim. db(req)
-- mints a short-lived actor JWT per request so current_user_id() resolves; you
-- never plumb a user id by hand, and you never add a redundant
-- `.eq("user_id", …)` filter (that deploy-fails with R402_AUTH_REDUNDANT_USER_FILTER).

create table if not exists villains (
  id            uuid primary key default gen_random_uuid(),
  -- Owner is filled by the column DEFAULT, so the insert never passes user_id
  -- and the WITH CHECK policy below still binds it to the signed-in user.
  user_id       uuid not null default run402.current_user_id(),
  real_name     text not null,
  fact          text not null,
  appearance    text not null default '',
  villain_name  text not null,
  origin_story  text not null,
  catchphrase   text not null,
  weakness      text not null,
  power         text not null,
  threat_level  text not null,
  -- The full AssetRef JSONB that assets.put() returned — store the whole object
  -- (not just a URL) so variant SHAs + immutable URLs survive the round-trip and
  -- <Run402Picture asset={...}> can render straight from the row.
  portrait      jsonb,
  elo           integer not null default 1200,
  created_at    timestamptz not null default now()
);

alter table villains enable row level security;

-- The gallery / arena / leaderboard are public — anyone (even anonymous) reads all.
create policy villains_public_read on villains
  for select using (true);

-- Only a signed-in user can forge a villain, and only as themselves.
create policy villains_owner_insert on villains
  for insert to authenticated
  with check (user_id = run402.current_user_id());

create policy villains_owner_update on villains
  for update to authenticated
  using (user_id = run402.current_user_id())
  with check (user_id = run402.current_user_id());

create policy villains_owner_delete on villains
  for delete to authenticated
  using (user_id = run402.current_user_id());

create index if not exists villains_elo_idx on villains (elo desc, created_at desc);
create index if not exists villains_user_idx on villains (user_id, created_at desc);

-- Votes: one row per (voter, exact matchup). The voter owns their vote (RLS),
-- but the Elo tally itself is a platform-mediated action done through adminDb()
-- in the vote API — a villain's rating must move even when its owner is absent.
create table if not exists votes (
  id          uuid primary key default gen_random_uuid(),
  voter_id    uuid not null default run402.current_user_id(),
  winner_id   uuid not null references villains(id) on delete cascade,
  loser_id    uuid not null references villains(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (voter_id, winner_id, loser_id)
);

alter table votes enable row level security;

create policy votes_owner_insert on votes
  for insert to authenticated
  with check (voter_id = run402.current_user_id());

create policy votes_owner_read on votes
  for select to authenticated
  using (voter_id = run402.current_user_id());
