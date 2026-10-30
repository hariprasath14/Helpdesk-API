import { type Transaction } from 'sequelize';
import { withWorkspace } from '../../db/tenant.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { hashToken, newId, newSecretToken } from '../../lib/tokens.js';
import { memberActor, recordAudit, type AuditRecord } from '../audit/audit.service.js';
import { checkTeamIds, joinInvitationTeams, saveInvitationTeams } from '../teams/teams.service.js';
import { acceptAuthenticatorCode, lockedAuthenticator, useRecoveryCode } from './authenticator.js';
import {
  LoginLockedError,
  lockedUntil,
  normalizeEmail,
  recordFailure,
  startSession,
  type SessionResult,
} from './auth.service.js';
import { invitationEmail } from './emails.js';
import { accountModels, type Role, type WorkspaceRecord } from './models.js';
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from './passwords.js';
import { requirePermission, requireRecentPassword } from './permissions.js';
import type { SignedIn } from './request-context.js';
import {
  deliver,
  LinkError,
  workspaceUrl,
  type AccountDeps,
  type RequestMeta,
} from './signup.service.js';

/** How long an invitation link works. */
export const INVITATION_DAYS = 7;
export const MAX_INVITES_AT_ONCE = 20;

function invitationLink(deps: AccountDeps, subdomain: string, token: string): string {
  const link = workspaceUrl(deps.config, subdomain);
  link.pathname = '/invite';
  link.searchParams.set('token', token);
  return link.href;
}

const expiry = () => new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000);

/** An audit entry by the signed-in admin about an invitation. */
function recordAboutInvitation(
  deps: AccountDeps,
  signedIn: SignedIn,
  invitation: { id: string; email: string; role: Role },
  action: AuditRecord['action'],
  transaction: Transaction,
) {
  return recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action,
      target: { type: 'invitation', id: invitation.id, label: invitation.email },
      details: { role: invitation.role, email: invitation.email },
      meta: signedIn.meta,
    },
    transaction,
  );
}

export interface InviteResult {
  invited: string[];
  skipped: { email: string; reason: string }[];
}

/**
 * Invites people by email with a role, and optionally into teams they join on accepting. Inviting
 * someone again replaces their open invitation. Members are skipped with a reason. Inviting as an
 * admin needs the password confirmed recently.
 */
export async function inviteMembers(
  deps: AccountDeps,
  signedIn: SignedIn,
  input: { emails: string[]; role: Role; teamIds?: string[] | undefined },
): Promise<InviteResult> {
  requirePermission(signedIn, 'members.manage');
  if (input.role === 'admin') requireRecentPassword(signedIn);
  const emails = [...new Set(input.emails.map(normalizeEmail))];
  const { User, Membership, Invitation } = accountModels(deps.db.writer);
  const result: InviteResult = { invited: [], skipped: [] };
  const messages: ReturnType<typeof invitationEmail>[] = [];

  const teamIds = [...new Set(input.teamIds ?? [])];

  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const teamProblems = await checkTeamIds(deps.db, teamIds, transaction);
    if (teamProblems.length > 0) {
      throw new ValidationError('Check the highlighted fields.', { fields: teamProblems });
    }
    const people = await User.findAll({ attributes: ['id', 'email'], where: { email: emails } });
    const memberships = await Membership.findAll({
      where: { userId: people.map((person) => person.id) },
      transaction,
    });
    for (const email of emails) {
      const person = people.find((row) => row.email === email);
      const membership = person && memberships.find((row) => row.userId === person.id);
      if (membership?.status === 'active') {
        result.skipped.push({ email, reason: 'Already a member.' });
        continue;
      }
      if (membership?.status === 'deactivated') {
        result.skipped.push({ email, reason: 'Deactivated. Reactivate them instead.' });
        continue;
      }
      await Invitation.update(
        { revokedAt: new Date() },
        { where: { email, acceptedAt: null, revokedAt: null }, transaction },
      );
      const { token, hash } = newSecretToken();
      const invitation = await Invitation.create(
        {
          id: newId(),
          workspaceId: signedIn.workspace.id,
          email,
          role: input.role,
          tokenHash: hash,
          invitedBy: signedIn.user.id,
          expiresAt: expiry(),
        },
        { transaction },
      );
      await saveInvitationTeams(
        deps.db,
        signedIn.workspace.id,
        invitation.id,
        teamIds,
        transaction,
      );
      await recordAboutInvitation(deps, signedIn, invitation, 'member.invited', transaction);
      messages.push(
        invitationEmail({
          to: email,
          inviterName: signedIn.user.name,
          workspaceName: signedIn.workspace.name,
          role: input.role,
          link: invitationLink(deps, signedIn.workspace.subdomain, token),
        }),
      );
      result.invited.push(email);
    }
  });
  for (const message of messages) await deliver(deps, message);
  deps.log.info(
    { workspaceId: signedIn.workspace.id, invited: result.invited.length, role: input.role },
    'members invited',
  );
  return result;
}

