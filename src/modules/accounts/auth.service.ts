import { Op, type Transaction } from 'sequelize';
import { withWorkspace } from '../../db/tenant.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { hashToken, newId, newSecretToken } from '../../lib/tokens.js';
import {
  memberActor,
  personWorkspaces,
  recordAudit,
  recordForPerson,
  SYSTEM_ACTOR,
} from '../audit/audit.service.js';
import { createLoginChallenge, twoFactorSummary, type TwoFactorSummary } from './authenticator.js';
import { passwordChangedEmail, passwordResetEmail, yourWorkspacesEmail } from './emails.js';
import { sendSignal } from '../live/signals.js';
import {
  accountModels,
  type Role,
  type Theme,
  type UserRecord,
  type WorkspaceRecord,
} from './models.js';
import { hashDecoy, hashPassword, verifyPassword } from './passwords.js';
import type { SignedIn } from './request-context.js';
import {
  createSession,
  CsrfError,
  csrfTokenMatches,
  deleteSessionByToken,
  findLiveSession,
  isTrustedDevice,
  revokeSessions,
  revokeTrustedDevices,
  type NewSession,
} from './sessions.js';
import {
  deliver,
  LinkError,
  workspaceUrl,
  type AccountDeps,
  type RequestMeta,
} from './signup.service.js';

/** Failed logins for one email within LOCKOUT_MINUTES that lock it for LOCKOUT_MINUTES. */
export const LOGIN_FAILURE_LIMIT = 5;
export const LOCKOUT_MINUTES = 15;
const RESET_LINK_MINUTES = 60;
const RESET_EMAILS_PER_HOUR = 3;
/** Earlier passwords kept besides the current one: a new password cannot be any of the last 5. */
export const PASSWORD_HISTORY_SIZE = 4;

const MINUTE = 60 * 1000;

export class LoginLockedError extends AppError {
  constructor(until: Date) {
    super(
      429,
      'LOGIN_LOCKED',
      `Too many attempts. Try again in ${String(LOCKOUT_MINUTES)} minutes, or reset your password.`,
      { retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) },
    );
  }
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** A signed-in result in the shape toMe() turns into the "who am I" answer. */
export interface SessionResult {
  user: { id: string; name: string; email: string; theme: Theme | null };
  workspace: { id: string; name: string; subdomain: string; timezone: string };
  role: Role;
  isOwner: boolean;
  twoFactor: TwoFactorSummary;
  session: NewSession;
}

export const publicWorkspace = (workspace: WorkspaceRecord) => ({
  id: workspace.id,
  name: workspace.name,
  subdomain: workspace.subdomain,
  timezone: workspace.timezone,
});
export const publicUser = (user: UserRecord) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  theme: user.theme ?? null,
});

export function membershipIn(deps: AccountDeps, workspaceId: string, userId: string) {
  const { Membership } = accountModels(deps.db.writer);
  return withWorkspace(deps.db.writer, workspaceId, (transaction) =>
    Membership.findOne({ where: { userId, status: 'active' }, transaction }),
  );
}

// --- Lockout -------------------------------------------------------------------------------------

/**
 * When an email is locked: LOGIN_FAILURE_LIMIT failures within LOCKOUT_MINUTES lock it until
 * LOCKOUT_MINUTES after the last of them. Counted by the email typed, whether or not it has an
 * account, so the lock reveals nothing. Attempts while locked are not counted, so the lock ends on
 * time.
 */
export async function lockedUntil(deps: AccountDeps, email: string): Promise<Date | null> {
  const { LoginFailure } = accountModels(deps.db.writer);
  const recent = await LoginFailure.findAll({
    attributes: ['createdAt'],
    where: { email },
    order: [['createdAt', 'DESC']],
    limit: LOGIN_FAILURE_LIMIT,
  });
  const newest = recent.at(0)?.createdAt.getTime();
  const oldest = recent.at(LOGIN_FAILURE_LIMIT - 1)?.createdAt.getTime();
  if (newest === undefined || oldest === undefined) return null;
  const window = LOCKOUT_MINUTES * MINUTE;
  if (newest - oldest > window) return null;
  const until = newest + window;
  return until > Date.now() ? new Date(until) : null;
}

export async function recordFailure(deps: AccountDeps, email: string, ip: string) {
  const { LoginFailure } = accountModels(deps.db.writer);
  // Rows only matter for LOCKOUT_MINUTES; anything older than a day is cleared as we go.
  await LoginFailure.destroy({
    where: { createdAt: { [Op.lt]: new Date(Date.now() - 24 * 60 * MINUTE) } },
  });
  await LoginFailure.create({ id: newId(), email, ip });
}

