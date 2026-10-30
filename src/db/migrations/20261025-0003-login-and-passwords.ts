import type { QueryInterface } from 'sequelize';

// F2, login and password.
//
// - password_history keeps the last few password hashes, so a new password cannot repeat them.
// - password_resets holds "forgot password" links: hash only, single use, short expiry.
// - login_failures counts failed logins per email (whether or not the email has an account), for
//   the temporary lockout. Rows are short-lived.
// - All three belong to a person, not a workspace (one login for every workspace they are in), so
//   like users they have no row-level security.
// - memberships gets a second, read-only policy: a person can see their own memberships in every
//   workspace when app.user_id is set to them ("find your workspace"). Inside a workspace the
//   tenant_isolation policy still applies; policies are permissive, so either one grants a row.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE password_history (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX password_history_user_created_idx ON password_history (user_id, created_at DESC)',
    );

    await run(`
      CREATE TABLE password_resets (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    // "At most 3 reset emails an hour per person" counts by user and time.
    await run(
      'CREATE INDEX password_resets_user_created_idx ON password_resets (user_id, created_at DESC)',
    );
    await run('CREATE INDEX password_resets_workspace_idx ON password_resets (workspace_id)');

    await run(`
      CREATE TABLE login_failures (
        id uuid PRIMARY KEY,
        email citext NOT NULL,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run(
      'CREATE INDEX login_failures_email_created_idx ON login_failures (email, created_at DESC)',
    );
    // Clearing out old rows.
    await run('CREATE INDEX login_failures_created_idx ON login_failures (created_at)');

    await run(`
      CREATE POLICY own_memberships ON memberships FOR SELECT
        USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)`);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('DROP POLICY IF EXISTS own_memberships ON memberships');
    await run('DROP TABLE IF EXISTS login_failures');
    await run('DROP TABLE IF EXISTS password_resets');
    await run('DROP TABLE IF EXISTS password_history');
  });
}
