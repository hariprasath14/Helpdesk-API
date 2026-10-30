import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F5, audit log: who changed what in a workspace, and when.
//
// - A tenant table (row-level security by workspace_id).
// - Append-only for the app: helpdesk_app may INSERT and SELECT but not UPDATE, DELETE or
//   TRUNCATE, so neither a bug nor someone abusing the app can rewrite history. Removing old
//   entries (retention per plan, F30) will be a scheduled job with its own limited role.
// - The actor's name, email and role are copied at the time, so the entry still reads correctly
//   after a rename, a role change or a deactivation.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        actor_type text NOT NULL CHECK (actor_type IN ('member', 'support', 'system')),
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_name text NOT NULL,
        actor_email text,
        actor_role text CHECK (actor_role IN ('admin', 'supervisor', 'agent')),
        category text NOT NULL CHECK (category IN ('members', 'security', 'settings', 'sign_in')),
        action text NOT NULL,
        target_type text,
        target_id uuid,
        target_label text,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    // The list: newest first, with the id as a tie-breaker for the cursor.
    await run(
      'CREATE INDEX audit_events_workspace_created_idx ON audit_events (workspace_id, created_at DESC, id DESC)',
    );
    await run(
      'CREATE INDEX audit_events_workspace_actor_idx ON audit_events (workspace_id, actor_user_id, created_at DESC)',
    );
    await run(
      'CREATE INDEX audit_events_workspace_category_idx ON audit_events (workspace_id, category, created_at DESC)',
    );
    await run('CREATE INDEX audit_events_actor_user_idx ON audit_events (actor_user_id)');
    await enableTenantIsolation(context, 'audit_events', transaction);
    await run('REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM helpdesk_app');
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await disableTenantIsolation(context, 'audit_events', transaction);
    await q.query('DROP TABLE IF EXISTS audit_events', { transaction });
  });
}
