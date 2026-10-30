import { col, fn, Op } from 'sequelize';
import { withWorkspace } from '../../db/tenant.js';
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { memberActor, recordAudit, type AuditRecord } from '../audit/audit.service.js';
import { sendSignal } from '../live/signals.js';
import { teamsByInvitation, teamsByMember, type TeamRef } from '../teams/teams.service.js';
import { unassignOpenTickets } from '../tickets/tickets.service.js';
import { forgotPasswordUrl, memberWorkspaces } from './auth.service.js';
import { twoFactorResetByAdminEmail } from './emails.js';
import { accountModels, type MembershipStatus, type Role } from './models.js';
import { requirePermission, requireRecentPassword } from './permissions.js';
import type { SignedIn } from './request-context.js';
import { revokeSessions, revokeTrustedDevices } from './sessions.js';
import { deliver, type AccountDeps } from './signup.service.js';
import { PRODUCT_NAME } from '../../product.js';

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  isOwner: boolean;
  status: MembershipStatus;
  twoFactorEnabled: boolean;
  lastActiveAt: Date | null;
  joinedAt: Date;
  /** A to Z. */
  teams: (TeamRef & { isLead: boolean })[];
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  invitedByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  expired: boolean;
  /** The teams they join when they accept. */
  teams: TeamRef[];
}

/**
 * The workspace's members (active and deactivated) and open invitations, for the members page.
 * Reads the writer: the page reloads this list right after each change and must see it. The list
 * is bounded by the workspace's seats, so it is not paginated; the page searches and filters it.
 */
export async function listMembers(
  deps: AccountDeps,
  signedIn: SignedIn,
): Promise<{ members: MemberView[]; invitations: InvitationView[] }> {
  requirePermission(signedIn, 'members.view');
  const { Membership, Invitation, User, UserTwoFactor, Session } = accountModels(deps.db.writer);
  const workspaceId = signedIn.workspace.id;
  const [memberships, invitations, memberTeams, invitationTeams] = await withWorkspace(
    deps.db.writer,
    workspaceId,
    async (transaction) => {
      const open = await Invitation.findAll({
        where: { acceptedAt: null, revokedAt: null },
        order: [['createdAt', 'DESC']],
        transaction,
      });
      return [
        await Membership.findAll({ transaction }),
        open,
        await teamsByMember(deps.db, transaction),
        await teamsByInvitation(
          deps.db,
          open.map((row) => row.id),
          transaction,
        ),
      ] as const;
    },
  );

  const memberIds = memberships.map((row) => row.userId);
  const peopleIds = [
    ...new Set([
      ...memberIds,
      ...invitations.flatMap((row) => (row.invitedBy ? [row.invitedBy] : [])),
    ]),
  ];
  const [people, withTwoFactor, lastSeen] = await Promise.all([
    User.findAll({ attributes: ['id', 'name', 'email'], where: { id: peopleIds } }),
    UserTwoFactor.findAll({
      attributes: ['userId'],
      where: { userId: memberIds, enabledAt: { [Op.ne]: null } },
    }),
    Session.findAll({
      attributes: ['userId', [fn('max', col('last_seen_at')), 'lastSeenAt']],
      where: { workspaceId, userId: memberIds },
      group: ['userId'],
      raw: true,
    }) as unknown as Promise<{ userId: string; lastSeenAt: Date }[]>,
  ]);
  const personById = new Map(people.map((person) => [person.id, person]));
  const twoFactorOn = new Set(withTwoFactor.map((row) => row.userId));
  const lastSeenById = new Map(lastSeen.map((row) => [row.userId, row.lastSeenAt]));

  const members = memberships
    .flatMap((membership): MemberView[] => {
      const person = personById.get(membership.userId);
      if (!person) return [];
      return [
        {
          userId: membership.userId,
          name: person.name,
          email: person.email,
          role: membership.role,
          isOwner: membership.isOwner,
          status: membership.status,
          twoFactorEnabled: twoFactorOn.has(membership.userId),
          lastActiveAt: lastSeenById.get(membership.userId) ?? null,
          joinedAt: membership.createdAt,
          teams: memberTeams.get(membership.userId) ?? [],
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.status === 'deactivated') - Number(b.status === 'deactivated') ||
        a.name.localeCompare(b.name),
    );

  const now = Date.now();
  return {
    members,
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      invitedByName: invitation.invitedBy
        ? (personById.get(invitation.invitedBy)?.name ?? null)
        : null,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      expired: invitation.expiresAt.getTime() <= now,
      teams: invitationTeams.get(invitation.id) ?? [],
    })),
  };
}

