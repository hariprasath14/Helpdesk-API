import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F22, business hours and holidays: when the workspace's team works, for SLA clocks (F23).
//
// - business_hours: one row per workspace. always_open is 24×7; otherwise days holds the seven
//   days Monday first, each {"open": bool, "start": "09:00", "end": "18:00"} in the workspace's
//   time zone (workspaces.timezone). A workspace without a row works Monday to Friday, 09:00 to
//   18:00 (the service's default), so nothing needs adding for existing workspaces.
// - holidays: days off entered by hand, one per date. They apply to working days, not to 24×7.
// Both are tenant tables with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      CREATE TABLE business_hours (
        workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
        always_open boolean NOT NULL DEFAULT false,
        days jsonb NOT NULL CHECK (jsonb_typeof(days) = 'array' AND jsonb_array_length(days) = 7),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await enableTenantIsolation(context, 'business_hours', transaction);

    await run(`
      CREATE TABLE holidays (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        date date NOT NULL,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, date)
      )`);
    await enableTenantIsolation(context, 'holidays', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await disableTenantIsolation(context, 'holidays', transaction);
    await q.query('DROP TABLE IF EXISTS holidays', { transaction });
    await disableTenantIsolation(context, 'business_hours', transaction);
    await q.query('DROP TABLE IF EXISTS business_hours', { transaction });
  });
}
