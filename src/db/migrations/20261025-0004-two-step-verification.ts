import type { QueryInterface } from 'sequelize';

// F3, two-step verification (authenticator app codes).
//
// - user_two_factor holds a person's authenticator secret, encrypted (the server must read it back
//   to check codes, so it cannot be a hash). enabled_at stays empty until the first code confirms
//   setup. last_used_step stops a code being used twice.
// - recovery_codes are one-time codes for a lost phone, stored as hashes.
// - login_challenges are the "half signed in" step between a correct password and a correct code:
//   short-lived, single use, hash only.
// - trusted_devices remember "don't ask again on this device for 30 days", hash only.
// - All four belong to a person (one login for every workspace), so like users they have no RLS.
// - workspaces.require_two_factor is the admin's "require it for everyone" switch.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE user_two_factor (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        secret_encrypted text NOT NULL,
        key_id text NOT NULL,
        enabled_at timestamptz,
        last_used_step bigint,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

    await run(`
      CREATE TABLE recovery_codes (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash text NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, code_hash)
      )`);

    await run(`
      CREATE TABLE login_challenges (
        id uuid PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        failed_attempts integer NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run('CREATE INDEX login_challenges_user_idx ON login_challenges (user_id)');
    await run('CREATE INDEX login_challenges_workspace_idx ON login_challenges (workspace_id)');
    // Clearing out old rows.
    await run('CREATE INDEX login_challenges_expires_idx ON login_challenges (expires_at)');

    await run(`
      CREATE TABLE trusted_devices (
        id uuid PRIMARY KEY,
        token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        user_agent text,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run('CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id)');

    await run(
      'ALTER TABLE workspaces ADD COLUMN require_two_factor boolean NOT NULL DEFAULT false',
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });
    await run('ALTER TABLE workspaces DROP COLUMN IF EXISTS require_two_factor');
    await run('DROP TABLE IF EXISTS trusted_devices');
    await run('DROP TABLE IF EXISTS login_challenges');
    await run('DROP TABLE IF EXISTS recovery_codes');
    await run('DROP TABLE IF EXISTS user_two_factor');
  });
}
