import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '../lib/errors.js';
import { testDatabase, testMigratorConnection } from '../test/helpers.js';
import type { Database } from './index.js';
import { createMigrator, createSeeder } from './migrator.js';
import { disableTenantIsolation, enableTenantIsolation } from './rls.js';
import { withWorkspace } from './tenant.js';

let db: Database;
let migrator: Sequelize;
// A throwaway tenant table per run, so parallel runs and leftovers never collide.
const table = `rls_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const workspaceA = randomUUID();
const workspaceB = randomUUID();

beforeAll(async () => {
  db = testDatabase();
  migrator = testMigratorConnection();
  await migrator.query(
    `CREATE TABLE "${table}" (id serial PRIMARY KEY, workspace_id uuid NOT NULL, note text NOT NULL)`,
  );
  await enableTenantIsolation(migrator.getQueryInterface(), table);
  // The migrator owns the table, so it can seed rows for both workspaces.
  await migrator.query(
    `INSERT INTO "${table}" (workspace_id, note) VALUES (:a, 'a1'), (:a, 'a2'), (:b, 'b1')`,
    { replacements: { a: workspaceA, b: workspaceB } },
  );
});

afterAll(async () => {
  await migrator.query(`DROP TABLE IF EXISTS "${table}"`);
  await Promise.all([db.close(), migrator.close()]);
});

async function notes(sequelize: Sequelize, workspaceId: string) {
  return withWorkspace(sequelize, workspaceId, async (transaction) => {
    const [rows] = await sequelize.query(`SELECT note FROM "${table}" ORDER BY note`, {
      transaction,
    });
    return (rows as { note: string }[]).map((row) => row.note);
  });
}

describe('database roles', () => {
  it('lets the app role read and write tables the migrator creates', async () => {
    const result = await withWorkspace(db.writer, workspaceA, async (transaction) => {
      await db.writer.query(`INSERT INTO "${table}" (workspace_id, note) VALUES (:a, 'a3')`, {
        replacements: { a: workspaceA },
        transaction,
      });
      await db.writer.query(`DELETE FROM "${table}" WHERE note = 'a3'`, { transaction });
      return true;
    });
    expect(result).toBe(true);
  });

  it('does not let the app role change the schema', async () => {
    await expect(db.writer.query('CREATE TABLE app_should_not_create (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('does not let the reader write, even inside a workspace', async () => {
    await expect(
      withWorkspace(db.reader, workspaceA, (transaction) =>
        db.reader.query(`INSERT INTO "${table}" (workspace_id, note) VALUES (:a, 'x')`, {
          replacements: { a: workspaceA },
          transaction,
        }),
      ),
    ).rejects.toThrow(/read-only transaction|permission denied/);
  });

  it('gives no role the right to bypass row-level security', async () => {
    const [rows] = await migrator.query(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname LIKE 'helpdesk_%' ORDER BY rolname`,
    );
    expect(rows).toEqual([
      { rolname: 'helpdesk_app', rolbypassrls: false, rolsuper: false },
      { rolname: 'helpdesk_migrator', rolbypassrls: false, rolsuper: false },
      { rolname: 'helpdesk_readonly', rolbypassrls: false, rolsuper: false },
    ]);
  });
});

describe('tenant isolation (row-level security)', () => {
  it('shows each workspace only its own rows, on the writer and the reader', async () => {
    expect(await notes(db.writer, workspaceA)).toEqual(['a1', 'a2']);
    expect(await notes(db.writer, workspaceB)).toEqual(['b1']);
    expect(await notes(db.reader, workspaceA)).toEqual(['a1', 'a2']);
  });

  it('shows nothing when no workspace is set, even without a WHERE clause', async () => {
    const [rows] = await db.writer.query(`SELECT note FROM "${table}"`);
    expect(rows).toEqual([]);
  });

  it('does not carry the workspace over to the next query on the same connection', async () => {
    // A pool of one forces the same connection; the setting must have ended with the transaction.
    const single = testDatabase({ DATABASE_POOL_MAX: '1' });
    try {
      expect(await notes(single.writer, workspaceA)).toEqual(['a1', 'a2']);
      const [rows] = await single.writer.query(`SELECT note FROM "${table}"`);
      expect(rows).toEqual([]);
    } finally {
      await single.close();
    }
  });

  it('refuses to write a row into another workspace', async () => {
    await expect(
      withWorkspace(db.writer, workspaceA, (transaction) =>
        db.writer.query(`INSERT INTO "${table}" (workspace_id, note) VALUES (:b, 'sneaky')`, {
          replacements: { b: workspaceB },
          transaction,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another workspace's rows", async () => {
    await withWorkspace(db.writer, workspaceA, async (transaction) => {
      await db.writer.query(`UPDATE "${table}" SET note = 'hacked' WHERE note = 'b1'`, {
        transaction,
      });
      await db.writer.query(`DELETE FROM "${table}" WHERE note = 'b1'`, { transaction });
    });
    expect(await notes(db.writer, workspaceB)).toEqual(['b1']);
  });

  it('rolls the whole transaction back on error', async () => {
    await expect(
      withWorkspace(db.writer, workspaceA, async (transaction) => {
        await db.writer.query(`INSERT INTO "${table}" (workspace_id, note) VALUES (:a, 'a9')`, {
          replacements: { a: workspaceA },
          transaction,
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await notes(db.writer, workspaceA)).toEqual(['a1', 'a2']);
  });

  it('rejects a workspace ID that is not a UUID', async () => {
    await expect(notes(db.writer, "x' OR '1'='1")).rejects.toBeInstanceOf(ValidationError);
  });

  it('can be switched off again by a migration rollback', async () => {
    const probe = `${table}_off`;
    await migrator.query(`CREATE TABLE "${probe}" (workspace_id uuid NOT NULL)`);
    try {
      const qi = migrator.getQueryInterface();
      await enableTenantIsolation(qi, probe);
      await disableTenantIsolation(qi, probe);
      const [rows] = await migrator.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = :probe`,
        { replacements: { probe } },
      );
      expect(rows).toEqual([{ relrowsecurity: false }]);
    } finally {
      await migrator.query(`DROP TABLE "${probe}"`);
    }
  });

  it('rejects unsafe table names', async () => {
    await expect(
      enableTenantIsolation(migrator.getQueryInterface(), 'tickets"; DROP TABLE x; --'),
    ).rejects.toThrow(/Invalid table name/);
  });
});

describe('migrations', () => {
  it('are all applied, and stored without a file extension', async () => {
    const umzug = createMigrator(migrator);
    const executed = (await umzug.executed()).map((m) => m.name);
    expect(await umzug.pending()).toEqual([]);
    expect(executed).toContain('20261025-0001-roles-and-grants');
    expect(executed.every((name) => !/\.(ts|js)$/.test(name))).toBe(true);
  });

  it('find no seed files yet, and ignore the seeders README', async () => {
    expect(await createSeeder(migrator).pending()).toEqual([]);
  });
});
