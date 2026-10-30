import type { QueryInterface } from 'sequelize';

// Runs as helpdesk_migrator, the owner of the schema. Every table it creates from now on is
// readable and writable by the app role and readable by the readonly role. The app gets no DDL
// rights, and none of the roles can bypass row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`
    GRANT USAGE ON SCHEMA public TO helpdesk_app, helpdesk_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT ON TABLES TO helpdesk_readonly;
  `);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT ON TABLES FROM helpdesk_readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM helpdesk_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM helpdesk_app;
    REVOKE USAGE ON SCHEMA public FROM helpdesk_app, helpdesk_readonly;
  `);
}
