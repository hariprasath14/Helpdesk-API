import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F17, the rules engine: "when this happens, if these conditions match, do these things".
//
// - automation_rules: a workspace's rules in their order (position). event is what starts a rule:
//   a ticket created (F17), changed or answered by the customer (F19), or time passing (F20).
//   conditions and actions are JSON checked by the app (rules/conditions.ts, rules/actions.ts).
//   stop_after: when this rule matches, later rules for the same event do not run.
// - ticket_messages.author_name: who wrote a message that no member or contact wrote, such as a
//   private note added by a rule ("Rule: Billing to Accounts").
// automation_rules is a tenant table with row-level security; rule changes are audited.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      CREATE TABLE automation_rules (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        event text NOT NULL CHECK (event IN ('ticket_created', 'ticket_updated', 'customer_replied', 'time')),
        enabled boolean NOT NULL DEFAULT true,
        position integer NOT NULL,
        conditions jsonb NOT NULL,
        actions jsonb NOT NULL,
        stop_after boolean NOT NULL DEFAULT false,
        created_by_user_id uuid,
        updated_by_user_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    // The rules that run for an event, in order.
    await run(
      'CREATE INDEX automation_rules_event_idx ON automation_rules (workspace_id, event, position)',
    );
    await enableTenantIsolation(context, 'automation_rules', transaction);
    await run(`
      ALTER TABLE ticket_messages
        ADD COLUMN author_name text CHECK (char_length(author_name) <= 120)`);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await q.query(
      "DELETE FROM audit_events WHERE action LIKE 'rule.%' OR action = 'rules.reordered'",
      {
        transaction,
      },
    );
    await q.query('ALTER TABLE ticket_messages DROP COLUMN IF EXISTS author_name', { transaction });
    await disableTenantIsolation(context, 'automation_rules', transaction);
    await q.query('DROP TABLE IF EXISTS automation_rules', { transaction });
  });
}
