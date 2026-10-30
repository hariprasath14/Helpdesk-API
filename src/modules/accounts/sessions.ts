import { createHash, timingSafeEqual } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import { Op, type Transaction } from 'sequelize';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { hashToken, newId, newSecretToken } from '../../lib/tokens.js';
import { sendSignal } from '../live/signals.js';
import { accountModels, type SessionRecord } from './models.js';

export const SESSION_COOKIE = 'helpdesk_session';
export const CSRF_HEADER = 'x-csrf-token';
/** The "half signed in" ticket between a correct password and a correct code. */
export const CHALLENGE_COOKIE = 'helpdesk_2fa';
/** "Don't ask again on this device for 30 days". */
export const TRUSTED_DEVICE_COOKIE = 'helpdesk_trusted';
export const TRUSTED_DEVICE_DAYS = 30;

/** last_seen_at is refreshed at most this often, so reading pages does not write on every request. */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

/**
 * The sign-in cookie: HttpOnly (scripts cannot read it), Secure on HTTPS, SameSite=Lax (not sent on
 * cross-site form posts), and host-only, so each workspace address has its own sign-in. It lasts
 * until the session's absolute expiry; the idle timeout is enforced on the server.
 */
export function sessionCookieOptions(config: Config, expiresAt: Date): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

/** Removes the sign-in cookie (same attributes, so the browser matches it). */
export function clearedCookieOptions(config: Config): CookieSerializeOptions {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'lax', path: '/' };
}

/**
 * The CSRF token for a session: derived from the session secret, so nothing extra is stored, it
 * changes whenever the session does, and only someone who can read the API's answers to this
 * browser (the app itself) learns it. The cookie alone, which a forged request carries, is not
 * enough.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`csrf:${sessionToken}`).digest('base64url');
}

/** A change sent without the session's CSRF token. */
export class CsrfError extends AppError {
  constructor() {
    super(403, 'CSRF_FAILED', 'Reload the page and try again.');
  }
}

export function csrfTokenMatches(sessionToken: string, sent: string | undefined): boolean {
  if (!sent) return false;
  const expected = Buffer.from(csrfTokenFor(sessionToken));
  const actual = Buffer.from(sent);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface NewSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  deps: { config: Config; db: Database },
  owner: { userId: string; workspaceId: string },
  meta: { ip: string; userAgent: string | undefined },
  transaction: Transaction,
): Promise<NewSession> {
  const { Session } = accountModels(deps.db.writer);
  const { token, hash } = newSecretToken();
  const expiresAt = new Date(Date.now() + deps.config.SESSION_ABSOLUTE_DAYS * 24 * 60 * 60 * 1000);
  await Session.create(
    {
      id: newId(),
      tokenHash: hash,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
      expiresAt,
      // Signing in confirms the password.
      reauthenticatedAt: new Date(),
    },
    { transaction },
  );
  return { token, expiresAt };
}

/**
 * The live session for a cookie value on a given workspace, or null: not past its absolute expiry
 * and used within the idle timeout. Refreshes its last-seen time. Reads the writer, so a sign-in
 * a moment ago is seen.
 */
export async function findLiveSession(
  deps: { config: Config; db: Database },
  token: string,
  workspaceId: string,
): Promise<SessionRecord | null> {
  const { Session } = accountModels(deps.db.writer);
  const now = Date.now();
  const session = await Session.findOne({
    where: {
      tokenHash: hashToken(token),
      workspaceId,
      expiresAt: { [Op.gt]: new Date(now) },
      lastSeenAt: { [Op.gt]: new Date(now - deps.config.SESSION_IDLE_HOURS * 60 * 60 * 1000) },
    },
  });
  if (session && now - session.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await session.update({ lastSeenAt: new Date(now) });
  }
  return session;
}

/** Signs a person out everywhere (every workspace and device), optionally keeping one session. */
export async function revokeSessions(
  db: Database,
  userId: string,
  transaction: Transaction,
  keepSessionId?: string,
): Promise<number> {
  const { Session } = accountModels(db.writer);
  const removed = await Session.destroy({
    where: { userId, ...(keepSessionId ? { id: { [Op.ne]: keepSessionId } } : {}) },
    transaction,
  });
  // Their live connections close too (F26).
  await sendSignal(db.writer, { type: 'sessions-ended', userId, keepSessionId }, transaction);
  return removed;
}

/** Deletes the session behind a cookie value, if any (sign-out, or rotating on login). */
export async function deleteSessionByToken(
  db: Database,
  token: string,
  transaction?: Transaction,
): Promise<void> {
  const { Session } = accountModels(db.writer);
  const tokenHash = hashToken(token);
  await Session.destroy({ where: { tokenHash }, ...(transaction ? { transaction } : {}) });
  // Its live connections close too (F26).
  await sendSignal(db.writer, { type: 'session-ended', tokenHash }, transaction);
}

/**
 * Whether a session is still live, without counting this as activity (unlike findLiveSession): a
 * live connection checks it now and then, and an open tab alone must not keep a session alive.
 */
export async function sessionStillLive(
  deps: { config: Config; db: Database },
  token: string,
  workspaceId: string,
): Promise<boolean> {
  const now = Date.now();
  const found = await accountModels(deps.db.writer).Session.count({
    where: {
      tokenHash: hashToken(token),
      workspaceId,
      expiresAt: { [Op.gt]: new Date(now) },
      lastSeenAt: { [Op.gt]: new Date(now - deps.config.SESSION_IDLE_HOURS * 60 * 60 * 1000) },
    },
  });
  return found > 0;
}

/** The challenge cookie: only sent to the auth endpoints, only from this site, gone in minutes. */
export function challengeCookieOptions(config: Config, expiresAt: Date): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  };
}

export function clearedChallengeCookieOptions(config: Config): CookieSerializeOptions {
  return { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: 'strict', path: '/api/v1/auth' };
}

export function trustedDeviceCookieOptions(
  config: Config,
  expiresAt: Date,
): CookieSerializeOptions {
  return { ...sessionCookieOptions(config, expiresAt), sameSite: 'strict' };
}

/** Is this browser trusted to skip the code for this person? */
export async function isTrustedDevice(
  db: Database,
  userId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const { TrustedDevice } = accountModels(db.writer);
  const device = await TrustedDevice.findOne({
    where: { tokenHash: hashToken(token), userId, expiresAt: { [Op.gt]: new Date() } },
  });
  return device !== null;
}

export async function trustDevice(
  db: Database,
  owner: { userId: string; userAgent: string | undefined },
  transaction: Transaction,
): Promise<{ token: string; expiresAt: Date }> {
  const { TrustedDevice } = accountModels(db.writer);
  const { token, hash } = newSecretToken();
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000);
  await TrustedDevice.create(
    {
      id: newId(),
      tokenHash: hash,
      userId: owner.userId,
      userAgent: owner.userAgent?.slice(0, 500) ?? null,
      expiresAt,
    },
    { transaction },
  );
  return { token, expiresAt };
}

/**
 * Forgets every trusted device of a person: on password change or reset, when two-step
 * verification is turned off or set up again, and on "sign out of all other devices".
 */
export async function revokeTrustedDevices(
  db: Database,
  userId: string,
  transaction: Transaction,
): Promise<void> {
  const { TrustedDevice } = accountModels(db.writer);
  await TrustedDevice.destroy({ where: { userId }, transaction });
}
