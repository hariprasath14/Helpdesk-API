import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F25, the notification center: what members are told about tickets, in the app and by email.
//
// - notifications: one per member per event (assigned to you, an @mention, an SLA warning or
//   breach, a customer reply on your ticket), unread until opened. A member's notifications go
//   when they leave the workspace; a ticket's when it is removed for good. Kept 90 days
//   (delete_old_notifications(), from the worker's daily clean-up). A tenant table with row-level
//   security; members only ever read their own.
// - memberships.notification_email: which kinds also come by email, per workspace; in the app they
//   always show. Customer replies are off to start with, the rest on.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id uuid NOT NULL,
        kind text NOT NULL
          CHECK (kind IN ('assigned', 'mention', 'sla_warning', 'sla_breach', 'customer_reply')),
        ticket_id uuid REFERENCES tickets (id) ON DELETE CASCADE,
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
        body text NOT NULL CHECK (char_length(body) <= 1000),
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id)
          ON DELETE CASCADE
      )`);
    // A member's list, newest first, and their unread count.
    await run(
      'CREATE INDEX notifications_member_idx ON notifications (workspace_id, user_id, created_at DESC, id DESC)',
    );
    await run(
      'CREATE INDEX notifications_unread_idx ON notifications (workspace_id, user_id) WHERE read_at IS NULL',
    );
    await run('CREATE INDEX notifications_ticket_idx ON notifications (ticket_id)');
    await run('CREATE INDEX notifications_created_idx ON notifications (created_at)');
    await enableTenantIsolation(context, 'notifications', transaction);

    await run(`
      ALTER TABLE memberships ADD COLUMN notification_email jsonb NOT NULL DEFAULT
        '{"assigned": true, "mention": true, "sla_warning": true, "sla_breach": true, "customer_reply": false}'`);

    await run(`
      CREATE FUNCTION delete_old_notifications(before timestamptz)
        RETURNS integer
        LANGUAGE sql VOLATILE SECURITY DEFINER
        SET search_path = public, pg_temp
      AS $$
        WITH gone AS (DELETE FROM notifications WHERE created_at < before RETURNING 1)
        SELECT count(*)::integer FROM gone
      $$`);
    await run('REVOKE ALL ON FUNCTION delete_old_notifications(timestamptz) FROM PUBLIC');
    await run('GRANT EXECUTE ON FUNCTION delete_old_notifications(timestamptz) TO helpdesk_app');
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP FUNCTION IF EXISTS delete_old_notifications(timestamptz)');
    await run('ALTER TABLE memberships DROP COLUMN IF EXISTS notification_email');
    await disableTenantIsolation(context, 'notifications', transaction);
    await run('DROP TABLE IF EXISTS notifications');
  });
}
