import { PgBoss, type Db } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F20, rules that run on a schedule ("3 days waiting on the customer: send a reminder").
//
// - tickets.status_changed_at: when the ticket reached its current status, for "hours in this
//   status". Existing tickets take their closed, resolved or last-changed time.
// - automation_rule_runs: which scheduled rule already ran for which ticket in which stay in a
//   status (anchor = status_changed_at), so each runs at most once per stay; the primary key also
//   stops two workers running the same one twice.
// - workspaces_with_time_rules(): which workspaces have scheduled rules turned on. Row-level
//   security limits the app role to one workspace at a time, so the worker asks this one function
//   (schema owner, SECURITY DEFINER, workspace ids only) and then works inside each workspace.
// - The "time-rules" queue: the worker's run every 15 minutes.

function adapter(sequelize: Sequelize): Db {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const [rows] = await sequelize.query(
        text,
        values && values.length > 0 ? { bind: values.map((value) => value ?? null) } : {},
      );
      return { rows: Array.isArray(rows) ? rows : [] };
    },
  };
}

async function withBoss(sequelize: Sequelize, work: (boss: PgBoss) => Promise<void>) {
  const boss = new PgBoss({
    db: adapter(sequelize),
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  await boss.start();
  try {
    await work(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('ALTER TABLE tickets ADD COLUMN status_changed_at timestamptz');
    await run(
      'UPDATE tickets SET status_changed_at = COALESCE(closed_at, resolved_at, updated_at)',
    );
    await run(
      'ALTER TABLE tickets ALTER COLUMN status_changed_at SET NOT NULL, ALTER COLUMN status_changed_at SET DEFAULT now()',
    );
    // The scheduled run looks at tickets that are not closed, oldest in their status first.
    await run(
      `CREATE INDEX tickets_status_changed_idx ON tickets (workspace_id, status_changed_at)
         WHERE deleted_at IS NULL AND status <> 'closed'`,
    );

    await run(`
      CREATE TABLE automation_rule_runs (
        rule_id uuid NOT NULL REFERENCES automation_rules (id) ON DELETE CASCADE,
        ticket_id uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        anchor timestamptz NOT NULL,
        ran_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, ticket_id, anchor)
      )`);
    await run('CREATE INDEX automation_rule_runs_ticket_idx ON automation_rule_runs (ticket_id)');
    await enableTenantIsolation(context, 'automation_rule_runs', transaction);

    await run(`
      CREATE FUNCTION workspaces_with_time_rules()
        RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
      AS $$
        SELECT DISTINCT workspace_id FROM automation_rules WHERE event = 'time' AND enabled
      $$`);
    await run('REVOKE ALL ON FUNCTION workspaces_with_time_rules() FROM PUBLIC');
    await run('GRANT EXECUTE ON FUNCTION workspaces_with_time_rules() TO helpdesk_app');
  });
  await withBoss(q, async (boss) => {
    await boss.createQueue('time-rules', { retryLimit: 1, expireInSeconds: 900 });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await withBoss(q, async (boss) => {
    await boss.deleteQueue('time-rules');
  });
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP FUNCTION IF EXISTS workspaces_with_time_rules()');
    await disableTenantIsolation(context, 'automation_rule_runs', transaction);
    await run('DROP TABLE IF EXISTS automation_rule_runs');
    await run('DROP INDEX IF EXISTS tickets_status_changed_idx');
    await run('ALTER TABLE tickets DROP COLUMN IF EXISTS status_changed_at');
  });
}
