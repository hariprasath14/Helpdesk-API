import { PgBoss, type Db } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';

// F15, customer notification emails.
//
// - workspaces.customer_notifications: which emails customers get (Settings → Email): "we received
//   your request" (tickets raised by email or the web form), "your ticket is resolved", and "a
//   ticket was opened for you" (logged by an agent, off unless turned on).
// - The "customer-email" queue: one job per notification; the worker checks the setting when it
//   sends, so turning one off also stops those already queued.

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
  await q.query(`
    ALTER TABLE workspaces
      ADD COLUMN customer_notifications jsonb NOT NULL
        DEFAULT '{"received": true, "resolved": true, "agentCreated": false}'::jsonb`);
  await withBoss(q, async (boss) => {
    await boss.createQueue('customer-email', {
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
    await boss.deleteQueue('customer-email');
  });
  await q.query('ALTER TABLE workspaces DROP COLUMN IF EXISTS customer_notifications');
}
