import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F21, canned responses: saved replies an agent drops into the composer, with placeholders such as
// {{contact.first_name}} filled in for the ticket.
//
// - canned_responses: owner_user_id is the person a personal one belongs to; NULL means shared with
//   everyone in the workspace (admins and supervisors manage those). A personal one goes when its
//   owner leaves the workspace; shared ones stay. created_by_user_id only shows who wrote it.
// A tenant table with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      CREATE TABLE canned_responses (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        owner_user_id uuid,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
        body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
        created_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships (workspace_id, user_id)
          ON DELETE CASCADE
      )`);
    await run(
      'CREATE INDEX canned_responses_workspace_owner_idx ON canned_responses (workspace_id, owner_user_id)',
    );
    await enableTenantIsolation(context, 'canned_responses', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await disableTenantIsolation(context, 'canned_responses', transaction);
    await q.query('DROP TABLE IF EXISTS canned_responses', { transaction });
  });
}
