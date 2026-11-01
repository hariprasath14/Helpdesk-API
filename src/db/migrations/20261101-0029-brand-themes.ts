import type { QueryInterface } from 'sequelize';

// The rebrand to the new product name (2026-11-01) replaces the colour themes: Forest (the new
// default) and Indigo instead of Help Teal and Ocean Cyan. People keep their choice: Help Teal
// becomes Forest and Ocean Cyan becomes Indigo.

async function switchThemes(
  context: QueryInterface,
  from: [string, string],
  to: [string, string],
): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await q.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_check', { transaction });
    await q.query(
      `UPDATE users SET theme = CASE theme WHEN :from0 THEN :to0 WHEN :from1 THEN :to1 END
        WHERE theme IS NOT NULL`,
      { transaction, replacements: { from0: from[0], to0: to[0], from1: from[1], to1: to[1] } },
    );
    await q.query(
      `ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN (:to0, :to1))`,
      { transaction, replacements: { to0: to[0], to1: to[1] } },
    );
  });
}

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await switchThemes(context, ['help-teal', 'ocean-cyan'], ['forest', 'indigo']);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await switchThemes(context, ['forest', 'indigo'], ['help-teal', 'ocean-cyan']);
}
