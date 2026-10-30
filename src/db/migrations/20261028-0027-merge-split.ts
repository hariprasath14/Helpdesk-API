import type { QueryInterface } from 'sequelize';

// F28, merge and split.
//
// - tickets.merged_into_id: a ticket merged into another is closed and read-only, and email to its
//   old thread lands on that one.
// - tickets.cc_emails: people copied on every reply of the ticket (the requesters of tickets
//   merged into it).
// - ticket_messages.from_ticket_number: a message moved in by a merge, "From #41".

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run(`
      ALTER TABLE tickets
        ADD COLUMN merged_into_id uuid REFERENCES tickets (id) ON DELETE SET NULL,
        ADD COLUMN cc_emails text[] NOT NULL DEFAULT '{}'`);
    await run('CREATE INDEX tickets_merged_into_idx ON tickets (merged_into_id)');
    await run('ALTER TABLE ticket_messages ADD COLUMN from_ticket_number integer');
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('ALTER TABLE ticket_messages DROP COLUMN IF EXISTS from_ticket_number');
    await run('DROP INDEX IF EXISTS tickets_merged_into_idx');
    await run(
      'ALTER TABLE tickets DROP COLUMN IF EXISTS cc_emails, DROP COLUMN IF EXISTS merged_into_id',
    );
  });
}
