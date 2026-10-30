import type { QueryInterface, Transaction } from 'sequelize';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// Unset or reset settings come back as NULL or '' — both mean "no workspace", which matches no rows.
const CURRENT_WORKSPACE = "NULLIF(current_setting('app.workspace_id', true), '')::uuid";

function assertIdentifier(table: string) {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

/**
 * Turns on tenant isolation for a table that has a `workspace_id uuid NOT NULL` column. Call it in
 * the migration that creates every tenant table (ARCHITECTURE.md section 4).
 *
 * The policy applies to the app and readonly roles. The migrator owns the tables, so it is not
 * bound by the policy and can still run cross-workspace data migrations.
 */
export async function enableTenantIsolation(
  queryInterface: QueryInterface,
  table: string,
  transaction?: Transaction,
): Promise<void> {
  assertIdentifier(table);
  const options = transaction ? { transaction } : {};
  await queryInterface.sequelize.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, options);
  await queryInterface.sequelize.query(
    `CREATE POLICY tenant_isolation ON "${table}"
       USING (workspace_id = ${CURRENT_WORKSPACE})
       WITH CHECK (workspace_id = ${CURRENT_WORKSPACE})`,
    options,
  );
}

/** Reverses enableTenantIsolation, for use in a migration's `down`. */
export async function disableTenantIsolation(
  queryInterface: QueryInterface,
  table: string,
  transaction?: Transaction,
): Promise<void> {
  assertIdentifier(table);
  const options = transaction ? { transaction } : {};
  await queryInterface.sequelize.query(
    `DROP POLICY IF EXISTS tenant_isolation ON "${table}"`,
    options,
  );
  await queryInterface.sequelize.query(
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
    options,
  );
}
