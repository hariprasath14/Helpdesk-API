import type { FastifyRequest } from 'fastify';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { AppError, NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { twoFactorSummary, type TwoFactorSummary } from './authenticator.js';
import { accountModels, type Role, type Theme } from './models.js';
import { permissionsFor, type Permission } from './permissions.js';
import {
  CSRF_HEADER,
  CsrfError,
  csrfTokenFor,
  csrfTokenMatches,
  findLiveSession,
  SESSION_COOKIE,
} from './sessions.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Which workspace a request is for, from the address it was sent to: acme.helpdesk.example.com → "acme";
 * helpdesk.example.com itself → null (sign-up). Behind the load balancer Fastify reads X-Forwarded-Host
 * (TRUST_PROXY). Anything that is not the app's own domain is treated as unknown.
 */
export function requestSubdomain(
  config: Config,
  request: FastifyRequest,
): string | null | undefined {
  const host = request.hostname.toLowerCase();
  const base = config.APP_PUBLIC_URL.hostname.toLowerCase();
  if (host === base) return null;
  if (!host.endsWith(`.${base}`)) return undefined;
  const label = host.slice(0, -(base.length + 1));
  return label.includes('.') ? undefined : label;
}

/** Sign-up and "find your workspace" live on the main address only; elsewhere they are 404. */
export function requireMainAddress(config: Config, request: FastifyRequest): void {
  if (requestSubdomain(config, request) !== null) throw new NotFoundError();
}

/** The active workspace this request is addressed to, or 404. */
export async function requireWorkspace(config: Config, db: Database, request: FastifyRequest) {
  const subdomain = requestSubdomain(config, request);
  if (!subdomain) throw new NotFoundError('This workspace does not exist.');
  const workspace = await accountModels(db.writer).Workspace.findOne({
    where: { subdomain, status: 'active' },
  });
  if (!workspace) throw new NotFoundError('This workspace does not exist.');
  return workspace;
}

/** A cookie's value on this request, if any. */
export function readCookie(request: FastifyRequest, name: string): string | undefined {
  // Our own fixed cookie names, not user input.
  // eslint-disable-next-line security/detect-object-injection
  return request.cookies[name];
}

/** The session cookie's value on this request, if any. */
export const sessionToken = (request: FastifyRequest) => readCookie(request, SESSION_COOKIE);

/** The X-CSRF-Token header on this request, if sent once. */
export function sentCsrfToken(request: FastifyRequest): string | undefined {
  // A fixed header name, not user input.
  // eslint-disable-next-line security/detect-object-injection
  const sent = request.headers[CSRF_HEADER];
  return typeof sent === 'string' ? sent : undefined;
}

export interface SignedIn {
  user: { id: string; name: string; email: string; theme: Theme | null };
  workspace: { id: string; name: string; subdomain: string; timezone: string };
  role: Role;
  isOwner: boolean;
  twoFactor: TwoFactorSummary;
  permissions: Permission[];
  session: { id: string; token: string; reauthenticatedAt: Date | null };
  /** Where the request came from, for the audit log. */
  meta: { ip: string; userAgent: string | undefined };
}

/** A workspace that requires two-step verification, and this person has not set it up. */
export class TwoFactorSetupRequiredError extends AppError {
  constructor() {
    super(
      403,
      'TWO_FACTOR_SETUP_REQUIRED',
      'This workspace requires two-step verification. Set it up to continue.',
    );
  }
}

/**
 * The signed-in member for this request: a live session cookie for this workspace's address, and
 * a membership in it. Otherwise 401. Requests that change data must also carry the session's CSRF
 * token in the X-CSRF-Token header (403 otherwise). When the workspace requires two-step
 * verification and the person has not set it up, only routes that pass `duringTwoFactorSetup`
 * (who am I, the setup itself) are allowed (403 TWO_FACTOR_SETUP_REQUIRED). Reads from the writer,
 * so a sign-in a moment ago is seen.
 */
export async function requireSignedIn(
  config: Config,
  db: Database,
  request: FastifyRequest,
  { duringTwoFactorSetup = false }: { duringTwoFactorSetup?: boolean } = {},
): Promise<SignedIn> {
  const workspace = await requireWorkspace(config, db, request);
  const token = sessionToken(request);
  if (!token) throw new UnauthorizedError();
  const session = await findLiveSession({ config, db }, token, workspace.id);
  if (!session) throw new UnauthorizedError();
  if (STATE_CHANGING.has(request.method)) {
    if (!csrfTokenMatches(token, sentCsrfToken(request))) {
      throw new CsrfError();
    }
  }

  const { User, Membership } = accountModels(db.writer);
  const user = await User.findByPk(session.userId);
  const membership = await db.writer.transaction(async (transaction) => {
    await db.writer.query("SELECT set_config('app.workspace_id', :id, true)", {
      replacements: { id: workspace.id },
      transaction,
    });
    return Membership.findOne({ where: { userId: session.userId, status: 'active' }, transaction });
  });
  if (!user || !membership) throw new UnauthorizedError();
  const twoFactor = await twoFactorSummary({ config, db }, user.id, workspace);
  if (twoFactor.setupRequired && !duringTwoFactorSetup) throw new TwoFactorSetupRequiredError();

  return {
    user: { id: user.id, name: user.name, email: user.email, theme: user.theme ?? null },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      subdomain: workspace.subdomain,
      timezone: workspace.timezone,
    },
    role: membership.role,
    isOwner: membership.isOwner,
    twoFactor,
    permissions: permissionsFor(membership.role),
    session: { id: session.id, token, reauthenticatedAt: session.reauthenticatedAt },
    meta: { ip: request.ip, userAgent: request.headers['user-agent'] },
  };
}

/** The "who am I" answer, with the CSRF token the app sends back on changes. */
export function toMe(
  signedIn: Omit<SignedIn, 'session' | 'permissions' | 'meta'> & { session: { token: string } },
) {
  return {
    user: signedIn.user,
    workspace: signedIn.workspace,
    role: signedIn.role,
    isOwner: signedIn.isOwner,
    permissions: permissionsFor(signedIn.role),
    twoFactor: signedIn.twoFactor,
    csrfToken: csrfTokenFor(signedIn.session.token),
  };
}
