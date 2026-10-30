import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { cleanAbandonedUploads } from '../modules/conversation/attachments.service.js';
import {
  sendAssignmentEmail,
  sendCustomerEmail,
  sendMemberNotice,
  sendTeamEmail,
  sendTicketEmail,
  type OutgoingDeps,
} from '../modules/email/outgoing.service.js';
import type { CustomerEmailEvent } from '../modules/email/templates.js';
import { cleanOldNotifications } from '../modules/notifications/notifications.service.js';
import type { MemberNotice } from '../modules/notifications/notify.js';
import { runTimeRules } from '../modules/rules/schedule.js';
import { runSlaChecks } from '../modules/sla/escalation.js';
import { handleInboundEmail, type InboundEmailJob } from './inbound.js';
import { QUEUES, type JobQueue } from './queue.js';

/** The clean-up runs once a day, at 03:30 India time (a quiet hour). */
const CLEAN_UPLOADS_CRON = '30 3 * * *';
const CLEAN_UPLOADS_TZ = 'Asia/Kolkata';

/** Scheduled rules (F20) run every 15 minutes. */
const TIME_RULES_CRON = '*/15 * * * *';

/** SLA warnings and escalations (F24) are checked every minute. */
const SLA_CHECK_CRON = '* * * * *';

/** Emails in flight at once per worker; SES allows far more, Mailpit does not mind. */
const EMAIL_CONCURRENCY = 4;

interface TicketEmailJob {
  workspaceId: string;
  messageId: string;
}

interface CustomerEmailJob {
  workspaceId: string;
  ticketId: string;
  event: CustomerEmailEvent;
  mergedInto?: number;
  agentName?: string;
}

interface TeamEmailJob {
  workspaceId: string;
  ticketId: string;
  to: 'assignee' | 'team_leads';
  ruleName: string;
  text: string;
}

interface AssignmentEmailJob {
  workspaceId: string;
  ticketId: string;
  assigneeUserId: string;
  assignedBy: string;
}

/**
 * Starts the worker's job handlers and schedules. A handler that throws lets pg-boss retry the
 * job with the queue's retry settings (see the outgoing-email migration).
 */
export async function registerJobs(
  boss: PgBoss,
  deps: OutgoingDeps & { jobs: Pick<JobQueue, 'enqueue'> },
  log: Logger,
): Promise<void> {
  // Every type argument is given: naming only the job data would drop includeMetadata's type.
  await boss.work<TicketEmailJob, unknown, { includeMetadata: true; localConcurrency: number }>(
    QUEUES.ticketEmail,
    { includeMetadata: true, localConcurrency: EMAIL_CONCURRENCY },
    async ([job]) => {
      if (!job) return;
      await sendTicketEmail(
        deps,
        job.data,
        { retryCount: job.retryCount, retryLimit: job.retryLimit },
        log,
      );
    },
  );

  await boss.work<AssignmentEmailJob>(
    QUEUES.assignmentEmail,
    { localConcurrency: EMAIL_CONCURRENCY },
    async ([job]) => {
      if (job) await sendAssignmentEmail(deps, job.data);
    },
  );

  await boss.work<CustomerEmailJob>(
    QUEUES.customerEmail,
    { localConcurrency: EMAIL_CONCURRENCY },
    async ([job]) => {
      if (job) await sendCustomerEmail(deps, job.data);
    },
  );

  await boss.work<TeamEmailJob>(
    QUEUES.teamEmail,
    { localConcurrency: EMAIL_CONCURRENCY },
    async ([job]) => {
      if (job) await sendTeamEmail(deps, job.data);
    },
  );

  await boss.work<InboundEmailJob>(QUEUES.inboundEmail, async ([job]) => {
    if (job) await handleInboundEmail(deps, job.data, log);
  });

  await boss.work<MemberNotice>(
    QUEUES.memberNotice,
    { localConcurrency: EMAIL_CONCURRENCY },
    async ([job]) => {
      if (job) await sendMemberNotice(deps, job.data);
    },
  );

  await boss.work(QUEUES.slaCheck, async () => {
    const done = await runSlaChecks(deps);
    if (done > 0) log.info({ done }, 'SLA warnings and escalations done');
  });
  await boss.schedule(QUEUES.slaCheck, SLA_CHECK_CRON, null, { tz: CLEAN_UPLOADS_TZ });

  await boss.work(QUEUES.timeRules, async () => {
    const applied = await runTimeRules(deps);
    if (applied > 0) log.info({ applied }, 'scheduled rules applied');
  });
  await boss.schedule(QUEUES.timeRules, TIME_RULES_CRON, null, { tz: CLEAN_UPLOADS_TZ });

  await boss.work(QUEUES.cleanUploads, async () => {
    const removed = await cleanAbandonedUploads(deps);
    log.info({ removed }, 'abandoned uploads cleaned up');
    const notifications = await cleanOldNotifications(deps);
    log.info({ removed: notifications }, 'old notifications removed');
  });
  await boss.schedule(QUEUES.cleanUploads, CLEAN_UPLOADS_CRON, null, { tz: CLEAN_UPLOADS_TZ });
}
