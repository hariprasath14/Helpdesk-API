import { ConfigError, loadMigrationConfig } from '../config/index.js';
import { connectAsMigrator } from './index.js';
import { createMigrator, createSeeder } from './migrator.js';

const USAGE = `Usage: migrate <command>
  up       apply all pending migrations
  down     undo the most recent migration
  status   list applied and pending migrations
  seed     run pending seed files (local and demo data only)`;

/**
 * Migration and seed command. Runs as the schema-owner role (DATABASE_MIGRATION_URL).
 * Locally: npm run db:migrate. In the image: node dist/db/migrate.js up (run by the pipeline).
 */
async function main(command: string | undefined) {
  const config = loadMigrationConfig();
  const sequelize = connectAsMigrator(config);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  try {
    const migrator = createMigrator(sequelize);
    switch (command) {
      case 'up': {
        const applied = await migrator.up();
        out(applied.length ? applied.map((m) => `applied  ${m.name}`).join('\n') : 'up to date');
        break;
      }
      case 'down': {
        const reverted = await migrator.down();
        out(
          reverted.length
            ? reverted.map((m) => `reverted ${m.name}`).join('\n')
            : 'nothing to undo',
        );
        break;
      }
      case 'status': {
        for (const m of await migrator.executed()) out(`applied  ${m.name}`);
        for (const m of await migrator.pending()) out(`pending  ${m.name}`);
        break;
      }
      case 'seed': {
        const pending = await migrator.pending();
        if (pending.length) throw new Error('Run migrations first: there are pending migrations.');
        const seeded = await createSeeder(sequelize).up();
        out(seeded.length ? seeded.map((m) => `seeded   ${m.name}`).join('\n') : 'no new seeds');
        break;
      }
      default:
        out(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await sequelize.close();
  }
}

main(process.argv[2]).catch((err: unknown) => {
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
