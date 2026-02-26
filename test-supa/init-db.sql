-- AgentDB Supa: Multi-tenant Postgres initialization
-- Sets up roles, schema slots, auth helpers, and pre-request hook

-- =============================================================================
-- 1. Roles
-- =============================================================================

-- authenticator: login role used by PostgREST to connect
CREATE ROLE authenticator LOGIN PASSWORD 'authenticator' NOINHERIT;

-- anon: unauthenticated requests (read-only where allowed)
CREATE ROLE anon NOLOGIN;
GRANT anon TO authenticator;

-- authenticated: logged-in users (CRUD with RLS)
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO authenticator;

-- service_role: admin operations (bypasses RLS)
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT service_role TO authenticator;

-- =============================================================================
-- 2. Schema slots (p0001 - p0010)
-- =============================================================================

DO $$
BEGIN
  FOR i IN 1..10 LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS p%s', lpad(i::text, 4, '0'));
    -- Grant usage to all roles
    EXECUTE format('GRANT USAGE ON SCHEMA p%s TO anon, authenticated, service_role', lpad(i::text, 4, '0'));
    -- Default privileges: when postgres creates tables in these schemas,
    -- grant appropriate access to the roles
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT ON TABLES TO anon', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT ALL ON TABLES TO service_role', lpad(i::text, 4, '0'));
  END LOOP;
END
$$;

-- =============================================================================
-- 3. Internal schema (project + user metadata)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS internal;
GRANT USAGE ON SCHEMA internal TO authenticator, anon, authenticated, service_role;

CREATE TABLE internal.projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  schema_slot TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'prototype',
  status TEXT NOT NULL DEFAULT 'active',
  api_calls INTEGER NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
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

-- =============================================================================
-- 4. Auth schema (helper functions for RLS)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO authenticator, anon, authenticated, service_role;

-- auth.uid(): extract user ID from JWT
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::UUID;
$$;

-- auth.role(): extract role from JWT
CREATE OR REPLACE FUNCTION auth.role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'role', '');
$$;

-- auth.project_id(): extract project_id from JWT
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
  _schema := current_setting('pgrst.db_pre_request.current_schema', true);

  -- If no schema context set (shouldn't happen), allow through
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
