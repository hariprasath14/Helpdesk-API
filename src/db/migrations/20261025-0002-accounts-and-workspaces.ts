import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F1, sign-up and workspace.
//
// - users and workspaces are global registries (a person can belong to several workspaces; a
//   workspace is looked up by its address before anyone is signed in), so they have no RLS.
//   The app scopes them in code.
// - memberships is the first tenant table: row-level security by workspace_id.
// - email_verifications and sessions are looked up by a token hash before a workspace context
//   exists; only hashes are stored, never the tokens themselves.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run('CREATE EXTENSION IF NOT EXISTS citext');

    await run(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email citext NOT NULL UNIQUE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
        password_hash text NOT NULL,
        email_verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Finds unverified sign-ups older than 7 days, which release their workspace address.
    await run(
      'CREATE INDEX users_unverified_created_idx ON users (created_at) WHERE email_verified_at IS NULL',
    );

    await run(`
      CREATE TABLE workspaces (
        id uuid PRIMARY KEY,
        name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
        subdomain text NOT NULL UNIQUE
          CHECK (subdomain ~ '^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$'),
        timezone text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending', 'active')),
        trial_started_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      "CREATE INDEX workspaces_pending_created_idx ON workspaces (created_at) WHERE status = 'pending'",
    );

    await run(`
      CREATE TABLE memberships (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('admin', 'supervisor', 'agent')),
        is_owner boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_id, user_id)
      )`);
    await run('CREATE INDEX memberships_workspace_role_idx ON memberships (workspace_id, role)');
    await run('CREATE INDEX memberships_user_idx ON memberships (user_id)');
    await enableTenantIsolation(context, 'memberships', transaction);

    await run(`
      CREATE TABLE email_verifications (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run('CREATE INDEX email_verifications_user_idx ON email_verifications (user_id)');
    await run(
      'CREATE INDEX email_verifications_workspace_idx ON email_verifications (workspace_id)',
    );

    await run(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        ip text,
        user_agent text,
        expires_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run('CREATE INDEX sessions_user_idx ON sessions (user_id)');
    await run('CREATE INDEX sessions_workspace_idx ON sessions (workspace_id)');
    await run('CREATE INDEX sessions_expires_idx ON sessions (expires_at)');
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP TABLE IF EXISTS sessions');
    await run('DROP TABLE IF EXISTS email_verifications');
    await disableTenantIsolation(context, 'memberships', transaction);
    await run('DROP TABLE IF EXISTS memberships');
    await run('DROP TABLE IF EXISTS workspaces');
    await run('DROP TABLE IF EXISTS users');
  });
}
