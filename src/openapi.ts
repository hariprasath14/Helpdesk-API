import { readFileSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createDatabase } from './db/index.js';

// src/openapi.ts and dist/openapi.js both sit one folder below package.json.
const packageJsonUrl = new URL('../package.json', import.meta.url);

/** The committed spec file that helpdesk-web generates its typed client from. */
export const OPENAPI_FILE = new URL('../openapi.json', import.meta.url);

/**
 * Builds the app with placeholder settings (nothing connects) and returns its OpenAPI spec. The
 * spec version is the package version, so the committed file only changes when the API does.
 */
export async function generateOpenApiSpec(): Promise<object> {
  // A fixed path inside the repo, not user input.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const { version } = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version: string };
  const config = loadConfig({
    APP_VERSION: version,
    LOG_LEVEL: 'silent',
    CORS_ORIGINS: 'http://localhost',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    DATABASE_READ_URL: 'postgres://unused@127.0.0.1:1/unused',
    APP_PUBLIC_URL: 'http://localhost',
    // Only builds the spec; never encrypts anything.
    TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  });
  const db = createDatabase(config);
  const app = await buildApp(config, { db });
  try {
    await app.ready();
    return app.swagger();
  } finally {
    await app.close();
    await db.close();
  }
}

/** Stable text for the spec file: two-space JSON with a trailing newline. */
export function formatSpec(spec: object): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}
