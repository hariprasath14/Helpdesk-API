import { createMigrator } from '../db/migrator.js';
import { TEST_DATABASE, testMigratorConnection } from './helpers.js';

/**
 * Runs once before all tests. The replica holds no data, so every migration is first undone and
 * reapplied there: a migration whose `down` is broken fails the test run, not a deploy rollback.
 * Then the test database is brought up to date.
 */
export default async function setup() {
  const replica = testMigratorConnection(TEST_DATABASE.replicaMigrator);
  const primary = testMigratorConnection(TEST_DATABASE.migrator);
  try {
    const replicaMigrator = createMigrator(replica);
    await replicaMigrator.up();
    await replicaMigrator.down({ to: 0 });
    await replicaMigrator.up();
    await createMigrator(primary).up();
  } catch (error) {
    throw new Error(
      'Could not migrate the test databases. Is Docker running? Start it with: docker compose up -d',
      { cause: error },
    );
  } finally {
    await Promise.all([replica.close(), primary.close()]);
  }
}
