import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { EmailMessage, EmailSender } from '../adapters/email/index.js';
import { buildApp } from '../app.js';
import { loadConfig, loadMigrationConfig, type Config } from '../config/index.js';
import { connectAsMigrator, createDatabase } from '../db/index.js';
import type { BreachCheck } from '../modules/accounts/passwords.js';

/**
 * Tests use the separate `helpdesk_test` database from docker compose, with the same three roles
 * as the real app. The pipeline overrides these with its own Postgres service.
 *
 * `helpdesk_test_replica` has the same schema but never receives writes. Pointing the reader at
 * it simulates an Aurora reader that has not caught up yet (see `LAGGING_READER`).
 */
export const TEST_DATABASE = {
  app:
    process.env.TEST_DATABASE_URL ??
    'postgres://helpdesk_app:app_local_only@127.0.0.1:5432/helpdesk_test',
  readonly:
    process.env.TEST_DATABASE_READ_URL ??
    'postgres://helpdesk_readonly:readonly_local_only@127.0.0.1:5432/helpdesk_test',
  migrator:
    process.env.TEST_DATABASE_MIGRATION_URL ??
    'postgres://helpdesk_migrator:migrator_local_only@127.0.0.1:5432/helpdesk_test',
  replicaReadonly:
    process.env.TEST_REPLICA_READ_URL ??
    'postgres://helpdesk_readonly:readonly_local_only@127.0.0.1:5432/helpdesk_test_replica',
  replicaMigrator:
    process.env.TEST_REPLICA_MIGRATION_URL ??
    'postgres://helpdesk_migrator:migrator_local_only@127.0.0.1:5432/helpdesk_test_replica',
};

/**
 * Config override that points the reader at the stale replica. Use it in every test of an
 * endpoint that writes: if the endpoint reads its own result back from the reader, it fails.
 */
export const LAGGING_READER = { DATABASE_READ_URL: TEST_DATABASE.replicaReadonly };

/** A valid config for tests, built through the real loader so defaults and parsing match production. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    LOG_FORMAT: 'json',
    DATABASE_URL: TEST_DATABASE.app,
    DATABASE_READ_URL: TEST_DATABASE.readonly,
    DATABASE_SSL: 'false',
    APP_PUBLIC_URL: 'http://helpdesk.test',
    COOKIE_SECURE: 'false',
    PASSWORD_BREACH_CHECK: 'false',
    TWO_FACTOR_ENCRYPTION_KEY: 'Djyp6xYn3NO8H3FqWCIc0f0CtAdAW6De6EL5m0WrdrE=',
    // Uploaded files go to a throwaway folder, and a small limit keeps the size tests quick.
    STORAGE_LOCAL_DIR: join(tmpdir(), 'helpdesk-test-storage'),
    ATTACHMENT_MAX_MB: '1',
    ...overrides,
  });
}

/** Writer and reader connections to the test database, as the app role and the readonly role. */
export function testDatabase(overrides: Record<string, string> = {}) {
  return createDatabase(testConfig(overrides), 'helpdesk-test');
}

/** The schema-owner connection, for setting up fixtures the app role may not create. */
export function testMigratorConnection(url = TEST_DATABASE.migrator) {
  return connectAsMigrator(
    loadMigrationConfig({ DATABASE_MIGRATION_URL: url, DATABASE_SSL: 'false' }),
  );
}

/** Collects JSON log lines so tests can check what was (and was not) logged. */
export function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { stream, lines, text: () => lines.map((line) => JSON.stringify(line)).join('\n') };
}

/** An email adapter that keeps messages in memory, so tests can read links from them. */
export function captureEmails() {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return {
    sender,
    sent,
    /** The last email to `to`, or undefined. */
    lastTo: (to: string) => sent.filter((message) => message.to === to).at(-1),
  };
}

export interface TestAppOptions {
  logStream?: Writable;
  ready?: boolean;
  /** Defaults to a fresh captureEmails().sender, so tests never send real email. */
  email?: EmailSender;
  breachCheck?: BreachCheck;
}

/**
 * Builds the app against the test database. Closing the app also closes its connections.
 * Pass `ready: false` to add extra routes before calling `app.ready()`.
 */
export async function testApp(
  overrides: Record<string, string> = {},
  { logStream, ready = true, email, breachCheck }: TestAppOptions = {},
) {
  const config = testConfig(overrides);
  const db = createDatabase(config, 'helpdesk-test');
  const app = await buildApp(config, {
    db,
    email: email ?? captureEmails().sender,
    ...(logStream ? { logStream } : {}),
    ...(breachCheck ? { breachCheck } : {}),
  });
  app.addHook('onClose', async () => {
    await db.close();
  });
  if (ready) await app.ready();
  return app;
}