// --- Login and sign-out --------------------------------------------------------------------------

export type LoginOutcome =
  | { kind: 'signed-in'; result: SessionResult }
  | { kind: 'two-factor'; challenge: { token: string; expiresAt: Date } };

/**
 * Checks the password for a member of this workspace. Wrong password, unknown email and "not a
 * member here" all get the same answer and take the same time. With two-step verification on (and
 * this browser not trusted) the answer is a short challenge for the code; otherwise the person is
 * signed in.
 */
export async function login(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  input: { email: string; password: string },
  meta: RequestMeta,
  cookies: { session: string | undefined; trustedDevice: string | undefined },
): Promise<LoginOutcome> {
  const email = normalizeEmail(input.email);
  const locked = await lockedUntil(deps, email);
  if (locked) throw new LoginLockedError(locked);

  const { User, UserTwoFactor } = accountModels(deps.db.writer);
  const user = await User.findOne({ where: { email } });
  let membership = null;
  if (user?.emailVerifiedAt) {
    if (await verifyPassword(user.passwordHash, input.password)) {
      membership = await membershipIn(deps, workspace.id, user.id);
    }
  } else {
    await hashDecoy();
  }

  if (!user || !membership) {
    await recordFailure(deps, email, meta.ip);
    const nowLocked = await lockedUntil(deps, email);
    if (nowLocked) {
      if (user) await recordLockout(deps, workspace.id, user, meta);
      throw new LoginLockedError(nowLocked);
    }
    throw invalidCredentials();
  }

  const authenticator = await UserTwoFactor.findByPk(user.id, { attributes: ['enabledAt'] });
  if (
    authenticator?.enabledAt &&
    !(await isTrustedDevice(deps.db, user.id, cookies.trustedDevice))
  ) {
    const challenge = await createLoginChallenge(deps, {
      userId: user.id,
      workspaceId: workspace.id,
    });
    return { kind: 'two-factor', challenge };
  }
  const result = await startSession(deps, workspace, user, membership, meta, cookies.session);
  return { kind: 'signed-in', result };
}

/** How a sign-in was completed, for the audit log. */
export type SignInMethod =
  'password' | 'two_factor' | 'recovery_code' | 'invitation' | 'email_confirmation';

/**
 * Records "sign-in locked after too many attempts" when the locked email belongs to a member of
 * this workspace (an unknown email has no workspace to record it in).
 */
export async function recordLockout(
  deps: AccountDeps,
  workspaceId: string,
  user: UserRecord,
  meta: RequestMeta,
): Promise<void> {
  const membership = await membershipIn(deps, workspaceId, user.id);
  if (!membership) return;
  await deps.db.writer.transaction((transaction) =>
    recordAudit(
      deps.db,
      {
        workspaceId,
        actor: SYSTEM_ACTOR,
        action: 'sign_in.locked',
        target: { type: 'member', id: user.id, label: user.name },
        details: { email: user.email },
        meta,
      },
      transaction,
    ),
  );
}

/**
 * Signs the person in once every check has passed: clears their failed logins and creates a fresh
 * session, deleting one the browser already had (the session ID changes on login).
 */
export async function startSession(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  user: UserRecord,
  membership: { role: Role; isOwner: boolean },
  meta: RequestMeta,
  previousToken: string | undefined,
  method: SignInMethod = 'password',
): Promise<SessionResult> {
  const { LoginFailure } = accountModels(deps.db.writer);
  const session = await deps.db.writer.transaction(async (transaction) => {
    await LoginFailure.destroy({ where: { email: user.email }, transaction });
    if (previousToken) await deleteSessionByToken(deps.db, previousToken, transaction);
    const created = await createSession(
      deps,
      { userId: user.id, workspaceId: workspace.id },
      meta,
      transaction,
    );
    await recordAudit(
      deps.db,
      {
        workspaceId: workspace.id,
        actor: memberActor(user, membership.role),
        action: 'sign_in.succeeded',
        details: { method },
        meta,
      },
      transaction,
    );
    return created;
  });
  deps.log.info({ userId: user.id, workspaceId: workspace.id }, 'signed in');
  return {
    user: publicUser(user),
    workspace: publicWorkspace(workspace),
    role: membership.role,
    isOwner: membership.isOwner,
    twoFactor: await twoFactorSummary(deps, user.id, workspace),
    session,
  };
}

