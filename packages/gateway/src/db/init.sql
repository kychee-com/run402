-- AgentDB v1.0: Multi-tenant Postgres initialization
-- Sets up roles, schema slots (2000), auth helpers, refresh tokens, and pre-request hook

-- =============================================================================
-- 1. Roles
-- =============================================================================

CREATE ROLE authenticator LOGIN PASSWORD 'authenticator' NOINHERIT;
CREATE ROLE anon NOLOGIN;
GRANT anon TO authenticator;
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO authenticator;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT service_role TO authenticator;

-- =============================================================================
-- 2. Schema slots (p0001 - p2000)
-- =============================================================================

DO $$
BEGIN
  FOR i IN 1..2000 LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS p%s', lpad(i::text, 4, '0'));
    EXECUTE format('GRANT USAGE ON SCHEMA p%s TO anon, authenticated, service_role', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT ON TABLES TO anon', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT ALL ON TABLES TO service_role', lpad(i::text, 4, '0'));
    -- Sequences (needed for SERIAL/BIGSERIAL columns)
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated, service_role', lpad(i::text, 4, '0'));
  END LOOP;
END
$$;

-- =============================================================================
-- 3. Internal schema (project + user + refresh token metadata)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS internal;
GRANT USAGE ON SCHEMA internal TO authenticator, anon, authenticated, service_role;

CREATE SEQUENCE internal.slot_seq MAXVALUE 2000 NO CYCLE;

CREATE TABLE internal.projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_slot TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'prototype',
  status TEXT NOT NULL DEFAULT 'active',
  api_calls INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE internal.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES internal.projects(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, email)
);

CREATE TABLE internal.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES internal.users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES internal.projects(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON internal.refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_project ON internal.refresh_tokens(project_id);
CREATE INDEX idx_projects_status ON internal.projects(status);

-- =============================================================================
-- 4. Auth schema (helper functions for RLS)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO authenticator, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::UUID;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'role', '');
$$;

CREATE OR REPLACE FUNCTION auth.project_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'project_id', '');
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.project_id() TO anon, authenticated, service_role;

-- =============================================================================
-- 5. Pre-request hook (validates JWT project_id matches accessed schema)
-- Uses current_setting('request.header.accept-profile', true) per lesson #7
-- =============================================================================

CREATE OR REPLACE FUNCTION internal.pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  _role TEXT;
  _project_id TEXT;
  _schema TEXT;
  _expected_slot TEXT;
BEGIN
  _role := current_setting('request.jwt.claims', true)::json->>'role';

  -- Allow anon requests through (no project validation needed for anon)
  IF _role IS NULL OR _role = 'anon' THEN
    RETURN;
  END IF;

  _project_id := current_setting('request.jwt.claims', true)::json->>'project_id';
  _schema := current_setting('request.header.accept-profile', true);

  -- If no schema context set, allow through
  IF _schema IS NULL OR _schema = '' THEN
    RETURN;
  END IF;

  -- Look up expected schema slot for this project
  SELECT schema_slot INTO _expected_slot
  FROM internal.projects
  WHERE id = _project_id AND status = 'active';

  -- Validate: JWT project must match the schema being accessed
  IF _expected_slot IS NULL OR _expected_slot != _schema THEN
    RAISE EXCEPTION 'JWT project_id does not match accessed schema'
      USING HINT = 'Check your API key and project configuration';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION internal.pre_request() TO authenticator, anon, authenticated, service_role;

-- =============================================================================
-- 6. Event trigger: auto-reload PostgREST schema cache on DDL changes
-- =============================================================================

CREATE OR REPLACE FUNCTION internal.notify_pgrst()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END;
$$;

CREATE EVENT TRIGGER pgrst_reload ON ddl_command_end
  EXECUTE FUNCTION internal.notify_pgrst();
