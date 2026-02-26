-- Seed schema slots p0001 - p2000
-- Run this against Aurora after stack creation if init.sql wasn't run via custom resource
-- Usage: psql -h <aurora-endpoint> -U postgres -d agentdb -f scripts/seed-schemas.sql

DO $$
BEGIN
  FOR i IN 1..2000 LOOP
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS p%s', lpad(i::text, 4, '0'));
    EXECUTE format('GRANT USAGE ON SCHEMA p%s TO anon, authenticated, service_role', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT ON TABLES TO anon', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated', lpad(i::text, 4, '0'));
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA p%s GRANT ALL ON TABLES TO service_role', lpad(i::text, 4, '0'));
  END LOOP;
END
$$;

-- Verify
SELECT count(*) AS schema_count FROM information_schema.schemata WHERE schema_name ~ '^p\d{4}$';
