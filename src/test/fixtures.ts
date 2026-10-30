import { randomUUID } from 'node:crypto';
import { enableTenantIsolation } from '../db/rls.js';
import { TEST_DATABASE, testMigratorConnection } from './helpers.js';

export interface ProbeTable {
  /** Unique table name for this test run. */
  name: string;
  /** Inserts a row as the table owner (bypassing RLS) and returns its id. */
  insert(workspaceId: string, note: string): Promise<number>;
  drop(): Promise<void>;
}

/**
 * A throwaway tenant table (`id`, `workspace_id`, `note`) for testing the database and HTTP
 * plumbing before real feature tables exist. Created in the test database and, with the same
 * schema but no rows, in the stale replica. Pass `isolated: false` to leave row-level security
 * off, which simulates a migration that forgot `enableTenantIsolation()`.
 */
export async function createProbeTable({ isolated = true } = {}): Promise<ProbeTable> {
  const name = `probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const primary = testMigratorConnection();
  const replica = testMigratorConnection(TEST_DATABASE.replicaMigrator);

  for (const connection of [primary, replica]) {
    await connection.query(
      `CREATE TABLE "${name}" (
         id serial PRIMARY KEY,
         workspace_id uuid NOT NULL,
         note text NOT NULL
       )`,
    );
    await connection.query(`CREATE INDEX ON "${name}" (workspace_id)`);
    if (isolated) await enableTenantIsolation(connection.getQueryInterface(), name);
  }

  return {
    name,
    async insert(workspaceId, note) {
      const [rows] = await primary.query(
        `INSERT INTO "${name}" (workspace_id, note) VALUES (:workspaceId, :note) RETURNING id`,
        { replacements: { workspaceId, note } },
      );
      return (rows as { id: number }[])[0]?.id ?? Number.NaN;
    },
    async drop() {
      for (const connection of [primary, replica]) {
        await connection.query(`DROP TABLE IF EXISTS "${name}"`);
        await connection.close();
      }
    },
  };
}
