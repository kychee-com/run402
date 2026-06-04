-- Shared to-do list — schema + Row-Level Security.
--
-- The modern run402 RLS model: policies key off run402.current_user_id() (the
-- cookie-session user the gateway resolves per request), NOT the legacy
-- `current_setting('request.jwt.claims', …)->>'sub'` claim plumbing. db(req)
-- mints a short-lived actor JWT so current_user_id() resolves; you never thread a
-- user id by hand, and never add a redundant `.eq("user_id", …)` filter
-- (that deploy-fails with R402_AUTH_REDUNDANT_USER_FILTER).

create table if not exists todos (
  id          uuid primary key default gen_random_uuid(),
  -- Owner is filled by the column DEFAULT, so inserts never carry user_id and
  -- the WITH CHECK policy still binds the row to the signed-in user.
  user_id     uuid not null default run402.current_user_id(),
  text        text not null,
  done        boolean not null default false,
  created_at  timestamptz not null default now()
);

alter table todos enable row level security;

-- Shared: ANY signed-in user reads the whole list...
create policy todos_shared_read on todos
  for select to authenticated
  using (true);

-- ...but you can only add / edit / remove your OWN items. The owner-only UPDATE
-- and DELETE policies are what make "I can see your todo but can't touch it"
-- true at the database, not just in the UI.
create policy todos_owner_insert on todos
  for insert to authenticated
  with check (user_id = run402.current_user_id());

create policy todos_owner_update on todos
  for update to authenticated
  using (user_id = run402.current_user_id())
  with check (user_id = run402.current_user_id());

create policy todos_owner_delete on todos
  for delete to authenticated
  using (user_id = run402.current_user_id());

create index if not exists todos_created_idx on todos (created_at desc);