async function openInvitation(deps: AccountDeps, id: string, transaction: Transaction) {
  const { Invitation } = accountModels(deps.db.writer);
  const invitation = await Invitation.findOne({
    where: { id, acceptedAt: null, revokedAt: null },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!invitation) throw new NotFoundError('This invitation is no longer open.');
  return invitation;
}

/** Sends a fresh link (another 7 days); the old link stops working. */
export async function resendInvitation(
  deps: AccountDeps,
  signedIn: SignedIn,
  invitationId: string,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  const message = await withWorkspace(
    deps.db.writer,
    signedIn.workspace.id,
    async (transaction) => {
      const invitation = await openInvitation(deps, invitationId, transaction);
      const { token, hash } = newSecretToken();
      await invitation.update({ tokenHash: hash, expiresAt: expiry() }, { transaction });
      await recordAboutInvitation(deps, signedIn, invitation, 'invitation.resent', transaction);
      return invitationEmail({
        to: invitation.email,
        inviterName: signedIn.user.name,
        workspaceName: signedIn.workspace.name,
        role: invitation.role,
        link: invitationLink(deps, signedIn.workspace.subdomain, token),
      });
    },
  );
  await deliver(deps, message);
}

export async function revokeInvitation(
  deps: AccountDeps,
  signedIn: SignedIn,
  invitationId: string,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const invitation = await openInvitation(deps, invitationId, transaction);
    await invitation.update({ revokedAt: new Date() }, { transaction });
    await recordAboutInvitation(deps, signedIn, invitation, 'invitation.revoked', transaction);
  });
}

// --- Accepting (the invited person, signed out) ---------------------------------------------------

