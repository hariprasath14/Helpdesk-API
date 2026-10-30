import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F7, contacts and companies: the people who raise tickets and the organisations they belong to.
//
// - companies: name (unique in a workspace, ignoring case), phone, website, a private note and
//   custom field values (JSONB keyed by field key, F6).
// - company_domains: a company's email domains, one company per domain, so a new contact whose
//   email matches is linked to it. Stored in lowercase.
// - contacts: name, primary email, phone, job title, company, note and custom field values. A
//   contact has an email or a phone. sort_name keeps the name order index-friendly.
// - contact_emails: every email of every contact, the primary one included, so no email belongs
//   to two contacts and email-to-ticket (F13) matches any of them. Stored in lowercase.
// - Search ("%neha%") scans one workspace's rows through the workspace_id indexes. Trigram and
//   JSONB GIN indexes are not created: under row-level security Postgres can't use them for the
//   app role (ILIKE and @> are not leakproof), so they would only slow writes. See ARCHITECTURE.md
//   decisions, 2026-10-26.
// - Audit entries for deletes get their own category, "contacts".
// All four are tenant tables with row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE companies (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        sort_name text GENERATED ALWAYS AS (lower(name)) STORED,
        phone text CHECK (char_length(phone) <= 40),
        website text CHECK (char_length(website) <= 200),
        note text CHECK (char_length(note) <= 5000),
        custom_fields jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE UNIQUE INDEX companies_workspace_name_key ON companies (workspace_id, sort_name)',
    );
    await enableTenantIsolation(context, 'companies', transaction);

    await run(`
      CREATE TABLE company_domains (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
        domain text NOT NULL CHECK (domain = lower(domain) AND char_length(domain) BETWEEN 3 AND 253),
        UNIQUE (workspace_id, domain)
      )`);
    await run('CREATE INDEX company_domains_company_idx ON company_domains (company_id)');
    await enableTenantIsolation(context, 'company_domains', transaction);

    await run(`
      CREATE TABLE contacts (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
        sort_name text GENERATED ALWAYS AS (lower(name)) STORED,
        email text CHECK (email = lower(email) AND char_length(email) <= 254),
        phone text CHECK (char_length(phone) <= 40),
        job_title text CHECK (char_length(job_title) <= 100),
        company_id uuid REFERENCES companies (id) ON DELETE SET NULL,
        note text CHECK (char_length(note) <= 5000),
        custom_fields jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (email IS NOT NULL OR phone IS NOT NULL)
      )`);
    // The two list orders, and a company's contacts.
    await run('CREATE INDEX contacts_workspace_name_idx ON contacts (workspace_id, sort_name, id)');
    await run(
      'CREATE INDEX contacts_workspace_updated_idx ON contacts (workspace_id, updated_at DESC, id DESC)',
    );
    await run(
      'CREATE INDEX contacts_workspace_company_idx ON contacts (workspace_id, company_id, sort_name, id)',
    );
    await run('CREATE INDEX contacts_company_idx ON contacts (company_id)');
    await enableTenantIsolation(context, 'contacts', transaction);

    await run(`
      CREATE TABLE contact_emails (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
        email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
        is_primary boolean NOT NULL DEFAULT false,
        UNIQUE (workspace_id, email)
      )`);
    await run('CREATE INDEX contact_emails_contact_idx ON contact_emails (contact_id)');
    await enableTenantIsolation(context, 'contact_emails', transaction);

    await run('ALTER TABLE audit_events DROP CONSTRAINT audit_events_category_check');
    await run(`
      ALTER TABLE audit_events ADD CONSTRAINT audit_events_category_check
        CHECK (category IN ('members', 'security', 'settings', 'sign_in', 'contacts'))`);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run("DELETE FROM audit_events WHERE category = 'contacts'");
    await run('ALTER TABLE audit_events DROP CONSTRAINT audit_events_category_check');
    await run(`
      ALTER TABLE audit_events ADD CONSTRAINT audit_events_category_check
        CHECK (category IN ('members', 'security', 'settings', 'sign_in'))`);
    for (const table of ['contact_emails', 'contacts', 'company_domains', 'companies']) {
      await disableTenantIsolation(context, table, transaction);
      await run(`DROP TABLE IF EXISTS ${table}`);
    }
  });
}