/**
 * Ends the session behind the cookie. A session that has already ended needs nothing; a live one
 * also needs its CSRF token, so another site cannot sign people out.
 */
export async function logout(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  token: string | undefined,
  csrfToken: string | undefined,
): Promise<void> {
  if (!token) return;
  const session = await findLiveSession(deps, token, workspace.id);
  if (!session) return;
  if (!csrfTokenMatches(token, csrfToken)) throw new CsrfError();
  await session.destroy();
  // Its live connections close too (F26).
  await sendSignal(deps.db.writer, { type: 'session-ended', tokenHash: session.tokenHash });
}

// --- Password rules ------------------------------------------------------------------------------

function passwordProblem(field: string, message: string) {
  return new ValidationError('Choose a different password.', { fields: [{ field, message }] });
}

async function assertNotBreached(deps: AccountDeps, password: string, field: string) {
  if (await deps.breachCheck(password)) {
    throw passwordProblem(
      field,
      'This password has appeared in a data breach. Choose a different one.',
    );
  }
}

/** Refuses the current password and the PASSWORD_HISTORY_SIZE before it. */
async function assertNotRecent(
  deps: AccountDeps,
  user: UserRecord,
  password: string,
  field: string,
  transaction: Transaction,
) {
  const { PasswordHistory } = accountModels(deps.db.writer);
  const history = await PasswordHistory.findAll({
    attributes: ['passwordHash'],
    where: { userId: user.id },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: PASSWORD_HISTORY_SIZE,
    transaction,
  });
  for (const hash of [user.passwordHash, ...history.map((row) => row.passwordHash)]) {
    if (await verifyPassword(hash, password)) {
      throw passwordProblem(field, 'You used this password recently. Choose a different one.');
    }
  }
}

/** Stores the new password and moves the old one into the history, keeping only the latest few. */
async function setPassword(
  deps: AccountDeps,
  user: UserRecord,
  password: string,
  transaction: Transaction,
) {
  const { PasswordHistory } = accountModels(deps.db.writer);
  await PasswordHistory.create(
    { id: newId(), userId: user.id, passwordHash: user.passwordHash },
    { transaction },
  );
  const keep = await PasswordHistory.findAll({
    attributes: ['id'],
    where: { userId: user.id },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: PASSWORD_HISTORY_SIZE,
    transaction,
  });
  await PasswordHistory.destroy({
    where: { userId: user.id, id: { [Op.notIn]: keep.map((row) => row.id) } },
    transaction,
  });
  await user.update({ passwordHash: await hashPassword(password) }, { transaction });
}

export function forgotPasswordUrl(deps: AccountDeps, subdomain: string): string {
  const url = workspaceUrl(deps.config, subdomain);
  url.pathname = '/forgot-password';
  return url.href;
}

// --- Forgot and reset password -------------------------------------------------------------------

/**
 * Emails a reset link when the email belongs to a member of this workspace. Always answers the
 * same way. At most RESET_EMAILS_PER_HOUR an hour per person; a new link replaces older ones.
 */
export async function forgotPassword(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  rawEmail: string,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const { User, PasswordReset } = accountModels(deps.db.writer);
  const user = await User.findOne({ where: { email, emailVerifiedAt: { [Op.ne]: null } } });
  if (!user || !(await membershipIn(deps, workspace.id, user.id))) return;

  const message = await deps.db.writer.transaction(async (transaction) => {
    const now = new Date();
    const lastHour = await PasswordReset.count({
      where: { userId: user.id, createdAt: { [Op.gt]: new Date(now.getTime() - 60 * MINUTE) } },
      transaction,
    });
    if (lastHour >= RESET_EMAILS_PER_HOUR) return null;
    await PasswordReset.update(
      { expiresAt: now },
      { where: { userId: user.id, usedAt: null, expiresAt: { [Op.gt]: now } }, transaction },
    );
    const { token, hash } = newSecretToken();
    await PasswordReset.create(
      {
        id: newId(),
        userId: user.id,
        workspaceId: workspace.id,
        tokenHash: hash,
        expiresAt: new Date(now.getTime() + RESET_LINK_MINUTES * MINUTE),
        usedAt: null,
      },
      { transaction },
    );
    const link = workspaceUrl(deps.config, workspace.subdomain);
    link.pathname = '/reset-password';
    link.searchParams.set('token', token);
    return passwordResetEmail({
      to: user.email,
      name: user.name,
      workspaceName: workspace.name,
      link: link.href,
    });
  });
  // Not awaited: the answer takes the same time whether or not an email goes out.
  if (message) void deliver(deps, message);
}

