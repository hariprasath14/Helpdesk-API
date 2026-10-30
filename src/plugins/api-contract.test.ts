import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorResponses } from '../lib/schemas.js';
import { formatSpec, generateOpenApiSpec, OPENAPI_FILE } from '../openapi.js';
import { captureLogs, testApp } from '../test/helpers.js';

let app: FastifyInstance;
// Set only by tests that build an app, so tests without one need no cleanup.
let opened: FastifyInstance | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const ProbeUser = z.object({ id: z.string(), email: z.email() }).meta({ id: 'ProbeUser' });

/** Builds the app with probe routes that use Zod schemas the way feature modules will. */
async function probeApp(overrides: Record<string, string> = {}) {
  const logs = captureLogs();
  app = await testApp(
    { LOG_LEVEL: 'info', ...overrides },
    { logStream: logs.stream, ready: false },
  );
  opened = app;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/probe/users',
    {
      schema: {
        body: z.object({ email: z.email(), name: z.string().min(2) }),
        querystring: z.object({ notify: z.enum(['yes', 'no']).optional() }),
        response: { 201: ProbeUser, ...errorResponses() },
      },
    },
    async (request, reply) => {
      // A database row often has more fields than the API may show; the schema strips them.
      const row = { id: 'u1', email: request.body.email, passwordHash: 'argon2id$secret' };
      return reply.status(201).send(row);
    },
  );
  routes.get(
    '/probe/broken-response',
    { schema: { response: { 200: ProbeUser } } },
    // Deliberately wrong: the handler's output does not match its own schema.
    () => ({ id: 'u1', email: 'not-an-email' }),
  );

  await app.ready();
  return { logs };
}

describe('request validation', () => {
  it('rejects an invalid body with the standard error and a list of fields', async () => {
    await probeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/users',
      payload: { email: 'nope', name: 'A' },
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<{
      error: { code: string; message: string; details: { fields: { field: string }[] } };
    }>();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('The request body is invalid.');
    expect(error.details.fields.map((f) => f.field).sort()).toEqual(['email', 'name']);
  });

  it('names the query string when that is what is wrong', async () => {
    await probeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/users?notify=maybe',
      payload: { email: 'a@b.co', name: 'Ann' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      'The query string is invalid.',
    );
  });
});

describe('response schemas', () => {
  it('send only the fields in the schema, so internal fields never leak', async () => {
    await probeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/probe/users',
      payload: { email: 'ann@example.com', name: 'Ann' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: 'u1', email: 'ann@example.com' });
    expect(response.body).not.toContain('argon2id');
  });

  it('turn a response that breaks its own schema into a logged 500', async () => {
    const { logs } = await probeApp();
    const response = await app.inject({ method: 'GET', url: '/probe/broken-response' });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('not-an-email');
    expect(logs.lines.some((line) => line.msg === 'response does not match its schema')).toBe(true);
  });
});

describe('OpenAPI spec', () => {
  it('describes every route with named request, response and error schemas', async () => {
    await probeApp();
    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };

    const health = spec.paths['/health']?.get?.responses ?? {};
    expect(Object.keys(health).sort()).toEqual(['200', '400', '429', '500', '503']);
    expect(JSON.stringify(health['200'])).toContain('#/components/schemas/HealthResponse');
    expect(JSON.stringify(health['500'])).toContain('#/components/schemas/ErrorResponse');
    expect(spec.paths['/probe/users']?.post?.responses).toHaveProperty('201');
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['ErrorResponse', 'HealthResponse', 'ProbeUser']),
    );
  });

  it('contains only schemas that something refers to', async () => {
    await probeApp();
    const spec = app.swagger() as unknown as { components: { schemas: Record<string, unknown> } };
    const { components, ...rest } = spec;
    const text = JSON.stringify({ rest, schemas: components.schemas });
    // Request bodies get an "Input" copy (SignUpRequestInput) and responses the plain name; each
    // kept schema must be referenced from somewhere in the spec.
    for (const name of Object.keys(components.schemas)) {
      expect(text, name).toContain(`#/components/schemas/${name}"`);
    }
  });

  it('matches the committed openapi.json (run "npm run openapi" if this fails)', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo path
    const committed = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as unknown;
    expect(await generateOpenApiSpec()).toEqual(committed);
  });

  it('is written as stable two-space JSON with a trailing newline', () => {
    expect(formatSpec({ a: [1] })).toBe(['{', '  "a": [', '    1', '  ]', '}', ''].join('\n'));
  });
});

describe('API docs page', () => {
  it('is served with its own Content-Security-Policy when enabled', async () => {
    await probeApp({ API_DOCS_ENABLED: 'true' });
    const page = await app.inject({ method: 'GET', url: '/docs/' });
    const json = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(json.json<{ openapi: string }>().openapi).toBe('3.1.0');
  });

  it('does not exist when disabled, as in prod', async () => {
    await probeApp({ API_DOCS_ENABLED: 'false' });
    expect((await app.inject({ method: 'GET', url: '/docs/' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
  });
});
