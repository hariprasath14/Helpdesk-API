import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Sequelize } from 'sequelize';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { captureEmails, testApp, testMigratorConnection } from './helpers.js';

/** The test app's main address (APP_PUBLIC_URL in testConfig); workspaces are its subdomains. */
export const ROOT = 'helpdesk.test';
export const host = (subdomain?: string) => (subdomain ? `${subdomain}.${ROOT}` : ROOT);

export const PASSWORD = 'correct-horse-battery-staple-91';

export type SendOptions = InjectOptions & { on?: string; cookie?: string; csrf?: string };

export type Role = 'admin' | 'supervisor' | 'agent';

/** A signed-in member of a workspace, ready to send requests as. */
export interface Member {
  email: string;
  userId: string;
  address: string;
  cookie: string;
  csrf: string;
}

export type Team = Record<Role, Member> & {
  workspace: Awaited<ReturnType<ReturnType<typeof accountsKit>['signedUpWorkspace']>>;
};

/** Request options that act as this member (workspace address, session cookie, CSRF token). */
export const as = (member: Member) => ({
  on: member.address,
  cookie: member.cookie,
  csrf: member.csrf,
});

/**
 * The standard permission test (ENGINEERING_STANDARDS.md 7): sends the request as each role and
 * expects 403 FORBIDDEN exactly for the roles not listed.
 */
export async function expectOnlyRoles(
  kit: ReturnType<typeof accountsKit>,
  team: Team,
  allowed: Role[],
  request: (member: Member) => SendOptions,
): Promise<void> {
  const wrong: string[] = [];
  for (const role of ['admin', 'supervisor', 'agent'] as const) {
    // eslint-disable-next-line security/detect-object-injection -- a fixed role name
    const response = await kit.send(request(team[role]));
    const forbidden =
      response.statusCode === 403 &&
      response.json<{ error: { code: string } }>().error.code === 'FORBIDDEN';
    if (forbidden === allowed.includes(role)) {
      wrong.push(`${role} got ${String(response.statusCode)} ${response.body.slice(0, 120)}`);
    }
  }
  expect(wrong, `allowed: ${allowed.join(', ') || 'nobody'}`).toEqual([]);
}

/** The link token in an email body. */
export function tokenFrom(text: string | undefined): string {
  const token = /token=([A-Za-z0-9_-]+)/.exec(text ?? '')?.[1];
  if (!token) throw new Error('no link in email');
  return token;
}

/**
 * Shared setup for account tests: a fresh app per test with captured emails and a switchable
 * breached-password check, a schema-owner connection for arranging data (expired links, old
 * logins), and helpers to sign up and confirm real workspaces through the API.
 */
export function accountsKit() {
  const kit = {
    app: undefined as unknown as FastifyInstance,
    emails: captureEmails(),
    migrator: undefined as unknown as Sequelize,
    /** What the breached-password check answers in the current test. */
    breached: false,

    /** Rebuilds the app with config overrides (for example LAGGING_READER), keeping captured emails. */
    restartApp: async (overrides: Record<string, string> = {}) => {
      await kit.app.close();
      kit.app = await testApp(overrides, {
        email: kit.emails.sender,
        breachCheck: () => Promise.resolve(kit.breached),
      });
    },

    /**
     * Sends a request to the test app. Each call comes from its own network address unless one is
     * given, so per-address rate limits never interfere.
     */
    send: (options: SendOptions) => {
      const { on, cookie, csrf, headers, ...rest } = options;
      return kit.app.inject({
        remoteAddress: `10.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}.1`,
        ...rest,
        headers: {
          host: on ?? ROOT,
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...headers,
        },
      });
    },

    newSignUp: (overrides: Record<string, unknown> = {}) => {
      const id = randomUUID().slice(0, 8);
      return {
        name: 'Ravi Shankar',
        email: `ravi.${id}@acme.test`,
        password: PASSWORD,
        companyName: 'Acme Support',
        workspaceAddress: `acme-${id}`,
        timezone: 'Asia/Kolkata',
        acceptTerms: true,
        ...overrides,
      };
    },

    signUp: (body: Record<string, unknown>) => {
      return kit.send({ method: 'POST', url: '/api/v1/signup', payload: body });
    },

    /** Signs up and confirms, returning the session cookie, CSRF token and workspace address. */
    signedUpWorkspace: async (overrides: Record<string, unknown> = {}) => {
      const body = kit.newSignUp(overrides);
      expect((await kit.signUp(body)).statusCode).toBe(202);
      const verified = await kit.send({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        on: host(body.workspaceAddress),
        payload: { token: tokenFrom(kit.emails.lastTo(body.email)?.text) },
      });
      expect(verified.statusCode).toBe(200);
      const cookie = verified.cookies.find((c) => c.name === 'helpdesk_session');
      if (!cookie) throw new Error('no session cookie');
      return {
        body,
        address: host(body.workspaceAddress),
        cookie: `helpdesk_session=${cookie.value}`,
        sessionCookie: cookie,
        csrf: verified.json<{ csrfToken: string }>().csrfToken,
      };
    },

    /** Runs SQL as the schema owner (not bound by row-level security). */
    query: async <T>(sql: string, replacements: Record<string, unknown> = {}) => {
      const [rows] = await kit.migrator.query(sql, { replacements });
      return rows as T[];
    },

    /** Signs in on a workspace address with the test password; returns the cookie and token. */
    signIn: async (address: string, email: string): Promise<Member> => {
      const response = await kit.send({
        method: 'POST',
        url: '/api/v1/auth/login',
        on: address,
        payload: { email, password: PASSWORD },
      });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.cookies.find((c) => c.name === 'helpdesk_session');
      const me = response.json<{ user: { id: string }; csrfToken: string }>();
      return {
        email,
        userId: me.user.id,
        address,
        cookie: `helpdesk_session=${cookie?.value ?? ''}`,
        csrf: me.csrfToken,
      };
    },

    /**
     * A workspace with its owner (an admin), a supervisor and an agent, each signed in. The
     * supervisor and agent come from their own sign-ups, so they also belong to another workspace.
     */
    teamWorkspace: async (): Promise<Team> => {
      const owner = await kit.signedUpWorkspace();
      const team = {
        admin: {
          email: owner.body.email,
          userId: '',
          address: owner.address,
          cookie: owner.cookie,
          csrf: owner.csrf,
        },
      } as Team;
      for (const role of ['supervisor', 'agent'] as const) {
        const person = await kit.signedUpWorkspace();
        await kit.query(
          `INSERT INTO memberships (id, workspace_id, user_id, role, is_owner, created_at, updated_at)
           SELECT gen_random_uuid(), w.id, u.id, :role, false, now(), now()
           FROM workspaces w, users u WHERE w.subdomain = :address AND u.email = :email`,
          { address: owner.body.workspaceAddress, email: person.body.email, role },
        );
        // eslint-disable-next-line security/detect-object-injection -- a fixed role name
        team[role] = await kit.signIn(owner.address, person.body.email);
      }
      const [row] = await kit.query<{ id: string }>('SELECT id FROM users WHERE email = :email', {
        email: owner.body.email,
      });
      team.admin.userId = row?.id ?? '';
      return { ...team, workspace: owner };
    },
  };

  beforeAll(() => {
    kit.migrator = testMigratorConnection();
  });
  afterAll(async () => {
    await kit.migrator.close();
  });
  beforeEach(async () => {
    kit.emails = captureEmails();
    kit.breached = false;
    kit.app = await testApp(
      {},
      { email: kit.emails.sender, breachCheck: () => Promise.resolve(kit.breached) },
    );
    return () => kit.app.close();
  });

  return kit;
}
