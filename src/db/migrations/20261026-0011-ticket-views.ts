import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F10, ticket list: sorting and saved views.
//
// - tickets.priority_rank: urgent 4 … low 1, generated from priority, so "highest priority first"
//   is a plain indexed sort and its cursor a plain comparison.
// - Indexes for the other sorts (created newest and oldest first, priority), each starting with
//   workspace_id and leaving out the trash.
// - ticket_views: saved filters and sort. A view belongs to the person who saved it, and admins and
//   supervisors can share one with everyone. Filters are stored as JSON in the list's own query
//   shape and checked by the API on every save.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      ALTER TABLE tickets ADD COLUMN priority_rank smallint GENERATED ALWAYS AS (
        CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END
      ) STORED`);
    await run(
      'CREATE INDEX tickets_workspace_created_idx ON tickets (workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL',
    );
    await run(
      'CREATE INDEX tickets_workspace_priority_idx ON tickets (workspace_id, priority_rank DESC, updated_at DESC, id DESC) WHERE deleted_at IS NULL',
    );

    await run(`
      CREATE TABLE ticket_views (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        owner_user_id uuid NOT NULL,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
        filters jsonb NOT NULL DEFAULT '{}',
        sort text NOT NULL DEFAULT 'updated' CHECK (sort IN ('updated', 'created', 'oldest', 'priority')),
        shared boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, owner_user_id) REFERENCES memberships (workspace_id, user_id)
          ON DELETE CASCADE
      )`);
    await run(
      'CREATE INDEX ticket_views_workspace_owner_idx ON ticket_views (workspace_id, owner_user_id)',
    );
    await run(
      'CREATE INDEX ticket_views_workspace_shared_idx ON ticket_views (workspace_id) WHERE shared',
    );
    await enableTenantIsolation(context, 'ticket_views', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await disableTenantIsolation(context, 'ticket_views', transaction);
    await run('DROP TABLE IF EXISTS ticket_views');
    await run('DROP INDEX IF EXISTS tickets_workspace_priority_idx');
    await run('DROP INDEX IF EXISTS tickets_workspace_created_idx');
    await run('ALTER TABLE tickets DROP COLUMN IF EXISTS priority_rank');
  });
}
