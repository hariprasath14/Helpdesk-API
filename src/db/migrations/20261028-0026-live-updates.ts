import type { QueryInterface } from 'sequelize';

// F26, live updates: Socket.IO in the API, with the PostgreSQL adapter (no Redis).
//
// - socket_io_attachments: where the adapter keeps a broadcast too large for one NOTIFY (over
//   8,000 bytes) for the other API tasks to read, deleted after 30 seconds by the adapter. It
//   holds only messages in flight between API tasks, never workspace data at rest, so it has no
//   row-level security; the app role may not create tables, so it is made here.
// Changes themselves are signalled with NOTIFY on the "helpdesk_live" channel inside the
// transaction that makes them (sent only if it commits), so no table is needed for those.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`
    CREATE TABLE socket_io_attachments (
      id bigserial UNIQUE,
      created_at timestamptz DEFAULT now(),
      payload bytea
    )`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query('DROP TABLE IF EXISTS socket_io_attachments');
}