const notAMember = () => new NotFoundError('This person is not a member of this workspace.');

/** An audit entry by the signed-in admin about a member (looked up for their name and email). */
async function recordAboutMember(
  deps: AccountDeps,
  signedIn: SignedIn,
  userId: string,
  entry: Pick<AuditRecord, 'action' | 'details'>,
  transaction: Parameters<typeof recordAudit>[2],
) {
  const { User } = accountModels(deps.db.writer);
  const person = await User.findByPk(userId, { attributes: ['name', 'email'], transaction });
  await recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action: entry.action,
      target: { type: 'member', id: userId, label: person?.name ?? 'a former member' },
      details: { ...entry.details, email: person?.email },
      meta: signedIn.meta,
    },
    transaction,
  );
}

/** Changes a member's role. Making someone an admin needs the password confirmed recently. */
export async function changeRole(
  deps: AccountDeps,
  signedIn: SignedIn,
  userId: string,
  role: Role,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  if (role === 'admin') requireRecentPassword(signedIn);
  const { Membership } = accountModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const membership = await Membership.findOne({
      where: { userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!membership) throw notAMember();
    if (membership.isOwner) throw new ConflictError("The workspace owner's role can't be changed.");
    if (membership.status !== 'active') throw new ConflictError('Reactivate this person first.');
    if (membership.role === 'admin' && role !== 'admin') {
      const admins = await Membership.count({
        where: { role: 'admin', status: 'active' },
        transaction,
      });
      if (admins <= 1) throw new ConflictError('A workspace needs at least one admin.');
    }
    if (membership.role === role) return;
    const from = membership.role;
    await membership.update({ role }, { transaction });
    await recordAboutMember(
      deps,
      signedIn,
      userId,
      { action: 'member.role_changed', details: { from, to: role } },
      transaction,
    );
  });
  deps.log.info({ workspaceId: signedIn.workspace.id, userId, role }, 'member role changed');
}

/**
 * Deactivates a member: they are signed out of this workspace at once and cannot sign in to it.
 * Their unresolved tickets are unassigned (each with a history entry); they stay on resolved and
 * closed ones and in their teams. Needs the password confirmed recently.
 */
export async function deactivateMember(
  deps: AccountDeps,
  signedIn: SignedIn,
  userId: string,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  requireRecentPassword(signedIn);
  if (userId === signedIn.user.id) throw new ConflictError("You can't deactivate yourself.");
  const { Membership, Session } = accountModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const membership = await Membership.findOne({
      where: { userId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!membership) throw notAMember();
    if (membership.isOwner) throw new ConflictError("The workspace owner can't be deactivated.");
    if (membership.status === 'deactivated') return;
    await membership.update({ status: 'deactivated', deactivatedAt: new Date() }, { transaction });
    await Session.destroy({ where: { userId, workspaceId: signedIn.workspace.id }, transaction });
    await sendSignal(
      deps.db.writer,
      { type: 'member-removed', workspaceId: signedIn.workspace.id, userId },
      transaction,
    );
    const person = await accountModels(deps.db.writer).User.findByPk(userId, {
      attributes: ['name'],
      transaction,
    });
    await unassignOpenTickets(
      deps,
      signedIn,
      userId,
      person?.name ?? 'a former member',
      transaction,
    );
    await recordAboutMember(deps, signedIn, userId, { action: 'member.deactivated' }, transaction);
  });
  deps.log.info({ workspaceId: signedIn.workspace.id, userId }, 'member deactivated');
}

