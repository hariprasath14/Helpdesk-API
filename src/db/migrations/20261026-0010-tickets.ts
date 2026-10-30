import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F9, tickets.
//
// - ticket_counters: the last ticket number of each workspace. Numbers come from
//   INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so two tickets created at once never share one.
// - tickets: number (unique per workspace, used in addresses: /tickets/42), subject, description
//   (the first message, plain text), the requester contact and their company at the time, status,
//   priority, type, team, assignee (F12), source, custom field values and soft delete
//   (deleted_at: the trash). resolved_at and closed_at are set when the status gets there and
//   cleared on reopening. Times for SLAs come with F23.
// - ticket_tags: one row per tag, so "tickets tagged refund" is an equality lookup that works
//   under row-level security (GIN indexes on arrays don't, see ENGINEERING_STANDARDS.md 1).
// - ticket_activities: the ticket's history (created, each property change, deleted, restored),
//   shown on the ticket and later merged into the conversation timeline (F11).
// - The assignee and the creator reference memberships (workspace_id, user_id): only members of
//   the same workspace. Deactivated members stay on their tickets.
// - Deleting a contact with tickets is refused by the app; the foreign key also blocks it.
// - Audit entries for ticket deletes get their own category, "tickets".
// All five are tenant tables with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE ticket_counters (
        workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
        last_number integer NOT NULL CHECK (last_number > 0)
      )`);
    await enableTenantIsolation(context, 'ticket_counters', transaction);

    await run(`
      CREATE TABLE tickets (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        number integer NOT NULL CHECK (number > 0),
        subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
        description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 50000),
        contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
        company_id uuid REFERENCES companies (id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'pending', 'waiting_on_customer', 'resolved', 'closed')),
        priority text NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        type text CHECK (type IN ('question', 'incident', 'problem', 'feature_request')),
        team_id uuid REFERENCES teams (id) ON DELETE SET NULL,
        assignee_user_id uuid,
        source text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'email', 'web_form')),
        custom_fields jsonb NOT NULL DEFAULT '{}',
        created_by_user_id uuid,
        resolved_at timestamptz,
        closed_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, number),
        FOREIGN KEY (workspace_id, assignee_user_id) REFERENCES memberships (workspace_id, user_id),
        FOREIGN KEY (workspace_id, created_by_user_id) REFERENCES memberships (workspace_id, user_id)
      )`);
    // The lists F10 filters and sorts by, each starting with workspace_id.
    await run(
      'CREATE INDEX tickets_workspace_updated_idx ON tickets (workspace_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL',
    );
    await run(
      'CREATE INDEX tickets_workspace_status_idx ON tickets (workspace_id, status, updated_at DESC) WHERE deleted_at IS NULL',
    );
    await run(
      'CREATE INDEX tickets_workspace_assignee_idx ON tickets (workspace_id, assignee_user_id, status)',
    );
    await run(
      'CREATE INDEX tickets_workspace_team_idx ON tickets (workspace_id, team_id, status) WHERE deleted_at IS NULL',
    );
    await run(
      'CREATE INDEX tickets_workspace_contact_idx ON tickets (workspace_id, contact_id, created_at DESC)',
    );
    await run(
      'CREATE INDEX tickets_workspace_company_idx ON tickets (workspace_id, company_id, created_at DESC)',
    );
    await run(
      'CREATE INDEX tickets_workspace_deleted_idx ON tickets (workspace_id, deleted_at DESC) WHERE deleted_at IS NOT NULL',
    );
    // Foreign keys.
    await run('CREATE INDEX tickets_contact_idx ON tickets (contact_id)');
    await run('CREATE INDEX tickets_company_idx ON tickets (company_id)');
    await run('CREATE INDEX tickets_team_idx ON tickets (team_id)');
    await run(
      'CREATE INDEX tickets_workspace_creator_idx ON tickets (workspace_id, created_by_user_id)',
    );
    await enableTenantIsolation(context, 'tickets', transaction);

    await run(`
      CREATE TABLE ticket_tags (
        ticket_id uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        tag text NOT NULL CHECK (tag = lower(tag) AND char_length(tag) BETWEEN 1 AND 40),
        PRIMARY KEY (ticket_id, tag)
      )`);
    await run('CREATE INDEX ticket_tags_workspace_tag_idx ON ticket_tags (workspace_id, tag)');
    await enableTenantIsolation(context, 'ticket_tags', transaction);

    await run(`
      CREATE TABLE ticket_activities (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        ticket_id uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
        actor_name text NOT NULL,
        action text NOT NULL,
        changes jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX ticket_activities_ticket_idx ON ticket_activities (workspace_id, ticket_id, created_at, id)',
    );
    await run('CREATE INDEX ticket_activities_actor_idx ON ticket_activities (actor_user_id)');
    await enableTenantIsolation(context, 'ticket_activities', transaction);

    await run('ALTER TABLE audit_events DROP CONSTRAINT audit_events_category_check');
    await run(`
      ALTER TABLE audit_events ADD CONSTRAINT audit_events_category_check
        CHECK (category IN ('members', 'security', 'settings', 'sign_in', 'contacts', 'tickets'))`);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run("DELETE FROM audit_events WHERE category = 'tickets'");
    await run('ALTER TABLE audit_events DROP CONSTRAINT audit_events_category_check');
    await run(`
      ALTER TABLE audit_events ADD CONSTRAINT audit_events_category_check
        CHECK (category IN ('members', 'security', 'settings', 'sign_in', 'contacts'))`);
    for (const table of ['ticket_activities', 'ticket_tags', 'tickets', 'ticket_counters']) {
      await disableTenantIsolation(context, table, transaction);
      await run(`DROP TABLE IF EXISTS ${table}`);
    }
  });
}
