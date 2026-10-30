import type { PgBoss } from 'pg-boss';
import pino from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../adapters/storage/index.js';
import { captureEmails, testConfig, testDatabase } from '../test/helpers.js';
import { registerJobs } from './handlers.js';
import { QUEUES } from './queue.js';

type Handler = (jobs: unknown[]) => Promise<void>;

/**
 * A stand-in for pg-boss that keeps the handlers instead of polling, so the test runs them
 * itself: a real worker here would also pick up jobs other test files are checking.
 */
function fakeBoss() {
  const handlers = new Map<string, { options: object; handler: Handler }>();
  const schedules: unknown[][] = [];
  const boss = {
    work(name: string, optionsOrHandler: object, handler?: Handler) {
      if (handler) handlers.set(name, { options: optionsOrHandler, handler });
      else handlers.set(name, { options: {}, handler: optionsOrHandler as Handler });
      return Promise.resolve(name);
    },
    schedule(...args: unknown[]) {
      schedules.push(args);
      return Promise.resolve();
    },
  };
  return { boss: boss as unknown as PgBoss, handlers, schedules };
}

const db = testDatabase();
afterAll(() => db.close());

describe('the worker jobs', () => {
  it('handles every queue and schedules the daily clean-up', async () => {
    const config = testConfig();
    const { boss, handlers, schedules } = fakeBoss();
    const emails = captureEmails();
    await registerJobs(
      boss,
      {
        config,
        db,
        email: emails.sender,
        storage: createFileStorage(config),
        jobs: { enqueue: () => Promise.resolve() },
      },
      pino({ level: 'silent' }),
    );

    expect([...handlers.keys()].sort()).toEqual(Object.values(QUEUES).sort());
    await handlers.get(QUEUES.customerEmail)?.handler([]);
    expect(handlers.get(QUEUES.ticketEmail)?.options).toMatchObject({ includeMetadata: true });
    expect(schedules).toEqual([
      [QUEUES.slaCheck, '* * * * *', null, { tz: 'Asia/Kolkata' }],
      [QUEUES.timeRules, '*/15 * * * *', null, { tz: 'Asia/Kolkata' }],
      [QUEUES.cleanUploads, '30 3 * * *', null, { tz: 'Asia/Kolkata' }],
    ]);
    await handlers.get(QUEUES.timeRules)?.handler([{ id: 'job' }]);
    await handlers.get(QUEUES.slaCheck)?.handler([{ id: 'job' }]);
    await handlers.get(QUEUES.memberNotice)?.handler([]);

    // An empty batch does nothing; a job for a message that no longer exists sends nothing.
    await handlers.get(QUEUES.ticketEmail)?.handler([]);
    await handlers.get(QUEUES.assignmentEmail)?.handler([]);
    const missing = '00000000-0000-4000-8000-000000000000';
    await handlers
      .get(QUEUES.ticketEmail)
      ?.handler([
        { data: { workspaceId: missing, messageId: missing }, retryCount: 0, retryLimit: 4 },
      ]);
    await handlers.get(QUEUES.assignmentEmail)?.handler([
      {
        data: { workspaceId: missing, ticketId: missing, assigneeUserId: missing, assignedBy: 'X' },
      },
    ]);
    await handlers.get(QUEUES.cleanUploads)?.handler([{ id: 'job' }]);
    expect(emails.sent).toEqual([]);
  });
});
