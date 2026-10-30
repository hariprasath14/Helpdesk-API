import { PgBoss, type Db, type Queue } from 'pg-boss';
import type { Sequelize, Transaction } from 'sequelize';

/**
 * The background job queues (pg-boss, in the "pgboss" schema). Each is created by a migration,
 * because the app role cannot create tables; a new queue needs a migration too.
 */
export const QUEUES = {
  /** Send one reply or forward by email (F13). */
  ticketEmail: 'ticket-email',
  /** Tell a member a ticket was assigned to them (F12, sent from F13). */
  assignmentEmail: 'assignment-email',
  /** Daily: remove uploads that were never sent with a message (F11). */
  cleanUploads: 'clean-uploads',
  /** Turn one received email into a ticket or a reply (F14). */
  inboundEmail: 'inbound-email',
  /** Tell a customer we received their request, or resolved it (F15). */
  customerEmail: 'customer-email',
  /** A rule's email to a ticket's assignee or team leads (F19). */
  teamEmail: 'team-email',
  /** Every 15 minutes: rules that run on a schedule (F20). */
  timeRules: 'time-rules',
  /** Every minute: SLA warnings and escalations that are due (F24). */
  slaCheck: 'sla-check',
  /** An email to members about a ticket, such as an SLA warning (F24). */
  memberNotice: 'member-notice',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Email jobs try 5 times over about 15 minutes before the message is marked failed. */
export const EMAIL_RETRY: Omit<Queue, 'name'> = {
  retryLimit: 4,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 300,
};

/**
 * pg-boss over an existing Sequelize connection pool, so jobs use the app's connections (and its
 * settings: SSL, statement timeout) instead of a second pool. Inside `transaction`, a job is
 * saved with the data that caused it, or not at all.
 */
export function sequelizeAdapter(sequelize: Sequelize, transaction?: Transaction): Db {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const [rows] = await sequelize.query(text, {
        // pg-boss leaves optional values undefined; Sequelize needs every bound value set.
        ...(values && values.length > 0 ? { bind: values.map((value) => value ?? null) } : {}),
        ...(transaction ? { transaction } : {}),
      });
      return { rows: Array.isArray(rows) ? rows : [] };
    },
  };
}

/** What the API and services need from the queue: adding jobs. */
export interface JobQueue {
  /** Adds a job inside the caller's transaction, so it exists only if the change is saved. */
  enqueue(
    queue: QueueName,
    data: Record<string, unknown>,
    transaction: Transaction,
    options?: { startAfterSeconds?: number },
  ): Promise<void>;
  stop(): Promise<void>;
}

/** Adding jobs through a running pg-boss, inside the caller's transaction. */
export function jobQueueFor(boss: PgBoss, sequelize: Sequelize): Pick<JobQueue, 'enqueue'> {
  return {
    async enqueue(queue, data, transaction, options = {}) {
      await boss.send(queue, data, {
        db: sequelizeAdapter(sequelize, transaction),
        ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      });
    },
  };
}

/**
 * The API's queue: it only adds jobs. Supervision, schedules and schema changes stay off (the
 * worker supervises; migrations own the schema). pg-boss starts on the first job, so building the
 * app (tests, the OpenAPI export) needs no database.
 */
export function createJobQueue(sequelize: Sequelize): JobQueue {
  const boss = new PgBoss({
    db: sequelizeAdapter(sequelize),
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  const queue = jobQueueFor(boss, sequelize);
  let started: Promise<unknown> | null = null;
  const start = () => {
    started ??= boss.start().catch((error: unknown) => {
      started = null;
      throw error;
    });
    return started;
  };
  return {
    async enqueue(...args) {
      await start();
      await queue.enqueue(...args);
    },
    async stop() {
      if (started) await boss.stop({ graceful: false });
    },
  };
}
