import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

// Comma-separated list of exact origins, e.g. "http://localhost:5173,https://app.example.com".
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  )
  .pipe(
    z
      .array(
        // Zod still runs refinements after a failed format check, so guard the URL parse.
        z
          .url({ protocol: /^https?$/ })
          .refine((origin) => !URL.canParse(origin) || new URL(origin).origin === origin, {
            message:
              'must be a bare origin like https://app.example.com (no path or trailing slash)',
          }),
      )
      .min(1),
  );

const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

// Connection settings shared by the app and the migration command.
const databaseSettings = {
  // TLS to the database. Off only for the local Docker database; on everywhere else.
  DATABASE_SSL: booleanFlag.default(true),
  // CA bundle for verifying the server certificate (the Amazon RDS bundle on AWS).
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Any single query running longer than this is cancelled by Postgres.
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
};

const configSchema = z
  .object({
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_VERSION: z.string().min(1).default('local'),

    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

    // Set to true when running behind a load balancer (AWS ALB) so client IPs come from X-Forwarded-For.
    TRUST_PROXY: booleanFlag.default(false),
    CORS_ORIGINS: originList,

    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // Interactive API docs at /docs and the spec at /docs/json. On locally and in dev; off in prod.
    API_DOCS_ENABLED: booleanFlag.default(false),

    BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),

    // Writer: every write and any read that must see a just-written row. Reader: heavy read-only queries.
    // Both are required everywhere; locally they point at the same database (ENGINEERING_STANDARDS.md 1).
    DATABASE_URL: postgresUrl,
    DATABASE_READ_URL: postgresUrl,
    ...databaseSettings,

    // The address people open, without a workspace: sign-up lives here, and each workspace is a
    // subdomain of its host (http://localhost:5173 → http://acme.localhost:5173). Used for links in emails.
    APP_PUBLIC_URL: z
      .url({ protocol: /^https?$/ })
      .refine((value) => new URL(value).pathname === '/', { message: 'must not have a path' })
      .transform((value) => new URL(value)),

    // Sign-in cookie: Secure (HTTPS only) everywhere except local http.
    COOKIE_SECURE: booleanFlag.default(true),
    // A sign-in ends after this long without activity, and in any case this long after signing in.
    SESSION_IDLE_HOURS: z.coerce.number().int().positive().max(720).default(8),
    SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().max(90).default(7),

    // Encrypts authenticator secrets for two-step verification (AES-256-GCM): 32 random bytes,
    // base64 (openssl rand -base64 32). A secret: SSM SecureString on AWS, never shared between
    // environments. Replacing it makes existing two-step verification setups unreadable.
    TWO_FACTOR_ENCRYPTION_KEY: z
      .string()
      .transform((value) => Buffer.from(value, 'base64'))
      .refine((key) => key.length === 32, {
        message: 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)',
      }),

    // Checks new passwords against known data breaches (Have I Been Pwned, k-anonymity).
    PASSWORD_BREACH_CHECK: booleanFlag.default(true),

    // Email: smtp (Mailpit) or ses (Amazon SES, credentials from the AWS SDK's usual sources: the
    // container's role on AWS, AWS_* variables elsewhere).
    EMAIL_DRIVER: z.enum(['smtp', 'ses']).default('smtp'),
    SES_REGION: z.string().min(1).default('ap-south-1'),
    // SES configuration set for bounce and complaint tracking (optional).
    SES_CONFIGURATION_SET: z.string().min(1).optional(),
    // With ses: only these recipients really get email; everyone else's goes to SMTP (the test
    // mailbox). Comma-separated addresses or @domains, e.g. "@company.example,ravi@gmail.com". Empty: all.
    // A safety list for dev, where the SES account can already reach anyone.
    EMAIL_ALLOWED_RECIPIENTS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      )
      .optional(),
    EMAIL_FROM: z.string().min(3).default('no-reply@helpdesk.local'),
    // The domain of every workspace's own email address (F13): ticket email goes out from
    // "<workspace address>@TICKET_EMAIL_DOMAIN" and replies come back to it (F14). On AWS it must be
    // a domain SES may send from, with its MX pointing at SES receiving.
    TICKET_EMAIL_DOMAIN: z
      .string()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'must be a domain such as mail.helpdesk.example.com')
      .default('mail.helpdesk.local'),
    // Where email sent to workspace addresses is picked up (F14), comma separated. none: nowhere;
    // mailpit: the worker reads Mailpit's API (locally, and test email on the temporary dev server);
    // s3: the worker reads the raw emails SES receiving puts in INBOUND_EMAIL_BUCKET (real email).
    INBOUND_EMAIL_DRIVER: z
      .string()
      .transform((value) => [
        ...new Set(
          value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '' && entry !== 'none'),
        ),
      ])
      .pipe(z.array(z.enum(['mailpit', 's3'])))
      .default([]),
    MAILPIT_API_URL: z.url().default('http://127.0.0.1:8025'),
    // For s3: the bucket and key prefix SES receiving writes to, and the bucket's region.
    INBOUND_EMAIL_BUCKET: z.string().min(3).optional(),
    INBOUND_EMAIL_PREFIX: z.string().default('inbound/'),
    INBOUND_EMAIL_REGION: z.string().min(1).default('ap-south-1'),
    INBOUND_POLL_SECONDS: z.coerce.number().int().min(2).max(300).default(10),
    // Larger emails are refused (SES receiving allows up to 40 MB).
    INBOUND_EMAIL_MAX_MB: z.coerce.number().int().min(1).max(40).default(25),
    SMTP_HOST: z.string().min(1).default('127.0.0.1'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: booleanFlag.default(false),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),

    // Files (ticket attachments): local disk for now; s3 (private bucket, signed URLs) arrives with
    // the move to AWS (Step 0b).
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_DIR: z.string().min(1).default('./storage'),
    ATTACHMENT_MAX_MB: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((config) => !config.INBOUND_EMAIL_DRIVER.includes('s3') || config.INBOUND_EMAIL_BUCKET, {
    message: 'INBOUND_EMAIL_BUCKET is required when INBOUND_EMAIL_DRIVER includes s3',
    path: ['INBOUND_EMAIL_BUCKET'],
  });

export type Config = z.infer<typeof configSchema>;

const migrationConfigSchema = z.object({
  // The schema-owner role. Only the migration command uses it; the running app never does.
  DATABASE_MIGRATION_URL: postgresUrl,
  ...databaseSettings,
});

export type MigrationConfig = z.infer<typeof migrationConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  // Treat empty strings as "not set" so defaults and required checks behave the same for KEY= and a missing KEY.
  const input = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Reads and validates the API and worker settings once at startup. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return parse(configSchema, env);
}

/** Settings for the migration and seed command (`src/db/migrate.ts`). */
export function loadMigrationConfig(env: NodeJS.ProcessEnv = process.env): MigrationConfig {
  return parse(migrationConfigSchema, env);
}
