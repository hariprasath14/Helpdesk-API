import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Sequelize, Transaction } from 'sequelize';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '../db/tenant.js';
import { NotFoundError } from '../lib/errors.js';
import { createProbeTable, type ProbeTable } from './fixtures.js';
import { LAGGING_READER, testApp } from './helpers.js';
import { expectReadAfterWrite } from './read-after-write.js';
import { expectTenantIsolation } from './tenant-isolation.js';

// These tests check the test helpers themselves: each helper must pass correct code and fail
// buggy code. The probe routes stand in for real endpoints until features exist. Until sign-in
// exists (F1/F2), a test-only header says which workspace a request acts for.

let isolated: ProbeTable;
let leaky: ProbeTable;
let app: FastifyInstance;

beforeAll(async () => {
  isolated = await createProbeTable();
  leaky = await createProbeTable({ isolated: false });
});

afterAll(async () => {
  await Promise.all([isolated.drop(), leaky.drop()]);
});

afterEach(async () => {
  await app.close();
});

const workspaceOf = (request: FastifyRequest) => String(request.headers['x-test-workspace']);
const actAs = (workspaceId: string) =>
  Promise.resolve({ headers: { 'x-test-workspace': workspaceId } });

async function findNote(db: Sequelize, table: string, id: string, transaction: Transaction) {
  const [rows] = await db.query(`SELECT id, note FROM "${table}" WHERE id = :id`, {
    replacements: { id },
    transaction,
  });
  const row = (rows as { id: number; note: string }[])[0];
  if (!row) throw new NotFoundError('Note not found.');
  return row;
}

/** Correct and deliberately buggy versions of typical endpoints. */
async function probeApp(overrides: Record<string, string> = {}) {
  app = await testApp(overrides, { ready: false });
  const { writer, reader } = app.db;

  for (const [prefix, table] of [
    ['notes', isolated.name],
    ['leaky', leaky.name],
  ] as const) {
    app.get<{ Params: { id: string } }>(`/probe/${prefix}/:id`, (request) =>
      withWorkspace(reader, workspaceOf(request), (t) =>
        findNote(reader, table, request.params.id, t),
      ),
    );
    app.get(`/probe/${prefix}`, (request) =>
      withWorkspace(reader, workspaceOf(request), async (transaction) => {
        const [rows] = await reader.query(`SELECT id, note FROM "${table}" ORDER BY id`, {
          transaction,
        });
        return { items: rows };
      }),
    );
  }

  const insert = (request: FastifyRequest<{ Body: { note: string } }>, transaction: Transaction) =>
    writer
      .query(
        `INSERT INTO "${isolated.name}" (workspace_id, note) VALUES (:ws, :note) RETURNING id`,
        { replacements: { ws: workspaceOf(request), note: request.body.note }, transaction },
      )
      .then(([rows]) => String((rows as { id: number }[])[0]?.id));

  // Correct: write and read the result back in the same writer transaction.
  app.post<{ Body: { note: string } }>('/probe/notes', (request) =>
    withWorkspace(writer, workspaceOf(request), async (transaction) =>
      findNote(writer, isolated.name, await insert(request, transaction), transaction),
    ),
  );
  // The bug: commit the write, then read the new row back through the reader. It works on a
  // single local database and breaks on AWS whenever the reader is a moment behind.
  app.post<{ Body: { note: string } }>('/probe/notes-read-from-reader', async (request) => {
    const id = await withWorkspace(writer, workspaceOf(request), (t) => insert(request, t));
    return withWorkspace(reader, workspaceOf(request), (t) =>
      findNote(reader, isolated.name, id, t),
    );
  });

  await app.ready();
}

describe('expectTenantIsolation', () => {
  it('passes for endpoints on a table with row-level security', async () => {
    await probeApp();
    await expectTenantIsolation({
      app,
      workspaces: { owner: randomUUID(), intruder: randomUUID() },
      actAs,
      async setup(owner) {
        const id = await isolated.insert(owner, 'Payroll export is wrong');
        return {
          checks: [
            { request: { method: 'GET', url: `/probe/notes/${id}` }, kind: 'item' },
            { request: { method: 'GET', url: '/probe/notes' }, kind: 'list' },
          ],
          secrets: ['Payroll export is wrong'],
        };
      },
    });
  });

  it('fails when a table is missing row-level security', async () => {
    await probeApp();
    const run = expectTenantIsolation({
      app,
      workspaces: { owner: randomUUID(), intruder: randomUUID() },
      actAs,
      async setup(owner) {
        const id = await leaky.insert(owner, 'Salary details for Acme');
        return {
          checks: [
            { request: { method: 'GET', url: `/probe/leaky/${id}` }, kind: 'item' },
            { request: { method: 'GET', url: '/probe/leaky' }, kind: 'list' },
          ],
          secrets: ['Salary details for Acme'],
        };
      },
    });
    await expect(run).rejects.toThrow(/another workspace got 200, expected 404/);
    await expect(run).rejects.toThrow(/contains "Salary details for Acme"/);
  });

  it('fails when the owner cannot reach the resource, instead of passing by accident', async () => {
    await probeApp();
    const run = expectTenantIsolation({
      app,
      workspaces: { owner: randomUUID(), intruder: randomUUID() },
      actAs,
      setup: () =>
        Promise.resolve({
          checks: [{ request: { method: 'GET', url: '/probe/notes/999999' }, kind: 'item' }],
          secrets: [],
        }),
    });
    await expect(run).rejects.toThrow(/the owner got 404, so the check proves nothing/);
  });
});

describe('expectReadAfterWrite', () => {
  const create = (url: string) => ({
    method: 'POST' as const,
    url,
    headers: { 'x-test-workspace': randomUUID() },
    payload: { note: `Created ${randomUUID()}` },
  });

  it('passes when an endpoint returns its result from the writer', async () => {
    await probeApp(LAGGING_READER);
    const request = create('/probe/notes');
    const response = await expectReadAfterWrite(app, request, [request.payload.note]);
    expect(response.statusCode).toBe(200);
  });

  it('fails when an endpoint reads its own write from the lagging reader', async () => {
    await probeApp(LAGGING_READER);
    const request = create('/probe/notes-read-from-reader');
    await expect(expectReadAfterWrite(app, request, [request.payload.note])).rejects.toThrow(
      /returned 404 with a lagging reader/,
    );
  });

  it('would miss that bug without the lagging reader, which is why it is required', async () => {
    await probeApp();
    const request = create('/probe/notes-read-from-reader');
    const response = await expectReadAfterWrite(app, request, [request.payload.note]);
    expect(response.statusCode).toBe(200);
  });

  it('fails when the response lacks the written data', async () => {
    await probeApp(LAGGING_READER);
    const request = create('/probe/notes');
    await expect(expectReadAfterWrite(app, request, ['text that is not there'])).rejects.toThrow(
      /did not return "text that is not there"/,
    );
  });
});