/** The invitation behind a link, in the workspace of the transaction (row-level security). */
async function usableInvitation(deps: AccountDeps, token: string, transaction: Transaction) {
  const { Invitation } = accountModels(deps.db.writer);
  const invitation = await Invitation.findOne({
    where: { tokenHash: hashToken(token) },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!invitation || invitation.revokedAt) throw new LinkError('invalid');
  if (invitation.acceptedAt) throw new LinkError('used');
  if (invitation.expiresAt.getTime() <= Date.now()) throw new LinkError('expired');
  return invitation;
}

export interface InvitationStatus {
  email: string;
  workspaceName: string;
  role: Role;
  invitedByName: string | null;
  /** The email already signs in to Helpdesk: accept with that password instead of a new one. */
  existingAccount: boolean;
  /** That account uses two-step verification: accepting also needs a code. */
  twoFactorRequired: boolean;
}

/** What the accept page needs to show, or why the link cannot be used. */
export async function checkInvitation(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  token: string,
): Promise<InvitationStatus> {
  const invitation = await withWorkspace(deps.db.writer, workspace.id, (transaction) =>
    usableInvitation(deps, token, transaction),
  );
  const { User, UserTwoFactor } = accountModels(deps.db.writer);
  const [person, inviter] = await Promise.all([
    User.findOne({ where: { email: invitation.email } }),
    invitation.invitedBy ? User.findByPk(invitation.invitedBy) : null,
  ]);
  const existingAccount = Boolean(person?.emailVerifiedAt);
  const setup =
    existingAccount && person
      ? await UserTwoFactor.findByPk(person.id, { attributes: ['enabledAt'] })
      : null;
  return {
    email: invitation.email,
    workspaceName: workspace.name,
    role: invitation.role,
    invitedByName: inviter?.name ?? null,
    existingAccount,
    twoFactorRequired: Boolean(setup?.enabledAt),
  };
}

const fieldProblem = (field: string, message: string, extra: Record<string, unknown> = {}) =>
  new ValidationError(message, { fields: [{ field, message }], ...extra });

/**
 * Joins the workspace from an invitation and signs the person in. Someone new chooses a name and
 * password (clicking the emailed link confirms the email). Someone who already has a Helpdesk
 * account proves it with their password, and their code when they use two-step verification;
 * wrong passwords and codes count toward the login lock.
 */
export async function acceptInvitation(
  deps: AccountDeps,
  workspace: WorkspaceRecord,
  input: { token: string; name?: string | undefined; password: string; code?: string | undefined },
  meta: RequestMeta,
  previousSession: string | undefined,
): Promise<SessionResult> {
  const status = await checkInvitation(deps, workspace, input.token);
  const { User, Membership, Invitation } = accountModels(deps.db.writer);
  const email = status.email;
  const existing = await User.findOne({ where: { email } });

  if (status.existingAccount && existing) {
    const locked = await lockedUntil(deps, email);
    if (locked) throw new LoginLockedError(locked);
    const failed = async (error: ValidationError) => {
      await recordFailure(deps, email, meta.ip);
      const nowLocked = await lockedUntil(deps, email);
      if (nowLocked) throw new LoginLockedError(nowLocked);
      throw error;
    };
    if (!(await verifyPassword(existing.passwordHash, input.password))) {
      await failed(fieldProblem('password', 'Your password is incorrect.'));
    }
    if (status.twoFactorRequired) {
      const code = input.code?.trim();
      if (!code) {
        throw fieldProblem('code', 'Enter the code from your authenticator app.', {
          codeRequired: true,
        });
      }
      const accepted = await deps.db.writer.transaction(async (transaction) => {
        const row = await lockedAuthenticator(deps, existing.id, transaction);
        if (!row?.enabledAt) return false;
        return (
          (await acceptAuthenticatorCode(deps, row, code, transaction)) ||
          (await useRecoveryCode(deps, existing.id, code, transaction)) !== null
        );
      });
      if (!accepted) await failed(fieldProblem('code', "That code didn't work."));
    }
  } else {
    if (!input.name || input.name.trim().length < 2) {
      throw fieldProblem('name', 'Enter your full name.');
    }
    if (input.password.length < PASSWORD_MIN_LENGTH) {
      throw fieldProblem('password', `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`);
    }
    if (await deps.breachCheck(input.password)) {
      throw fieldProblem(
        'password',
        'This password has appeared in a data breach. Choose a different one.',
      );
    }
  }

  const { user, membership } = await withWorkspace(
    deps.db.writer,
    workspace.id,
    async (transaction) => {
      const invitation = await usableInvitation(deps, input.token, transaction);
      let person = await User.findOne({ where: { email }, transaction });
      if (!person) {
        person = await User.create(
          {
            id: newId(),
            email,
            name: (input.name ?? '').trim(),
            passwordHash: await hashPassword(input.password),
            emailVerifiedAt: new Date(),
          },
          { transaction },
        );
      } else if (!person.emailVerifiedAt) {
        // An unfinished sign-up with this email: the emailed link proves the address.
        await person.update(
          {
            name: (input.name ?? '').trim(),
            passwordHash: await hashPassword(input.password),
            emailVerifiedAt: new Date(),
          },
          { transaction },
        );
      }
      let joined = await Membership.findOne({ where: { userId: person.id }, transaction });
      if (joined?.status === 'deactivated') throw new LinkError('invalid');
      joined ??= await Membership.create(
        {
          id: newId(),
          workspaceId: workspace.id,
          userId: person.id,
          role: invitation.role,
          isOwner: false,
          invitedBy: invitation.invitedBy,
        },
        { transaction },
      );
      const teams = await joinInvitationTeams(
        deps.db,
        workspace.id,
        invitation.id,
        person.id,
        transaction,
      );
      await invitation.update({ acceptedAt: new Date() }, { transaction });
      await Invitation.update(
        { revokedAt: new Date() },
        { where: { email, acceptedAt: null, revokedAt: null }, transaction },
      );
      await recordAudit(
        deps.db,
        {
          workspaceId: workspace.id,
          actor: memberActor(person, joined.role),
          action: 'member.joined',
          details: {
            role: joined.role,
            email: person.email,
            ...(teams.length > 0 ? { teams } : {}),
          },
          meta,
        },
        transaction,
      );
      return { user: person, membership: joined };
    },
  );
  deps.log.info({ workspaceId: workspace.id, userId: user.id }, 'invitation accepted');
  return startSession(deps, workspace, user, membership, meta, previousSession, 'invitation');
}
