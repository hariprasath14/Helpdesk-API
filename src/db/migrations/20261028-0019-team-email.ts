import { PgBoss, type Db } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';

// F19, emails from rules to the team: the "team-email" queue, one job per email a rule sends to
// a ticket's assignee or its team's leads. (Rule emails to the requester are replies on the ticket
// and go through the ticket-email queue.)

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
  await withBoss(context.sequelize, async (boss) => {
    await boss.createQueue('team-email', {
      retryLimit: 4,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 600,
      expireInSeconds: 300,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await withBoss(context.sequelize, async (boss) => {
    await boss.deleteQueue('team-email');
  });
}
