-- Applied after Prisma schema migrate (see packages/db/scripts/apply-rls.mjs).
-- Enforces tenant isolation at the database layer.

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

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships',
    'subscriptions',
    'whatsapp_accounts',
    'contacts',
    'conversations',
    'messages',
    'catalog_products',
    'catalog_variants',
    'quotes',
    'quote_lines',
    'ai_runs',
    'api_keys',
    'auto_vehicles',
    'auto_fitments',
    'auto_oem_numbers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
       USING (tenant_id = app_current_tenant_id())
       WITH CHECK (tenant_id = app_current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- audit_logs: allow null tenant (platform events) or matching tenant
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id IS NULL OR tenant_id = app_current_tenant_id());
