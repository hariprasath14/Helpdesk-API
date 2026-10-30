import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from './lib/errors.js';
import { captureLogs, testApp } from './test/helpers.js';

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

async function appWithRoutes(overrides: Record<string, string> = {}) {
  const logs = captureLogs();
  app = await testApp({ LOG_LEVEL: 'info', ...overrides }, { logStream: logs.stream });
  return { logs };
}

/** Builds the app with probe routes that exercise the shared error handling and security plugins. */
async function buildWithProbeRoutes(overrides: Record<string, string> = {}) {
  const logs = captureLogs();
  app = await testApp(
    { LOG_LEVEL: 'info', ...overrides },
    { logStream: logs.stream, ready: false },
  );
  app.get('/probe/forbidden', () => {
    throw new ForbiddenError();
  });
  app.get('/probe/not-found', () => {
    throw new NotFoundError('Ticket not found.');
  });
  app.get('/probe/conflict', () => {
    throw new ConflictError('Already merged.', { ticketId: 'abc' });
  });
  app.get('/probe/crash', () => {
    throw new Error('database password is hunter2');
  });
  app.post('/probe/echo', (request) => ({ received: request.body }));
  await app.ready();
  return { logs };
}

describe('security headers', () => {
  it('sets strict headers on every response', async () => {
    await appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a server-generated request ID and ignores one sent by the client', async () => {
    await appWithRoutes();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'attacker-chosen' },
    });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('attacker-chosen');
  });
});

describe('CORS', () => {
  it('allows an origin on the allowlist, with credentials', async () => {
    await appWithRoutes();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow other origins', async () => {
    await appWithRoutes();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests only for allowed origins', async () => {
    await appWithRoutes();
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    const blocked = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('error format', () => {
  it('returns 404 in the standard shape for unknown endpoints', async () => {
    await appWithRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' },
    });
  });

  it.each([
    [
      '/probe/forbidden',
      403,
      { code: 'FORBIDDEN', message: 'You do not have permission to do this.' },
    ],
    ['/probe/not-found', 404, { code: 'NOT_FOUND', message: 'Ticket not found.' }],
    [
      '/probe/conflict',
      409,
      { code: 'CONFLICT', message: 'Already merged.', details: { ticketId: 'abc' } },
    ],
  ])('maps typed errors from %s to their status and code', async (url, status, error) => {
    await buildWithProbeRoutes();
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error });
  });

  it('hides internal details of unexpected errors from the client but logs them', async () => {
    const { logs } = await buildWithProbeRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe/crash' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side. Please try again.',
      },
    });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('at ');
    expect(logs.lines.some((line) => line.msg === 'unhandled error' && line.level === 50)).toBe(
      true,
    );
  });

  it('rejects malformed JSON with a validation error', async () => {
    await buildWithProbeRoutes();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken": ',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON.' },
    });
  });

  it('rejects bodies larger than the limit', async () => {
    await buildWithProbeRoutes({ BODY_LIMIT_BYTES: '100' });
    const response = await app.inject({
      method: 'POST',
      url: '/probe/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'x'.repeat(500) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects unsupported content types', async () => {
    await buildWithProbeRoutes();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/echo',
      headers: { 'content-type': 'application/x-unknown' },
      payload: 'hello',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('keeps AppError usable for custom status codes', () => {
    const error = new AppError(422, 'CUSTOM', 'Custom message.');
    expect(error.name).toBe('AppError');
    expect(error.statusCode).toBe(422);
  });
});

describe('rate limiting', () => {
  it('returns 429 in the standard shape after the limit, with a retry hint', async () => {
    await buildWithProbeRoutes({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await app.inject({ method: 'GET', url: '/probe/not-found' });
      statuses.push(last.statusCode);
    }

    expect(statuses).toEqual([404, 404, 404, 429]);
    expect(last?.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: expect.any(Number) as number } },
    });
    expect(last?.headers['retry-after']).toBeDefined();
  });

  it('counts each client IP separately', async () => {
    await buildWithProbeRoutes({ RATE_LIMIT_MAX: '1' });
    const first = await app.inject({
      method: 'GET',
      url: '/probe/not-found',
      remoteAddress: '10.0.0.1',
    });
    const other = await app.inject({
      method: 'GET',
      url: '/probe/not-found',
      remoteAddress: '10.0.0.2',
    });

    expect(first.statusCode).toBe(404);
    expect(other.statusCode).toBe(404);
  });
});

describe('logging', () => {
  it('never writes cookies, authorization headers or passwords to the logs', async () => {
    const { logs } = await buildWithProbeRoutes();
    await app.inject({
      method: 'POST',
      url: '/probe/echo',
      headers: {
        cookie: 'sid=super-secret-session',
        authorization: 'Bearer super-secret-token',
        'content-type': 'application/json',
      },
      payload: { password: 'super-secret-password' },
    });
    app.log.info({ user: { email: 'a@b.c', password: 'super-secret-password' } }, 'test line');

    const text = logs.text();
    expect(text).toContain('incoming request');
    expect(text).not.toContain('super-secret');
  });

  it('tags every request log line with the request ID', async () => {
    const { logs } = await buildWithProbeRoutes();
    const response = await app.inject({ method: 'GET', url: '/probe/not-found' });

    const requestLines = logs.lines.filter(
      (line) => line.reqId === response.headers['x-request-id'],
    );
    expect(requestLines.length).toBeGreaterThanOrEqual(2);
  });
});
