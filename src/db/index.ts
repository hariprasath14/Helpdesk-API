import { readFileSync } from 'node:fs';
import { Sequelize, type Options } from 'sequelize';
import type { Config, MigrationConfig } from '../config/index.js';

type ConnectionSettings = Pick<
  Config,
  'DATABASE_SSL' | 'DATABASE_SSL_CA_FILE' | 'DATABASE_POOL_MAX' | 'DATABASE_STATEMENT_TIMEOUT_MS'
>;

/** The two connection pools to the environment's single database (ENGINEERING_STANDARDS.md 1). */
export interface Database {
  /** All writes, and any read that must see data just written. */
  writer: Sequelize;
  /** Heavy read-only queries (lists, search, reports). May lag the writer slightly on AWS. */
  reader: Sequelize;
  close(): Promise<void>;
}

export function connect(url: string, settings: ConnectionSettings, applicationName: string) {
  const options: Options = {
    dialect: 'postgres',
    logging: false,
    pool: { max: settings.DATABASE_POOL_MAX, min: 0, idle: 10_000, acquire: 10_000 },
    define: { underscored: true, timestamps: true },
    dialectOptions: {
      application_name: applicationName,
      statement_timeout: settings.DATABASE_STATEMENT_TIMEOUT_MS,
      ...(settings.DATABASE_SSL
        ? {
            ssl: {
              rejectUnauthorized: true,
              ...(settings.DATABASE_SSL_CA_FILE
                ? // The path comes from validated settings, not from user input.
                  // eslint-disable-next-line security/detect-non-literal-fs-filename
                  { ca: readFileSync(settings.DATABASE_SSL_CA_FILE, 'utf8') }
                : {}),
            },
          }
        : {}),
    },
  };
  return new Sequelize(url, options);
}

/** Opens the writer and reader pools. Nothing connects until the first query. */
export function createDatabase(config: Config, applicationName = 'helpdesk-api'): Database {
  const writer = connect(config.DATABASE_URL, config, `${applicationName}:writer`);
  const reader = connect(config.DATABASE_READ_URL, config, `${applicationName}:reader`);
  return {
    writer,
    reader,
    async close() {
      await Promise.all([writer.close(), reader.close()]);
    },
  };
}

/** The schema-owner connection used only by migrations and seeds. */
export function connectAsMigrator(config: MigrationConfig): Sequelize {
  return connect(config.DATABASE_MIGRATION_URL, config, 'helpdesk-migrate');
}

/** True when a trivial query succeeds within `timeoutMs`. Used by /health. */
export async function isReachable(sequelize: Sequelize, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([sequelize.query('SELECT 1').then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