async function usableReset(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  token: string,
  transaction?: Transaction,
) {
  const { PasswordReset, User } = accountModels(deps.db.writer);
  const reset = await PasswordReset.findOne({
    where: { tokenHash: hashToken(token) },
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  if (reset?.workspaceId !== workspace.id) throw new LinkError('invalid');
  if (reset.usedAt) throw new LinkError('used');
  if (reset.expiresAt.getTime() <= Date.now()) throw new LinkError('expired');
  const user = await User.findByPk(reset.userId, transaction ? { transaction } : {});
  if (!user) throw new LinkError('invalid');
  return { reset, user };
}

/** Lets the reset page say "this link has expired" before the person types a new password. */
export async function checkResetLink(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  token: string,
): Promise<{ email: string }> {
  const { user } = await usableReset(deps, workspace, token);
  return { email: user.email };
}

/**
 * Sets a new password from a reset link: signs the person out everywhere, clears the login lock
 * and emails a notice. They then sign in with the new password (no automatic sign-in, so a
 * second factor added in F3 cannot be skipped).
 */
export async function resetPassword(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  token: string,
  password: string,
  meta: RequestMeta,
): Promise<void> {
  const { user: person } = await usableReset(deps, workspace, token);
  await assertNotBreached(deps, password, 'password');
  const workspaces = await personWorkspaces(deps.db, person.id);

  const { PasswordReset, LoginFailure } = accountModels(deps.db.writer);
  const user = await deps.db.writer.transaction(async (transaction) => {
    const usable = await usableReset(deps, workspace, token, transaction);
    await assertNotRecent(deps, usable.user, password, 'password', transaction);
    await setPassword(deps, usable.user, password, transaction);
    const now = new Date();
    await usable.reset.update({ usedAt: now }, { transaction });
    await PasswordReset.update(
      { expiresAt: now },
      { where: { userId: usable.user.id, usedAt: null }, transaction },
    );
    await revokeSessions(deps.db, usable.user.id, transaction);
    await revokeTrustedDevices(deps.db, usable.user.id, transaction);
    await LoginFailure.destroy({ where: { email: usable.user.email }, transaction });
    await recordForPerson(
      deps.db,
      usable.user,
      workspaces,
      { action: 'password.reset', meta },
      transaction,
    );
    return usable.user;
  });
  deps.log.info({ userId: user.id }, 'password reset');
  await deliver(
    deps,
    passwordChangedEmail({
      to: user.email,
      name: user.name,
      forgotUrl: forgotPasswordUrl(deps, workspace.subdomain),
    }),
  );
}

// --- Signed in: your account ---------------------------------------------------------------------

/**
 * Changes the password after checking the current one. Every session is signed out, and this
 * browser gets a fresh one, so the person stays signed in here only.
 */
export async function changePassword(
  deps: AccountDeps,
  signedIn: SignedIn,
  input: { currentPassword: string; newPassword: string },
  meta: RequestMeta,
): Promise<SessionResult> {
  const { User } = accountModels(deps.db.writer);
  const current = await User.findByPk(signedIn.user.id);
  if (!current || !(await verifyPassword(current.passwordHash, input.currentPassword))) {
    throw new ValidationError('Your current password is incorrect.', {
      fields: [{ field: 'currentPassword', message: 'Your current password is incorrect.' }],
    });
  }
  await assertNotBreached(deps, input.newPassword, 'newPassword');
  const workspaces = await personWorkspaces(deps.db, signedIn.user.id);

  const session = await deps.db.writer.transaction(async (transaction) => {
    const user = await User.findByPk(signedIn.user.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw new ValidationError('Your current password is incorrect.');
    await assertNotRecent(deps, user, input.newPassword, 'newPassword', transaction);
    await setPassword(deps, user, input.newPassword, transaction);
    await revokeSessions(deps.db, user.id, transaction);
    await revokeTrustedDevices(deps.db, user.id, transaction);
    await recordForPerson(
      deps.db,
      signedIn.user,
      workspaces,
      { action: 'password.changed', meta },
      transaction,
    );
    return createSession(
      deps,
      { userId: user.id, workspaceId: signedIn.workspace.id },
      meta,
      transaction,
    );
  });
  deps.log.info({ userId: signedIn.user.id }, 'password changed');
  await deliver(
    deps,
    passwordChangedEmail({
      to: signedIn.user.email,
      name: signedIn.user.name,
      forgotUrl: forgotPasswordUrl(deps, signedIn.workspace.subdomain),
    }),
  );
  return { ...signedIn, session };
}

/**
 * Signs the person out on every other device and workspace, and forgets trusted devices (each
 * will ask for a code again). This session stays.
 */
export async function signOutOtherSessions(
  deps: AccountDeps,
  signedIn: SignedIn,
): Promise<{ signedOut: number }> {
  const workspaces = await personWorkspaces(deps.db, signedIn.user.id);
  const signedOut = await deps.db.writer.transaction(async (transaction) => {
    await revokeTrustedDevices(deps.db, signedIn.user.id, transaction);
    await recordForPerson(
      deps.db,
      signedIn.user,
      workspaces,
      { action: 'sessions.signed_out_others', meta: signedIn.meta },
      transaction,
    );
    return revokeSessions(deps.db, signedIn.user.id, transaction, signedIn.session.id);
  });
  return { signedOut };
}

/** Updates the person's name (it is the same in every workspace they belong to). */
export async function updateProfile(
  deps: AccountDeps,
  signedIn: SignedIn,
  input: { name?: string | undefined; theme?: Theme | null | undefined },
): Promise<SignedIn> {
  const { User } = accountModels(deps.db.writer);
  const changes = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
  };
  await User.update(changes, { where: { id: signedIn.user.id } });
  return { ...signedIn, user: { ...signedIn.user, ...changes } };
}

/**
 * Confirms the password on this session, so sensitive admin actions are allowed for the next
 * REAUTH_MINUTES. Wrong passwords count toward the login lock, like at login.
 */
export async function reauthenticate(
  deps: AccountDeps,
  signedIn: SignedIn,
  password: string,
  meta: RequestMeta,
): Promise<void> {
  const email = signedIn.user.email;
  const locked = await lockedUntil(deps, email);
  if (locked) throw new LoginLockedError(locked);
  const { User, Session } = accountModels(deps.db.writer);
  const user = await User.findByPk(signedIn.user.id);
  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    await recordFailure(deps, email, meta.ip);
    const nowLocked = await lockedUntil(deps, email);
    if (nowLocked) {
      if (user) await recordLockout(deps, signedIn.workspace.id, user, meta);
      throw new LoginLockedError(nowLocked);
    }
    throw new ValidationError('Your password is incorrect.', {
      fields: [{ field: 'password', message: 'Your password is incorrect.' }],
    });
  }
  await Session.update({ reauthenticatedAt: new Date() }, { where: { id: signedIn.session.id } });
}

// --- Find your workspace -------------------------------------------------------------------------

/**
 * The active workspaces a person belongs to, by name. Reads memberships through the
 * own_memberships policy (app.user_id): the one place memberships are listed across workspaces.
 */
export async function memberWorkspaces(deps: AccountDeps, userId: string) {
  const { Membership, Workspace } = accountModels(deps.db.writer);
  const memberships = await deps.db.writer.transaction(async (transaction) => {
    await deps.db.writer.query("SELECT set_config('app.user_id', :id, true)", {
      replacements: { id: userId },
      transaction,
    });
    return Membership.findAll({
      attributes: ['workspaceId'],
      where: { userId, status: 'active' },
      transaction,
    });
  });
  return Workspace.findAll({
    where: { id: memberships.map((row) => row.workspaceId), status: 'active' },
    order: [['name', 'ASC']],
  });
}

/**
 * Emails links to every active workspace the person belongs to. Answers the same way whether or
 * not the email has an account.
 */
export async function findWorkspaces(deps: AccountDeps, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const { User } = accountModels(deps.db.writer);
  const user = await User.findOne({ where: { email, emailVerifiedAt: { [Op.ne]: null } } });
  if (!user) return;

  const workspaces = await memberWorkspaces(deps, user.id);
  if (workspaces.length === 0) return;

  void deliver(
    deps,
    yourWorkspacesEmail({
      to: user.email,
      name: user.name,
      workspaces: workspaces.map((workspace) => {
        const loginUrl = workspaceUrl(deps.config, workspace.subdomain);
        loginUrl.pathname = '/login';
        return { name: workspace.name, loginUrl: loginUrl.href };
      }),
    }),
  );
}
