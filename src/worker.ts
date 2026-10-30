import { PgBoss } from 'pg-boss';
import pino from 'pino';
import { createEmailSender } from './adapters/email/index.js';
import { createInboundMailboxes } from './adapters/inbound-email/index.js';
import { createFileStorage } from './adapters/storage/index.js';
import { ConfigError, loadConfig } from './config/index.js';
import { createDatabase, isReachable } from './db/index.js';
import { registerJobs } from './jobs/handlers.js';
import { takeInboundEmail } from './jobs/inbound.js';
import { jobQueueFor, QUEUES, sequelizeAdapter } from './jobs/queue.js';
import { loggerOptions } from './lib/logger.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Background worker: sends ticket and assignment email, picks up email sent to workspace addresses
 * (F14) and runs the daily clean-up (pg-boss on the writer connection). It supervises the queues
 * and runs schedules; migrations own the schema.
 */
async function main() {
  const config = loadConfig();
  const log = pino({
    ...loggerOptions(config),
    base: { service: 'helpdesk-worker', version: config.APP_VERSION },
  });
  const db = createDatabase(config, 'helpdesk-worker');

  if (!(await isReachable(db.writer))) {
    log.fatal('database writer is not reachable');
    await db.close();
    process.exit(1);
  }

  const boss = new PgBoss({
    db: sequelizeAdapter(db.writer),
    schema: 'pgboss',
    supervise: true,
    schedule: true,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (err) => {
    log.error({ err }, 'job queue error');
  });
  await boss.start();
  const storage = createFileStorage(config);
  const jobs = jobQueueFor(boss, db.writer);
  await registerJobs(boss, { config, db, email: createEmailSender(config), storage, jobs }, log);

  // Picking up email sent to workspace addresses (F14) from each mailbox that is set.
  const mailboxes = createInboundMailboxes(config);
  const takeAll = async () => {
    for (const mailbox of mailboxes) {
      await takeInboundEmail(
        mailbox,
        storage,
        config.INBOUND_EMAIL_MAX_MB * 1024 * 1024,
        async (job) => {
          await boss.send(QUEUES.inboundEmail, { ...job });
        },
      );
    }
  };
  // The round in progress, if any; a round still running when the next is due skips that one.
  let polling: Promise<unknown> | null = null;
  const poller =
    mailboxes.length > 0
      ? setInterval(() => {
          polling ??= takeAll()
            .catch((err: unknown) => {
              log.warn({ err }, 'could not pick up inbound email');
            })
            .finally(() => {
              polling = null;
            });
        }, config.INBOUND_POLL_SECONDS * 1000)
      : null;
  log.info({ inbound: config.INBOUND_EMAIL_DRIVER.join(',') || 'none' }, 'worker started');

  // ECS sends SIGTERM before stopping a task: let running jobs finish, then exit.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'worker shutting down');
    if (poller) clearInterval(poller);
    Promise.resolve(polling)
      .then(() => boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS }))
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          log.error({ err }, 'error during worker shutdown');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  if (!(err instanceof ConfigError) && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
