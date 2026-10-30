import { PgBoss, type Db } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';

// F14, email-to-ticket, and searching inside descriptions and messages.
//
// - tickets.email_message_id: the Message-ID of the email that raised the ticket, unique per
//   workspace, so the same email never makes two tickets and replies to it thread onto the ticket.
// - ticket_attachments: files that came with the email that raised a ticket belong to the ticket
//   (ticket set, no message), and files from email have no uploading member. An upload not sent
//   yet is now "no ticket" (it was "no message"); the pending-upload index and the clean-up
//   function follow.
// - Full-text search (owner decision 2026-10-27): GIN indexes on the subject and description and
//   on message text, used only through search_ticket_ids(). Under row-level security Postgres
//   does not use these indexes for the app role (the @@ operator is not leakproof), so the
//   function runs as the schema owner and limits itself to the workspace in app.workspace_id,
//   exactly as the policy does. 'simple' text search: no stemming, so names, codes and Indian
//   languages match as typed. The function splits the search into words with the same parser as
//   the indexes (so "ZX-981" or "INV/2026/42" match as stored) and matches each as a word start.
// - The "inbound-email" queue: one job per received email.

function adapter(sequelize: Sequelize): Db {
  return {
    async executeSql(text: string, values?: unknown[]) {
      const [rows] = await sequelize.query(
        text,
        values && values.length > 0 ? { bind: values.map((value) => value ?? null) } : {},
      );
      return { rows: Array.isArray(rows) ? rows : [] };
    },
  };
}

async function withBoss(sequelize: Sequelize, work: (boss: PgBoss) => Promise<void>) {
  const boss = new PgBoss({
    db: adapter(sequelize),
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  await boss.start();
  try {
    await work(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

// The function below must use the same expressions, or the indexes are not used.
const TICKET_TEXT = "to_tsvector('simple', subject || ' ' || description)";
const MESSAGE_TEXT = "to_tsvector('simple', body_text)";

const cleanUpFunction = (unsent: string) => `
  CREATE OR REPLACE FUNCTION abandoned_upload_workspaces(older_than timestamptz, max_rows integer)
    RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT workspace_id FROM ticket_attachments
    WHERE ${unsent} AND created_at < older_than
    LIMIT max_rows
  $$`;

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      ALTER TABLE tickets
        ADD COLUMN email_message_id text CHECK (char_length(email_message_id) <= 255)`);
    await run(
      'CREATE UNIQUE INDEX tickets_workspace_email_message_id_key ON tickets (workspace_id, email_message_id)',
    );

    await run('ALTER TABLE ticket_attachments DROP CONSTRAINT ticket_attachments_check');
    await run('ALTER TABLE ticket_attachments ALTER COLUMN uploaded_by_user_id DROP NOT NULL');
    await run(`
      ALTER TABLE ticket_attachments
        ADD CONSTRAINT ticket_attachments_message_on_ticket CHECK (message_id IS NULL OR ticket_id IS NOT NULL),
        ADD CONSTRAINT ticket_attachments_upload_has_uploader CHECK (ticket_id IS NOT NULL OR uploaded_by_user_id IS NOT NULL)`);
    await run('DROP INDEX ticket_attachments_pending_idx');
    await run(
      'CREATE INDEX ticket_attachments_pending_idx ON ticket_attachments (workspace_id, uploaded_by_user_id, created_at) WHERE ticket_id IS NULL',
    );
    await run(cleanUpFunction('ticket_id IS NULL'));

    await run(`CREATE INDEX tickets_search_idx ON tickets USING gin ((${TICKET_TEXT}))`);
    await run(
      `CREATE INDEX ticket_messages_search_idx ON ticket_messages USING gin ((${MESSAGE_TEXT}))`,
    );
    // `query` is what the person typed. Each of its first 8 words must start a word in the ticket.
    // Backslashes are dropped, so every word is a valid quoted lexeme.
    await run(`
      CREATE FUNCTION search_ticket_ids(query text, max_rows integer)
        RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
      AS $$
        WITH search AS (
          SELECT (
                   SELECT string_agg(
                            '''' || replace(replace(word.lexeme, '\\', ''), '''', '''''') || ''':*',
                            ' & ')::tsquery
                   FROM (
                     SELECT lexeme FROM unnest(to_tsvector('simple', left(query, 200)))
                     ORDER BY positions[1] LIMIT 8
                   ) word
                 ) AS terms,
                 NULLIF(current_setting('app.workspace_id', true), '')::uuid AS workspace_id
        )
        SELECT id FROM (
          SELECT t.id FROM tickets t, search s
          WHERE t.workspace_id = s.workspace_id
            AND to_tsvector('simple', t.subject || ' ' || t.description) @@ s.terms
          UNION
          SELECT m.ticket_id FROM ticket_messages m, search s
          WHERE m.workspace_id = s.workspace_id
            AND to_tsvector('simple', m.body_text) @@ s.terms
        ) found
        LIMIT max_rows
      $$`);
    await run('REVOKE ALL ON FUNCTION search_ticket_ids(text, integer) FROM PUBLIC');
    await run('GRANT EXECUTE ON FUNCTION search_ticket_ids(text, integer) TO helpdesk_app');
    await run('GRANT EXECUTE ON FUNCTION search_ticket_ids(text, integer) TO helpdesk_readonly');
  });
  await withBoss(q, async (boss) => {
    await boss.createQueue('inbound-email', {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
    });
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await withBoss(q, async (boss) => {
    await boss.deleteQueue('inbound-email');
  });
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP FUNCTION IF EXISTS search_ticket_ids(text, integer)');
    await run('DROP INDEX IF EXISTS ticket_messages_search_idx');
    await run('DROP INDEX IF EXISTS tickets_search_idx');
    await run(cleanUpFunction('message_id IS NULL'));
    await run('DROP INDEX ticket_attachments_pending_idx');
    await run(
      'CREATE INDEX ticket_attachments_pending_idx ON ticket_attachments (workspace_id, uploaded_by_user_id, created_at) WHERE message_id IS NULL',
    );
    // Files that came with an email (no uploader, or on a ticket without a message) go first.
    await run(
      'DELETE FROM ticket_attachments WHERE uploaded_by_user_id IS NULL OR (ticket_id IS NOT NULL AND message_id IS NULL)',
    );
    await run(`
      ALTER TABLE ticket_attachments
        DROP CONSTRAINT ticket_attachments_upload_has_uploader,
        DROP CONSTRAINT ticket_attachments_message_on_ticket`);
    await run('ALTER TABLE ticket_attachments ALTER COLUMN uploaded_by_user_id SET NOT NULL');
    await run(`
      ALTER TABLE ticket_attachments
        ADD CONSTRAINT ticket_attachments_check CHECK ((ticket_id IS NULL) = (message_id IS NULL))`);
    await run('DROP INDEX IF EXISTS tickets_workspace_email_message_id_key');
    await run('ALTER TABLE tickets DROP COLUMN IF EXISTS email_message_id');
  });
}
