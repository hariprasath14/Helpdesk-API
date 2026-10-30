import { Op } from 'sequelize';
import { withWorkspace } from '../../db/tenant.js';
import { AppError, ConflictError, ValidationError } from '../../lib/errors.js';
import { hashToken } from '../../lib/tokens.js';
import {
  memberActor,
  personWorkspaces,
  recordAudit,
  recordForPerson,
} from '../audit/audit.service.js';
import {
  acceptAuthenticatorCode,
  CHALLENGE_MAX_FAILURES,
  lockedAuthenticator,
  newAuthenticatorSecret,
  replaceRecoveryCodes,
  useRecoveryCode,
} from './authenticator.js';
import {
  forgotPasswordUrl,
  LoginLockedError,
  lockedUntil,
  memberWorkspaces,
  membershipIn,
  recordFailure,
  recordLockout,
  startSession,
  type SessionResult,
} from './auth.service.js';
import {
  newRecoveryCodesEmail,
  recoveryCodeUsedEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
} from './emails.js';
import { accountModels, type WorkspaceRecord } from './models.js';
import { verifyPassword } from './passwords.js';
import { requirePermission } from './permissions.js';
import type { SignedIn } from './request-context.js';
import { revokeSessions, revokeTrustedDevices, trustDevice } from './sessions.js';
import { deliver, type AccountDeps, type RequestMeta } from './signup.service.js';

const wrongPassword = () =>
  new ValidationError('Your password is incorrect.', {
    fields: [{ field: 'password', message: 'Your password is incorrect.' }],
  });

const wrongCode = () =>
  new ValidationError("That code didn't work.", {
    fields: [
      {
        field: 'code',
        message:
          "That code didn't work. Use the newest code, and check your phone sets its time automatically.",
      },
    ],
  });

/** Re-authentication for security changes: someone at an unlocked computer cannot make them. */
async function confirmPassword(deps: AccountDeps, signedIn: SignedIn, password: string) {
  const { User } = accountModels(deps.db.writer);
  const user = await User.findByPk(signedIn.user.id);
  if (!user || !(await verifyPassword(user.passwordHash, password))) throw wrongPassword();
  return user;
}

const forgotUrl = (deps: AccountDeps, signedIn: SignedIn) =>
  forgotPasswordUrl(deps, signedIn.workspace.subdomain);

// --- Your account --------------------------------------------------------------------------------

/**
 * Step 1 of setup, after the password: a new secret (replacing any unfinished setup) and the QR
 * code for the authenticator app. Nothing changes for sign-in until a code confirms it.
 */
export async function startTwoFactorSetup(deps: AccountDeps, signedIn: SignedIn, password: string) {
  if (signedIn.twoFactor.enabled) throw new ConflictError('Two-step verification is already on.');
  await confirmPassword(deps, signedIn, password);
  return deps.db.writer.transaction((transaction) =>
    newAuthenticatorSecret(deps, signedIn.user, transaction),
  );
}

/**
 * Step 2: the first code from the app turns two-step verification on. Returns the recovery codes
 * (shown once), signs the person out on other devices, and emails a notice.
 */
export async function confirmTwoFactorSetup(
  deps: AccountDeps,
  signedIn: SignedIn,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const workspaces = await personWorkspaces(deps.db, signedIn.user.id);
  const recoveryCodes = await deps.db.writer.transaction(async (transaction) => {
    const row = await lockedAuthenticator(deps, signedIn.user.id, transaction);
    if (!row || row.enabledAt) {
      throw new ConflictError('Start setting up two-step verification again.');
    }
    if (!(await acceptAuthenticatorCode(deps, row, code, transaction))) throw wrongCode();
    await row.update({ enabledAt: new Date() }, { transaction });
    const codes = await replaceRecoveryCodes(deps, signedIn.user.id, transaction);
    await revokeSessions(deps.db, signedIn.user.id, transaction, signedIn.session.id);
    await revokeTrustedDevices(deps.db, signedIn.user.id, transaction);
    await recordForPerson(
      deps.db,
      signedIn.user,
      workspaces,
      { action: 'two_factor.enabled', meta: signedIn.meta },
      transaction,
    );
    return codes;
  });
  deps.log.info({ userId: signedIn.user.id }, 'two-step verification turned on');
  await deliver(
    deps,
    twoFactorEnabledEmail({
      to: signedIn.user.email,
      name: signedIn.user.name,
      forgotUrl: forgotUrl(deps, signedIn),
    }),
  );
  return { recoveryCodes };
}

