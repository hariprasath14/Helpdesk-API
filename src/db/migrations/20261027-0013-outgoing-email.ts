import { getUninstallPlans, PgBoss, type Db, type Queue } from 'pg-boss';
import type { QueryInterface, Sequelize } from 'sequelize';

// F13, outgoing email, and the first background jobs.
//
// - pg-boss (the job queue, ARCHITECTURE.md) gets its own schema, "pgboss", created here by the
//   schema owner: the app role has no DDL rights, so the app and worker run pg-boss with schema
//   creation and migration turned off and only read and write its tables. The queues are created
//   here too (they are rows in pgboss.queue, not partitions).
// - workspaces.email_sender_name: the name customers see on ticket email ("Acme Support"); empty
//   means the workspace name.
// - ticket_messages gets the outgoing email's Message-ID (threading, and matching replies in F14),
//   when it was sent, how many tries it took and the last error.
// - abandoned_upload_workspaces(): which workspaces have uploads never sent, for the worker's daily
//   clean-up. Row-level security limits the app role to one workspace at a time, so this one
//   function (owned by the schema owner, SECURITY DEFINER) answers only workspace ids, never file
//   details; the clean-up then works inside each of those workspaces as usual.

// Written out here, not imported, so this migration keeps doing the same thing when the app's
// queue settings change later (a change to a queue is a new migration).
const EMAIL_RETRY = {
  retryLimit: 4,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
  expireInSeconds: 300,
};
const QUEUES: Queue[] = [
  { name: 'ticket-email', ...EMAIL_RETRY },
  { name: 'assignment-email', ...EMAIL_RETRY },
  { name: 'clean-uploads', retryLimit: 2, expireInSeconds: 900 },
];

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
  });
  await boss.start();
  try {
    await work(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await withBoss(q, async (boss) => {
    for (const { name, ...options } of QUEUES) await boss.createQueue(name, options);
  });
  await q.query(`
    GRANT USAGE ON SCHEMA pgboss TO helpdesk_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO helpdesk_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO helpdesk_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO helpdesk_app;
  `);

  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      ALTER TABLE workspaces
        ADD COLUMN email_sender_name text CHECK (char_length(email_sender_name) BETWEEN 1 AND 80)`);
    await run(`
      ALTER TABLE ticket_messages
        ADD COLUMN email_message_id text CHECK (char_length(email_message_id) <= 255),
        ADD COLUMN email_sent_at timestamptz,
        ADD COLUMN email_attempts integer NOT NULL DEFAULT 0,
        ADD COLUMN email_error text CHECK (char_length(email_error) <= 500)`);
    // Replies are matched to their ticket by the Message-ID they answer (F14).
    await run(
      'CREATE UNIQUE INDEX ticket_messages_workspace_message_id_key ON ticket_messages (workspace_id, email_message_id)',
    );
    // Uses ticket_attachments_pending_idx (the partial index on unsent uploads).
    await run(`
      CREATE FUNCTION abandoned_upload_workspaces(older_than timestamptz, max_rows integer)
        RETURNS SETOF uuid
        LANGUAGE sql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
      AS $$
        SELECT DISTINCT workspace_id FROM ticket_attachments
        WHERE message_id IS NULL AND created_at < older_than
        LIMIT max_rows
      $$`);
    await run(
      'REVOKE ALL ON FUNCTION abandoned_upload_workspaces(timestamptz, integer) FROM PUBLIC',
    );
    await run(
      'GRANT EXECUTE ON FUNCTION abandoned_upload_workspaces(timestamptz, integer) TO helpdesk_app',
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP FUNCTION IF EXISTS abandoned_upload_workspaces(timestamptz, integer)');
    await run('DROP INDEX IF EXISTS ticket_messages_workspace_message_id_key');
    await run(`
      ALTER TABLE ticket_messages
        DROP COLUMN IF EXISTS email_error,
        DROP COLUMN IF EXISTS email_attempts,
        DROP COLUMN IF EXISTS email_sent_at,
        DROP COLUMN IF EXISTS email_message_id`);
    await run('ALTER TABLE workspaces DROP COLUMN IF EXISTS email_sender_name');
  });
  await q.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE USAGE, SELECT ON SEQUENCES FROM helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM helpdesk_app;
  `);
  await q.query(getUninstallPlans('pgboss'));
}
