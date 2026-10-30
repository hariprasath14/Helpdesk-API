import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../test/helpers.js';
import { createJobQueue, QUEUES, sequelizeAdapter, type JobQueue } from './queue.js';

const db = testDatabase();
let queue: JobQueue;
let boss: PgBoss;

beforeAll(async () => {
  queue = createJobQueue(db.writer);
  // As the worker runs it: the app role, no schema changes.
  boss = new PgBoss({
    db: sequelizeAdapter(db.writer),
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  await boss.start();
});
afterAll(async () => {
  await queue.stop();
  await boss.stop({ graceful: false });
  await db.close();
});

describe('the job queue', () => {
  it('keeps a job only when its transaction is saved, using the app role', async () => {
    const marker = `marker-${String(Date.now())}`;
    await db.writer.transaction(async (transaction) => {
      await queue.enqueue(QUEUES.cleanUploads, { marker, kept: true }, transaction);
    });
    await db.writer
      .transaction(async (transaction) => {
        await queue.enqueue(QUEUES.cleanUploads, { marker, kept: false }, transaction);
        throw new Error('roll back');
      })
      .catch(() => undefined);

    const jobs = await boss.fetch<{ marker: string; kept: boolean }>(QUEUES.cleanUploads, {
      batchSize: 50,
    });
    const mine = jobs.filter((job) => job.data.marker === marker);
    expect(mine.map((job) => job.data.kept)).toEqual([true]);
    for (const job of jobs) await boss.complete(QUEUES.cleanUploads, job.id);
  });

  it('can schedule and unschedule as the app role', async () => {
    await boss.schedule(QUEUES.cleanUploads, '0 3 * * *');
    expect((await boss.getSchedules(QUEUES.cleanUploads)).length).toBe(1);
    await boss.unschedule(QUEUES.cleanUploads);
  });
});