export async function reactivateMember(
  deps: AccountDeps,
  signedIn: SignedIn,
  userId: string,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  const { Membership } = accountModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const membership = await Membership.findOne({ where: { userId }, transaction });
    if (!membership) throw notAMember();
    if (membership.status === 'active') return;
    await membership.update({ status: 'active', deactivatedAt: null }, { transaction });
    await recordAboutMember(deps, signedIn, userId, { action: 'member.reactivated' }, transaction);
  });
  deps.log.info({ workspaceId: signedIn.workspace.id, userId }, 'member reactivated');
}

/**
 * An admin resets a member's lost two-step verification: removes it, forgets trusted devices,
 * signs them out everywhere and emails them. Two-step verification belongs to the person, so it is
 * refused when they also belong to another workspace: one workspace's admin must not weaken
 * another workspace's security. Needs the password confirmed recently.
 */
export async function resetMemberTwoFactor(
  deps: AccountDeps,
  signedIn: SignedIn,
  userId: string,
): Promise<void> {
  requirePermission(signedIn, 'members.manage');
  requireRecentPassword(signedIn);
  if (userId === signedIn.user.id) {
    throw new ConflictError('Manage your own two-step verification from Your account.');
  }
  const { Membership, User, UserTwoFactor, RecoveryCode } = accountModels(deps.db.writer);
  const membership = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    Membership.findOne({ where: { userId, status: 'active' }, transaction }),
  );
  if (!membership) throw notAMember();
  const [user, setup] = await Promise.all([
    User.findByPk(userId),
    UserTwoFactor.findByPk(userId, { attributes: ['enabledAt'] }),
  ]);
  if (!user) throw notAMember();
  if (!setup?.enabledAt)
    throw new ConflictError('Two-step verification is not on for this person.');
  if ((await memberWorkspaces(deps, userId)).length > 1) {
    throw new AppError(
      409,
      'MEMBER_IN_OTHER_WORKSPACES',
      `This person also belongs to other ${PRODUCT_NAME} workspaces, so only they (with a recovery code) or our support team can reset it.`,
    );
  }

  await deps.db.writer.transaction(async (transaction) => {
    await RecoveryCode.destroy({ where: { userId }, transaction });
    await UserTwoFactor.destroy({ where: { userId }, transaction });
    await revokeTrustedDevices(deps.db, userId, transaction);
    await revokeSessions(deps.db, userId, transaction);
    await recordAboutMember(
      deps,
      signedIn,
      userId,
      { action: 'member.two_factor_reset' },
      transaction,
    );
  });
  deps.log.info(
    { workspaceId: signedIn.workspace.id, userId },
    'member two-step verification reset',
  );
  await deliver(
    deps,
    twoFactorResetByAdminEmail({
      to: user.email,
      name: user.name,
      adminName: signedIn.user.name,
      workspaceName: signedIn.workspace.name,
      forgotUrl: forgotPasswordUrl(deps, signedIn.workspace.subdomain),
    }),
  );
}

export interface PersonView {
  userId: string;
  name: string;
  role: Role;
  status: MembershipStatus;
}

/**
 * Everyone in the workspace by name, active first, then A to Z (every member): for choosing an
 * assignee or filtering by one. No emails or security details, unlike the members list.
 */
export async function listPeople(deps: AccountDeps, signedIn: SignedIn): Promise<PersonView[]> {
  requirePermission(signedIn, 'tickets.work');
  const { Membership, User } = accountModels(deps.db.writer);
  const memberships = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    Membership.findAll({ attributes: ['userId', 'role', 'status'], transaction }),
  );
  const users = await User.findAll({
    attributes: ['id', 'name'],
    where: { id: memberships.map((row) => row.userId) },
  });
  const nameOf = new Map(users.map((user) => [user.id, user.name]));
  return memberships
    .map((row) => ({
      userId: row.userId,
      name: nameOf.get(row.userId) ?? 'Unknown',
      role: row.role,
      status: row.status,
    }))
    .sort(
      (a, b) =>
        Number(a.status === 'deactivated') - Number(b.status === 'deactivated') ||
        a.name.localeCompare(b.name),
    );
}
