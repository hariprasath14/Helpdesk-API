import type { FastifyInstance, HTTPMethods, InjectOptions } from 'fastify';

/** A request as tests describe it: always a string URL, plain header and cookie maps. */
export interface TestRequest {
  method: HTTPMethods;
  url: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  payload?: InjectOptions['payload'];
}

type ActAs = Pick<TestRequest, 'headers' | 'cookies'>;

export interface IsolationCheck {
  /** The request that reaches the other workspace's data. */
  request: TestRequest;
  /**
   * `item`: a single resource (read, update, delete). Another workspace must get 404, never 403,
   * so it cannot even learn that the resource exists.
   * `list`: a list or search. Another workspace gets a normal response without the data.
   */
  kind: 'item' | 'list';
}

export interface TenantIsolationOptions {
  app: FastifyInstance;
  /** Two different workspaces. The resource belongs to `owner`; `intruder` tries to reach it. */
  workspaces: { owner: string; intruder: string };
  /**
   * Creates a resource in `owner` and returns the requests that reach it, plus text that must
   * never appear in another workspace's responses (for example a subject line).
   */
  setup(owner: string): Promise<{ checks: IsolationCheck[]; secrets: string[] }>;
  /** Extra request options that make a request act as a member of `workspaceId` (session cookie). */
  actAs(workspaceId: string): Promise<ActAs>;
}

function merge(request: TestRequest, as: ActAs): TestRequest {
  return {
    ...request,
    headers: { ...request.headers, ...as.headers },
    cookies: { ...request.cookies, ...as.cookies },
  };
}

export function describeRequest(request: TestRequest) {
  return `${request.method} ${request.url}`;
}

/**
 * The standard cross-tenant test for an endpoint (ENGINEERING_STANDARDS.md 6 and 7): every
 * endpoint that touches workspace data calls this. It first proves the owner can reach the
 * resource (so the test is not passing by accident), then that the intruder cannot.
 */
export async function expectTenantIsolation(options: TenantIsolationOptions): Promise<void> {
  const { app, workspaces } = options;
  const { checks, secrets } = await options.setup(workspaces.owner);
  if (checks.length === 0) throw new Error('expectTenantIsolation: no checks given');

  const failures: string[] = [];
  const asOwner = await options.actAs(workspaces.owner);
  const asIntruder = await options.actAs(workspaces.intruder);

  for (const { request, kind } of checks) {
    const name = describeRequest(request);

    const own = await app.inject(merge(request, asOwner));
    if (own.statusCode >= 400) {
      failures.push(`${name}: the owner got ${own.statusCode}, so the check proves nothing`);
      continue;
    }

    const other = await app.inject(merge(request, asIntruder));
    if (kind === 'item' && other.statusCode !== 404) {
      failures.push(`${name}: another workspace got ${other.statusCode}, expected 404`);
    }
    if (kind === 'list' && other.statusCode >= 400) {
      failures.push(
        `${name}: another workspace got ${other.statusCode}, expected a normal response`,
      );
    }
    for (const secret of secrets) {
      if (other.body.includes(secret)) {
        failures.push(`${name}: another workspace's response contains "${secret}"`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Tenant isolation failed:\n  - ${failures.join('\n  - ')}`);
  }
}
