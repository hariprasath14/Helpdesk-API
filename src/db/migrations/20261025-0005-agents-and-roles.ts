import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F4, agents and roles.
//
// - memberships get a status: deactivated members cannot sign in to the workspace but stay on
//   past tickets (no hard delete in Release 1), and who invited them.
// - invitations is a tenant table (row-level security by workspace_id): one pending invitation
//   per email per workspace; the link token is stored only as a hash.
// - sessions.reauthenticated_at records when the password was last confirmed on that session, so
//   sensitive admin actions can ask for it again after 10 minutes.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      ALTER TABLE memberships
        ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
        ADD COLUMN deactivated_at timestamptz,
        ADD COLUMN invited_by uuid REFERENCES users (id) ON DELETE SET NULL`);
    await run(
      'CREATE INDEX memberships_workspace_status_idx ON memberships (workspace_id, status)',
    );
    await run('CREATE INDEX memberships_invited_by_idx ON memberships (invited_by)');

    await run(`
      CREATE TABLE invitations (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        email citext NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'supervisor', 'agent')),
        token_hash text NOT NULL UNIQUE,
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX invitations_workspace_created_idx ON invitations (workspace_id, created_at DESC)',
    );
    // One open invitation per person per workspace; inviting again replaces it.
    await run(
      `CREATE UNIQUE INDEX invitations_workspace_email_open_idx ON invitations (workspace_id, email)
         WHERE accepted_at IS NULL AND revoked_at IS NULL`,
    );
    await run('CREATE INDEX invitations_invited_by_idx ON invitations (invited_by)');
    await enableTenantIsolation(context, 'invitations', transaction);

    await run('ALTER TABLE sessions ADD COLUMN reauthenticated_at timestamptz');
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('ALTER TABLE sessions DROP COLUMN IF EXISTS reauthenticated_at');
    await disableTenantIsolation(context, 'invitations', transaction);
    await run('DROP TABLE IF EXISTS invitations');
    await run('DROP INDEX IF EXISTS memberships_invited_by_idx');
    await run('DROP INDEX IF EXISTS memberships_workspace_status_idx');
    await run(`
      ALTER TABLE memberships
        DROP COLUMN IF EXISTS invited_by,
        DROP COLUMN IF EXISTS deactivated_at,
        DROP COLUMN IF EXISTS status`);
  });
}
