import { basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { QueryInterface, Sequelize } from 'sequelize';
import { SequelizeStorage, Umzug } from 'umzug';

/** What every migration and seed file exports. `context` is the migrator's QueryInterface. */
export interface MigrationModule {
  up(params: { context: QueryInterface }): Promise<void>;
  down(params: { context: QueryInterface }): Promise<void>;
}

// Migrations run from .ts in development (tsx) and from .js in the built image, so the stored name
// drops the extension: "20261025-0001-roles-and-grants" is the same migration in both.
function folderGlob(folder: string) {
  const dir = fileURLToPath(new URL(folder, import.meta.url)).replaceAll('\\', '/');
  return [`${dir}/*.{ts,js}`, { ignore: ['**/*.d.ts', '**/*.test.ts'] }] as [
    string,
    { ignore: string[] },
  ];
}

function createUmzug(sequelize: Sequelize, folder: string, tableName: string) {
  return new Umzug<QueryInterface>({
    migrations: {
      glob: folderGlob(folder),
      resolve: ({ name, path, context }) => {
        if (!path) throw new Error(`Migration ${name} has no file path`);
        const load = async () => (await import(pathToFileURL(path).href)) as MigrationModule;
        return {
          name: basename(name, extname(name)),
          up: async () => {
            await (await load()).up({ context });
          },
          down: async () => {
            await (await load()).down({ context });
          },
        };
      },
    },
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName }),
    logger: undefined,
  });
}

/** Schema migrations in src/db/migrations, tracked in the `schema_migrations` table. */
export function createMigrator(sequelize: Sequelize) {
  return createUmzug(sequelize, './migrations', 'schema_migrations');
}

/** Local and demo seed data in src/db/seeders, tracked in `schema_seeds` so each runs once. */
export function createSeeder(sequelize: Sequelize) {
  return createUmzug(sequelize, './seeders', 'schema_seeds');
}
