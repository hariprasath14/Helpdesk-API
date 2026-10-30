import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadMigrationConfig } from './index.js';

const minimal = {
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/helpdesk',
  DATABASE_READ_URL: 'postgres://ro:pw@db-ro.internal:5432/helpdesk',
  APP_PUBLIC_URL: 'https://helpdesk.example.com',
  TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(minimal);
    expect(config).toMatchObject({
      HOST: '0.0.0.0',
      PORT: 4000,
      LOG_LEVEL: 'info',
      LOG_FORMAT: 'json',
      TRUST_PROXY: false,
      RATE_LIMIT_MAX: 300,
      BODY_LIMIT_BYTES: 1048576,
      DATABASE_SSL: true,
      DATABASE_POOL_MAX: 10,
      DATABASE_STATEMENT_TIMEOUT_MS: 15000,
    });
  });

  it('reads inbound email mailboxes as a list, and needs a bucket for s3', () => {
    expect(loadConfig(minimal).INBOUND_EMAIL_DRIVER).toEqual([]);
    expect(loadConfig({ ...minimal, INBOUND_EMAIL_DRIVER: 'none' }).INBOUND_EMAIL_DRIVER).toEqual(
      [],
    );
    expect(
      loadConfig({
        ...minimal,
        INBOUND_EMAIL_DRIVER: 'mailpit, s3,mailpit',
        INBOUND_EMAIL_BUCKET: 'helpdesk-dev-inbound-email',
      }),
    ).toMatchObject({
      INBOUND_EMAIL_DRIVER: ['mailpit', 's3'],
      INBOUND_EMAIL_PREFIX: 'inbound/',
      INBOUND_EMAIL_REGION: 'ap-south-1',
    });
    expect(() => loadConfig({ ...minimal, INBOUND_EMAIL_DRIVER: 's3' })).toThrow(
      'INBOUND_EMAIL_BUCKET is required',
    );
    expect(() => loadConfig({ ...minimal, INBOUND_EMAIL_DRIVER: 'imap' })).toThrow(ConfigError);
  });

  it('parses numbers, booleans and origin lists', () => {
    const config = loadConfig({
      ...minimal,
      CORS_ORIGINS: ' http://localhost:5173 , https://app.helpdesk.example.com ',
      PORT: '8080',
      TRUST_PROXY: 'true',
    });
    expect(config.PORT).toBe(8080);
    expect(config.TRUST_PROXY).toBe(true);
    expect(config.CORS_ORIGINS).toEqual([
      'http://localhost:5173',
      'https://app.helpdesk.example.com',
    ]);
  });

  it('refuses to start when a required setting is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/CORS_ORIGINS/);
  });

  it('treats an empty value the same as a missing one', () => {
    expect(() => loadConfig({ ...minimal, CORS_ORIGINS: '' })).toThrow(/CORS_ORIGINS/);
    expect(loadConfig({ ...minimal, PORT: '' }).PORT).toBe(4000);
  });

  it('lists every invalid setting at once', () => {
    try {
      loadConfig({
        CORS_ORIGINS: 'not-a-url',
        PORT: '99999',
        TRUST_PROXY: 'yes',
        LOG_LEVEL: 'loud',
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      for (const key of ['CORS_ORIGINS', 'PORT', 'TRUST_PROXY', 'LOG_LEVEL']) {
        expect(issues).toContain(key);
      }
    }
  });

  it('rejects origins with a path, a trailing slash or a non-http scheme', () => {
    for (const origin of [
      'http://localhost:5173/',
      'https://app.helpdesk.example.com/app',
      'ftp://files.example.com',
    ]) {
      expect(() => loadConfig({ ...minimal, CORS_ORIGINS: origin }), origin).toThrow(
        /CORS_ORIGINS/,
      );
    }
  });

  it('requires both database connections, even when they point to the same database', () => {
    expect(() => loadConfig({ ...minimal, DATABASE_READ_URL: '' })).toThrow(/DATABASE_READ_URL/);
    expect(() => loadConfig({ ...minimal, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('accepts only postgres connection strings', () => {
    expect(() => loadConfig({ ...minimal, DATABASE_URL: 'mysql://app:pw@db:3306/x' })).toThrow(
      /DATABASE_URL/,
    );
    expect(
      loadConfig({ ...minimal, DATABASE_URL: 'postgresql://a:b@db:5432/x' }).DATABASE_URL,
    ).toBe('postgresql://a:b@db:5432/x');
  });

  it('keeps database TLS on unless it is explicitly turned off', () => {
    expect(loadConfig(minimal).DATABASE_SSL).toBe(true);
    expect(loadConfig({ ...minimal, DATABASE_SSL: 'false' }).DATABASE_SSL).toBe(false);
  });

  it('never needs the migrator connection to run the app', () => {
    expect(loadConfig(minimal)).not.toHaveProperty('DATABASE_MIGRATION_URL');
  });
});

describe('loadMigrationConfig', () => {
  it('requires only the migrator connection', () => {
    expect(() => loadMigrationConfig({})).toThrow(/DATABASE_MIGRATION_URL/);
    const config = loadMigrationConfig({
      DATABASE_MIGRATION_URL: 'postgres://owner:pw@db:5432/helpdesk',
    });
    expect(config.DATABASE_MIGRATION_URL).toBe('postgres://owner:pw@db:5432/helpdesk');
    expect(config.DATABASE_SSL).toBe(true);
  });
});

describe('app address and sign-in settings', () => {
  it('reads the public address and keeps secure defaults', () => {
    const config = loadConfig(minimal);
    expect(config.APP_PUBLIC_URL.hostname).toBe('helpdesk.example.com');
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.PASSWORD_BREACH_CHECK).toBe(true);
    expect(config.SESSION_IDLE_HOURS).toBe(8);
    expect(config.SESSION_ABSOLUTE_DAYS).toBe(7);
  });

  it('requires a 32-byte two-step verification key', () => {
    expect(loadConfig(minimal).TWO_FACTOR_ENCRYPTION_KEY).toHaveLength(32);
    for (const value of ['', Buffer.alloc(16).toString('base64'), 'not-base64-at-all']) {
      expect(() => loadConfig({ ...minimal, TWO_FACTOR_ENCRYPTION_KEY: value })).toThrow(
        /TWO_FACTOR_ENCRYPTION_KEY/,
      );
    }
  });

  it('requires the public address and refuses one with a path', () => {
    expect(() => loadConfig({ ...minimal, APP_PUBLIC_URL: '' })).toThrow(/APP_PUBLIC_URL/);
    expect(() =>
      loadConfig({ ...minimal, APP_PUBLIC_URL: 'https://helpdesk.example.com/app' }),
    ).toThrow(/APP_PUBLIC_URL/);
  });
});
