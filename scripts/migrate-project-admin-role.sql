-- Migration: Add project_admin role and is_admin column
-- Run against the production Aurora DB with a superuser connection.
-- Idempotent — safe to re-run.

-- 1. Create role (skip if exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_admin') THEN
    CREATE ROLE project_admin NOLOGIN BYPASSRLS;
    GRANT project_admin TO authenticator;
  END IF;
END $$;

-- 2. Grant schema usage and default privileges on all 2000 schema slots
DO $$
BEGIN
  FOR i IN 1..2000 LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA p%s TO project_admin', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO project_admin', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT USAGE, SELECT ON SEQUENCES TO project_admin', lpad(i::text, 4, '0'));

    -- Grant on existing tables (default privileges only apply to future tables)
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA p%s TO project_admin', lpad(i::text, 4, '0'));
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA p%s TO project_admin', lpad(i::text, 4, '0'));
  END LOOP;
END $$;

-- 3. Grant on internal and auth schemas
GRANT USAGE ON SCHEMA internal TO project_admin;
GRANT USAGE ON SCHEMA auth TO project_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO project_admin;
GRANT EXECUTE ON FUNCTION auth.role() TO project_admin;
GRANT EXECUTE ON FUNCTION auth.project_id() TO project_admin;
GRANT EXECUTE ON FUNCTION internal.pre_request() TO project_admin;

-- 4. Add is_admin column to internal.users
ALTER TABLE internal.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