/** New recovery codes (password required); the old ones stop working. */
export async function regenerateRecoveryCodes(
  deps: AccountDeps,
  signedIn: SignedIn,
  password: string,
): Promise<{ recoveryCodes: string[] }> {
  if (!signedIn.twoFactor.enabled) throw new ConflictError('Two-step verification is off.');
  await confirmPassword(deps, signedIn, password);
  const workspaces = await personWorkspaces(deps.db, signedIn.user.id);
  const recoveryCodes = await deps.db.writer.transaction(async (transaction) => {
    const codes = await replaceRecoveryCodes(deps, signedIn.user.id, transaction);
    await recordForPerson(
      deps.db,
      signedIn.user,
      workspaces,
      { action: 'two_factor.recovery_codes_regenerated', meta: signedIn.meta },
      transaction,
    );
    return codes;
  });
  await deliver(
    deps,
    newRecoveryCodesEmail({
      to: signedIn.user.email,
      name: signedIn.user.name,
      forgotUrl: forgotUrl(deps, signedIn),
    }),
  );
  return { recoveryCodes };
}

/**
 * Turns two-step verification off, with the password and a current code (or a recovery code).
 * Not allowed while any workspace the person belongs to requires it.
 */
export async function disableTwoFactor(
  deps: AccountDeps,
  signedIn: SignedIn,
  input: { password: string; code: string },
): Promise<void> {
  if (!signedIn.twoFactor.enabled) throw new ConflictError('Two-step verification is off.');
  const requiring = (await memberWorkspaces(deps, signedIn.user.id)).filter(
    (workspace) => workspace.requireTwoFactor,
  );
  if (requiring.length > 0) {
    throw new AppError(
      409,
      'TWO_FACTOR_REQUIRED',
      'A workspace you belong to requires two-step verification.',
      { workspaces: requiring.map((workspace) => workspace.name) },
    );
  }
  await confirmPassword(deps, signedIn, input.password);
  const workspaces = await personWorkspaces(deps.db, signedIn.user.id);

  const { UserTwoFactor, RecoveryCode } = accountModels(deps.db.writer);
  await deps.db.writer.transaction(async (transaction) => {
    const row = await lockedAuthenticator(deps, signedIn.user.id, transaction);
    const accepted =
      row !== null &&
      ((await acceptAuthenticatorCode(deps, row, input.code, transaction)) ||
        (await useRecoveryCode(deps, signedIn.user.id, input.code, transaction)) !== null);
    if (!accepted) throw wrongCode();
    await RecoveryCode.destroy({ where: { userId: signedIn.user.id }, transaction });
    await UserTwoFactor.destroy({ where: { userId: signedIn.user.id }, transaction });
    await revokeTrustedDevices(deps.db, signedIn.user.id, transaction);
    await recordForPerson(
      deps.db,
      signedIn.user,
      workspaces,
      { action: 'two_factor.disabled', meta: signedIn.meta },
      transaction,
    );
  });
  deps.log.info({ userId: signedIn.user.id }, 'two-step verification turned off');
  await deliver(
    deps,
    twoFactorDisabledEmail({
      to: signedIn.user.email,
      name: signedIn.user.name,
      forgotUrl: forgotUrl(deps, signedIn),
    }),
  );
}

// --- Login, step 2 -------------------------------------------------------------------------------

const challengeExpired = () =>
  new AppError(401, 'TWO_FACTOR_EXPIRED', 'Your sign-in timed out. Enter your password again.');

const invalidCode = () =>
  new AppError(401, 'INVALID_CODE', "That code didn't work. Try the newest code from your app.");

export interface TwoFactorLoginResult {
  result: SessionResult;
  trustedDevice: { token: string; expiresAt: Date } | null;
}

/**
 * The second step of login: a code from the app or a recovery code, for the challenge the password
 * step created. Wrong codes count toward the same lock as wrong passwords; after
 * CHALLENGE_MAX_FAILURES on one challenge the person starts again with their password.
 */
