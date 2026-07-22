/**
 * Apply RLS policies after `prisma migrate`.
 * Usage: node packages/db/scripts/apply-rls.mjs
 * Requires DATABASE_URL and `psql` OR runs via prisma.$executeRaw in future.
 *
 * For v1 we document: run the SQL file with:
 *   psql $DATABASE_URL -f packages/db/prisma/migrations/rls_policies.sql
 *
 * Until then, app-layer tenant_id filters are mandatory on every query.
 */
console.log(
  "Apply RLS with: psql \"$DATABASE_URL\" -f packages/db/prisma/migrations/rls_policies.sql",
);
