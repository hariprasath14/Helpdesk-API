import type { QueryInterface } from 'sequelize';

// F16, the web form: workspaces.web_form holds whether the public "Contact support" page is on,
// its title and its intro text (Settings → Web form). Off until an admin turns it on.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`
    ALTER TABLE workspaces
      ADD COLUMN web_form jsonb NOT NULL
        DEFAULT '{"enabled": false, "title": "Contact support", "intro": ""}'::jsonb`);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query('ALTER TABLE workspaces DROP COLUMN IF EXISTS web_form');
}
