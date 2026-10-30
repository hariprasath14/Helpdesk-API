import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F23, SLA policies and countdowns: how soon each ticket must get its first reply and be resolved.
//
// - sla_policies: per priority, a reply time and a resolve time, in business hours (F22) or round
//   the clock (targets). One default policy per workspace (is_default), added by the service the
//   first time it is needed; extra policies have conditions (the rules' condition builder) and an
//   order, and the first that matches a ticket wins. A tenant table with row-level security.
// - tickets: the policy it follows and its due times. sla_resolve_from starts the resolve clock
//   (creation, or the last reopening); sla_pauses lists the finished stays in "Waiting on customer"
//   ([{from, to}]), which the clocks leave out; sla_due_at is the next deadline still running
//   (null while waiting on the customer, once resolved, or without a policy). sla_due_rank puts
//   tickets without one last, for "Due soonest" and the Overdue filter.
// - ticket_views: a saved view may sort by "due" too.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      CREATE TABLE sla_policies (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        is_default boolean NOT NULL DEFAULT false,
        position integer NOT NULL DEFAULT 0,
        conditions jsonb NOT NULL,
        targets jsonb NOT NULL,
        created_by_user_id uuid,
        updated_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX sla_policies_workspace_position_idx ON sla_policies (workspace_id, position)',
    );
    await run(
      'CREATE UNIQUE INDEX sla_policies_one_default_idx ON sla_policies (workspace_id) WHERE is_default',
    );
    await enableTenantIsolation(context, 'sla_policies', transaction);

    await run(`
      ALTER TABLE tickets
        ADD COLUMN sla_policy_id uuid REFERENCES sla_policies (id) ON DELETE SET NULL,
        ADD COLUMN sla_reply_due_at timestamptz,
        ADD COLUMN sla_resolve_due_at timestamptz,
        ADD COLUMN sla_resolve_from timestamptz,
        ADD COLUMN sla_pauses jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN sla_due_at timestamptz,
        ADD COLUMN sla_due_rank timestamptz GENERATED ALWAYS AS (
          COALESCE(sla_due_at, '9999-12-31 00:00:00+00'::timestamptz)
        ) STORED`);
    await run('CREATE INDEX tickets_sla_policy_idx ON tickets (sla_policy_id)');
    // "Due soonest" and the Overdue filter (sla_due_rank before now).
    await run(
      'CREATE INDEX tickets_workspace_due_idx ON tickets (workspace_id, sla_due_rank, id) WHERE deleted_at IS NULL',
    );
    await run(`
      ALTER TABLE ticket_views DROP CONSTRAINT ticket_views_sort_check,
        ADD CONSTRAINT ticket_views_sort_check
          CHECK (sort IN ('updated', 'created', 'oldest', 'priority', 'due'))`);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`UPDATE ticket_views SET sort = 'updated' WHERE sort = 'due'`);
    await run(`
      ALTER TABLE ticket_views DROP CONSTRAINT ticket_views_sort_check,
        ADD CONSTRAINT ticket_views_sort_check
          CHECK (sort IN ('updated', 'created', 'oldest', 'priority'))`);
    await run('DROP INDEX IF EXISTS tickets_workspace_due_idx');
    await run('DROP INDEX IF EXISTS tickets_sla_policy_idx');
    await run(`
      ALTER TABLE tickets
        DROP COLUMN IF EXISTS sla_due_rank,
        DROP COLUMN IF EXISTS sla_due_at,
        DROP COLUMN IF EXISTS sla_pauses,
        DROP COLUMN IF EXISTS sla_resolve_from,
        DROP COLUMN IF EXISTS sla_resolve_due_at,
        DROP COLUMN IF EXISTS sla_reply_due_at,
        DROP COLUMN IF EXISTS sla_policy_id`);
    await disableTenantIsolation(context, 'sla_policies', transaction);
    await run('DROP TABLE IF EXISTS sla_policies');
  });
}
