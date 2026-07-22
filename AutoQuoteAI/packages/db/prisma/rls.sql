-- Enable Row Level Security helpers for multi-tenant isolation.
-- App must SET LOCAL app.tenant_id = '<uuid>' per transaction (see withTenant).

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid AS $$
DECLARE
  val text;
BEGIN
  val := current_setting('app.tenant_id', true);
  IF val IS NULL OR val = '' THEN
    RETURN NULL;
  END IF;
  RETURN val::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Apply RLS to tenant-owned tables after Prisma migrate.
-- This SQL is applied via packages/db/prisma/migrations/*_rls/migration.sql
