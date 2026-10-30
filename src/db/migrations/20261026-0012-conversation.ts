import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F11, ticket conversation.
//
// - ticket_messages: replies to the requester, private notes and forwards, plain text. Replies and
//   forwards carry their recipients and an email status: queued until the outgoing email feature
//   (F13) sends them. Notes carry the members they @mention (notifications: F25). Customer
//   messages (kind "customer") arrive with email-to-ticket (F14) and keep sanitized HTML in
//   body_html.
// - ticket_attachments: files uploaded first (message_id empty), then attached to a message when
//   it is sent. The file itself is in file storage under "<workspace id>/<attachment id>".
// - tickets.first_response_at: when the first reply went out (SLAs, F23).
// Both new tables are tenant tables with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run('ALTER TABLE tickets ADD COLUMN first_response_at timestamptz');

    await run(`
      CREATE TABLE ticket_messages (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        ticket_id uuid NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('reply', 'note', 'forward', 'customer')),
        body_text text NOT NULL DEFAULT '' CHECK (char_length(body_text) <= 50000),
        body_html text,
        author_user_id uuid,
        author_contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
        to_emails text[] NOT NULL DEFAULT '{}',
        cc_emails text[] NOT NULL DEFAULT '{}',
        mentioned_user_ids uuid[] NOT NULL DEFAULT '{}',
        email_status text CHECK (email_status IN ('queued', 'sent', 'failed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (workspace_id, author_user_id) REFERENCES memberships (workspace_id, user_id)
      )`);
    await run(
      'CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (workspace_id, ticket_id, created_at, id)',
    );
    // F13 picks up queued emails.
    await run(
      "CREATE INDEX ticket_messages_queued_idx ON ticket_messages (workspace_id, created_at) WHERE email_status = 'queued'",
    );
    await run(
      'CREATE INDEX ticket_messages_author_idx ON ticket_messages (workspace_id, author_user_id)',
    );
    await run('CREATE INDEX ticket_messages_contact_idx ON ticket_messages (author_contact_id)');
    await run('CREATE INDEX ticket_messages_ticket_fk_idx ON ticket_messages (ticket_id)');
    await enableTenantIsolation(context, 'ticket_messages', transaction);

    await run(`
      CREATE TABLE ticket_attachments (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        ticket_id uuid REFERENCES tickets (id) ON DELETE CASCADE,
        message_id uuid REFERENCES ticket_messages (id) ON DELETE CASCADE,
        uploaded_by_user_id uuid NOT NULL,
        file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
        content_type text NOT NULL CHECK (char_length(content_type) <= 255),
        size_bytes integer NOT NULL CHECK (size_bytes >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((ticket_id IS NULL) = (message_id IS NULL)),
        FOREIGN KEY (workspace_id, uploaded_by_user_id) REFERENCES memberships (workspace_id, user_id)
      )`);
    await run(
      'CREATE INDEX ticket_attachments_message_idx ON ticket_attachments (workspace_id, message_id)',
    );
    // Uploads not yet sent, per person (cleanup of abandoned ones).
    await run(
      'CREATE INDEX ticket_attachments_pending_idx ON ticket_attachments (workspace_id, uploaded_by_user_id, created_at) WHERE message_id IS NULL',
    );
    await run('CREATE INDEX ticket_attachments_ticket_idx ON ticket_attachments (ticket_id)');
    await run('CREATE INDEX ticket_attachments_message_fk_idx ON ticket_attachments (message_id)');
    await enableTenantIsolation(context, 'ticket_attachments', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    for (const table of ['ticket_attachments', 'ticket_messages']) {
      await disableTenantIsolation(context, table, transaction);
      await q.query(`DROP TABLE IF EXISTS ${table}`, { transaction });
    }
    await q.query('ALTER TABLE tickets DROP COLUMN IF EXISTS first_response_at', { transaction });
  });
}