export async function completeTwoFactorLogin(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  input: { code: string; trustDevice: boolean },
  meta: RequestMeta,
  cookies: { challenge: string | undefined; session: string | undefined },
): Promise<TwoFactorLoginResult> {
  if (!cookies.challenge) throw challengeExpired();
  const { LoginChallenge, User } = accountModels(deps.db.writer);
  const challenge = await LoginChallenge.findOne({
    where: {
      tokenHash: hashToken(cookies.challenge),
      workspaceId: workspace.id,
      expiresAt: { [Op.gt]: new Date() },
    },
  });
  if (!challenge) throw challengeExpired();
  const user = await User.findByPk(challenge.userId);
  if (!user) {
    await challenge.destroy();
    throw challengeExpired();
  }
  const locked = await lockedUntil(deps, user.email);
  if (locked) {
    await challenge.destroy();
    throw new LoginLockedError(locked);
  }

  const code = input.code.trim();
  const accepted = await deps.db.writer.transaction(async (transaction) => {
    const row = await lockedAuthenticator(deps, user.id, transaction);
    if (!row?.enabledAt) return null;
    if (await acceptAuthenticatorCode(deps, row, code, transaction)) {
      return { recoveryCodesLeft: null };
    }
    const left = await useRecoveryCode(deps, user.id, code, transaction);
    return left === null ? null : { recoveryCodesLeft: left };
  });

  if (!accepted) {
    await recordFailure(deps, user.email, meta.ip);
    const nowLocked = await lockedUntil(deps, user.email);
    if (nowLocked) {
      await challenge.destroy();
      await recordLockout(deps, workspace.id, user, meta);
      throw new LoginLockedError(nowLocked);
    }
    if (challenge.failedAttempts + 1 >= CHALLENGE_MAX_FAILURES) {
      await challenge.destroy();
      throw challengeExpired();
    }
    await challenge.update({ failedAttempts: challenge.failedAttempts + 1 });
    throw invalidCode();
  }

  await challenge.destroy();
  const membership = await membershipIn(deps, workspace.id, user.id);
  if (!membership) throw challengeExpired();
  const result = await startSession(
    deps,
    workspace,
    user,
    membership,
    meta,
    cookies.session,
    accepted.recoveryCodesLeft === null ? 'two_factor' : 'recovery_code',
  );
  const trustedDevice = input.trustDevice
    ? await deps.db.writer.transaction((transaction) =>
        trustDevice(deps.db, { userId: user.id, userAgent: meta.userAgent }, transaction),
      )
    : null;
  if (accepted.recoveryCodesLeft !== null) {
    await deliver(
      deps,
      recoveryCodeUsedEmail({
        to: user.email,
        name: user.name,
        remaining: accepted.recoveryCodesLeft,
        forgotUrl: forgotPasswordUrl(deps, workspace.subdomain),
      }),
    );
  }
  return { result, trustedDevice };
}

// --- Workspace security (admins) -----------------------------------------------------------------

export interface WorkspaceSecurity {
  requireTwoFactor: boolean;
  members: number;
  membersWithTwoFactor: number;
}

/** The workspace's two-step verification rule and how many members have it on. */
export async function workspaceSecurity(
  deps: AccountDeps,
  signedIn: SignedIn,
): Promise<WorkspaceSecurity> {
  requirePermission(signedIn, 'settings.manage');
  const { Membership, UserTwoFactor, Workspace } = accountModels(deps.db.writer);
  const memberIds = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    Membership.findAll({ attributes: ['userId'], transaction }),
  );
  const ids = memberIds.map((row) => row.userId);
  const [workspace, membersWithTwoFactor] = await Promise.all([
    Workspace.findByPk(signedIn.workspace.id, { attributes: ['requireTwoFactor'] }),
    UserTwoFactor.count({ where: { userId: ids, enabledAt: { [Op.ne]: null } } }),
  ]);
  return {
    requireTwoFactor: workspace?.requireTwoFactor ?? false,
    members: ids.length,
    membersWithTwoFactor,
  };
}

/**
 * Turns "require two-step verification for everyone" on or off. The admin must have it on
 * themselves first, so they cannot lock themselves out.
 */
export async function updateWorkspaceSecurity(
  deps: AccountDeps,
  signedIn: SignedIn,
  input: { requireTwoFactor: boolean },
): Promise<WorkspaceSecurity> {
  requirePermission(signedIn, 'settings.manage');
  if (input.requireTwoFactor && !signedIn.twoFactor.enabled) {
    throw new ConflictError('Turn on two-step verification for yourself first.');
  }
  const { Workspace } = accountModels(deps.db.writer);
  await deps.db.writer.transaction(async (transaction) => {
    const workspace = await Workspace.findByPk(signedIn.workspace.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!workspace || workspace.requireTwoFactor === input.requireTwoFactor) return;
    await workspace.update({ requireTwoFactor: input.requireTwoFactor }, { transaction });
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'workspace.two_factor_requirement_changed',
        target: { type: 'workspace', id: signedIn.workspace.id, label: signedIn.workspace.name },
        details: { required: input.requireTwoFactor },
        meta: signedIn.meta,
      },
      transaction,
    );
  });
  deps.log.info(
    { workspaceId: signedIn.workspace.id, requireTwoFactor: input.requireTwoFactor },
    'workspace two-step verification rule changed',
  );
  return workspaceSecurity(deps, signedIn);
}
