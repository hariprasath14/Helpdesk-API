import { PgBoss, type Db } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';

// F24, SLA warning and escalation: before a deadline the assignee (or the team's leads) is warned;
// at the deadline the ticket is marked overdue, the leads are told and it may be reassigned.
//
// - sla_policies.escalation: {"warnMinutes": 10 or null for no warning, "reassign": "nobody" |
//   "team_lead" | "person" | "team", "reassignUserId": the person, or null}.
// - tickets.sla_alerts: which warnings and escalations were done, {"reply:warning": <anchor>, ...},
//   where the anchor is when that clock started (creation, or the reopening for resolve), so each
//   happens once per ticket and again only after a reopening. tickets.sla_alert_at: the next
//   moment one is due (null when none is), which the worker's check looks for.
// - workspaces_with_sla_alerts(): which workspaces have one due. Row-level security limits the app
//   role to one workspace at a time, so the worker asks this one function (schema owner, SECURITY
//   DEFINER, workspace ids only) and then works inside each workspace.
// - Queues: "sla-check" (the worker's check every minute) and "member-notice" (an email to a
//   member about a ticket).

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
    await run(`
      ALTER TABLE sla_policies ADD COLUMN escalation jsonb NOT NULL
        DEFAULT '{"warnMinutes": 10, "reassign": "nobody", "reassignUserId": null}'`);
    await run(`
      ALTER TABLE tickets
        ADD COLUMN sla_alerts jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN sla_alert_at timestamptz`);
    // The worker's check: across workspaces (the function), then inside one.
    await run(
      'CREATE INDEX tickets_sla_alert_idx ON tickets (sla_alert_at) WHERE sla_alert_at IS NOT NULL AND deleted_at IS NULL',
    );
    await run(
      'CREATE INDEX tickets_workspace_sla_alert_idx ON tickets (workspace_id, sla_alert_at) WHERE sla_alert_at IS NOT NULL AND deleted_at IS NULL',
    );
    await run(`
      CREATE FUNCTION workspaces_with_sla_alerts(due timestamptz)
        RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
      AS $$
        SELECT DISTINCT workspace_id FROM tickets
        WHERE sla_alert_at IS NOT NULL AND sla_alert_at <= due AND deleted_at IS NULL
      $$`);
    await run('REVOKE ALL ON FUNCTION workspaces_with_sla_alerts(timestamptz) FROM PUBLIC');
    await run('GRANT EXECUTE ON FUNCTION workspaces_with_sla_alerts(timestamptz) TO helpdesk_app');
  });
  await withBoss(q, async (boss) => {
    await boss.createQueue('sla-check', { retryLimit: 1, expireInSeconds: 120 });
    await boss.createQueue('member-notice', {
      retryLimit: 4,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 300,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await withBoss(q, async (boss) => {
    await boss.deleteQueue('member-notice');
    await boss.deleteQueue('sla-check');
  });
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP FUNCTION IF EXISTS workspaces_with_sla_alerts(timestamptz)');
    await run('DROP INDEX IF EXISTS tickets_workspace_sla_alert_idx');
    await run('DROP INDEX IF EXISTS tickets_sla_alert_idx');
    await run(
      'ALTER TABLE tickets DROP COLUMN IF EXISTS sla_alert_at, DROP COLUMN IF EXISTS sla_alerts',
    );
    await run('ALTER TABLE sla_policies DROP COLUMN IF EXISTS escalation');
  });
}
