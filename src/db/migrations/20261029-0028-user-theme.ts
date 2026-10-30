import type { QueryInterface } from 'sequelize';

// Step 5b, the colour theme each person chooses in Your account → Appearance. Empty means the
// deployment's brand (VITE_BRAND). Follows the person on every device.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await q.query(
      `ALTER TABLE users
        ADD COLUMN theme text CHECK (theme IN ('help-teal', 'ocean-cyan'))`,
      { transaction },
    );
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await q.query('ALTER TABLE users DROP COLUMN IF EXISTS theme', { transaction });
  });
}
