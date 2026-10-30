import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { testApp } from '../../test/helpers.js';

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

// A port nothing listens on, to simulate a database that is down.
const UNREACHABLE = 'postgres://helpdesk_readonly:x@127.0.0.1:1/helpdesk_test';

describe('GET /health', () => {
  it('reports ok with the version and both database connections', async () => {
    app = await testApp({ APP_VERSION: 'v1.2.3' });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      version: 'v1.2.3',
      checks: { databaseWriter: 'ok', databaseReader: 'ok' },
    });
  });

  it('returns 503 and names the failing connection when the reader is down', async () => {
    app = await testApp({ DATABASE_READ_URL: UNREACHABLE });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'error',
      checks: { databaseWriter: 'ok', databaseReader: 'error' },
    });
    expect(response.body).not.toContain('127.0.0.1');
  });

  it('returns 503 when the writer is down', async () => {
    app = await testApp({ DATABASE_URL: UNREACHABLE.replace('readonly', 'app') });
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { databaseWriter: 'error' } });
  });

  it('is never rate limited, so load balancer checks keep working', async () => {
    app = await testApp({ RATE_LIMIT_MAX: '2' });
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    }
  });
});
