import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F6, custom fields: admin-defined fields on tickets, contacts and companies.
//
// - custom_fields holds each field's definition. The key is created from the first label and never
//   changes, so rules, the API and exports keep working after a rename. The type never changes
//   either. Archived fields keep their values on records.
// - custom_field_choices holds dropdown and multi-select choices. Records store choice ids, so a
//   renamed choice shows its new label everywhere; a removed choice is kept (removed_at) so old
//   records still show it.
// - Values live on each record (tickets, contacts, companies) in a JSONB column added with those
//   tables (F7, F9).
// - Both are tenant tables with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE custom_fields (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        record_type text NOT NULL CHECK (record_type IN ('ticket', 'contact', 'company')),
        key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,49}$'),
        label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
        help_text text CHECK (char_length(help_text) <= 200),
        type text NOT NULL CHECK (type IN (
          'text', 'paragraph', 'integer', 'decimal', 'date', 'dropdown', 'multi_select', 'checkbox'
        )),
        required text NOT NULL DEFAULT 'never' CHECK (required IN ('never', 'always', 'on_resolve')),
        default_value jsonb,
        position integer NOT NULL,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, record_type, key),
        CHECK (required <> 'on_resolve' OR record_type = 'ticket')
      )`);
    // Forms list a record type's fields in order.
    await run(
      'CREATE INDEX custom_fields_workspace_type_position_idx ON custom_fields (workspace_id, record_type, position)',
    );
    await enableTenantIsolation(context, 'custom_fields', transaction);

    await run(`
      CREATE TABLE custom_field_choices (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        field_id uuid NOT NULL REFERENCES custom_fields (id) ON DELETE CASCADE,
        label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
        position integer NOT NULL,
        removed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX custom_field_choices_workspace_field_idx ON custom_field_choices (workspace_id, field_id, position)',
    );
    await run('CREATE INDEX custom_field_choices_field_idx ON custom_field_choices (field_id)');
    await enableTenantIsolation(context, 'custom_field_choices', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await disableTenantIsolation(context, 'custom_field_choices', transaction);
    await q.query('DROP TABLE IF EXISTS custom_field_choices', { transaction });
    await disableTenantIsolation(context, 'custom_fields', transaction);
    await q.query('DROP TABLE IF EXISTS custom_fields', { transaction });
  });
}
