import { UniqueConstraintError, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels, type MembershipStatus, type Role } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { teamModels, type TeamModels, type TeamRecord } from './models.js';

/** Teams a workspace can have. */
export const MAX_TEAMS = 100;
/** People in one team. */
export const MAX_TEAM_MEMBERS = 500;

interface Deps {
  db: Database;
}

export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: MembershipStatus;
  isLead: boolean;
}

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  /** Leads first, then A to Z. */
  members: TeamMemberView[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMemberInput {
  userId: string;
  isLead?: boolean | undefined;
}

export interface TeamInput {
  name?: string | undefined;
  description?: string | null | undefined;
  /** The whole member list; replaces the current one. */
  members?: TeamMemberInput[] | undefined;
}

interface Problem {
  field: string;
  message: string;
}

const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

/** The workspace members with these ids, with their names, as of this transaction. */
async function peopleById(db: Database, userIds: string[], transaction: Transaction) {
  const { Membership, User } = accountModels(db.writer);
  if (userIds.length === 0) return new Map<string, Omit<TeamMemberView, 'isLead'>>();
  // One after another: queries in one transaction share its connection.
  const memberships = await Membership.findAll({ where: { userId: userIds }, transaction });
  const users = await User.findAll({
    attributes: ['id', 'name', 'email'],
    where: { id: userIds },
    transaction,
  });
  const userById = new Map(users.map((user) => [user.id, user]));
  return new Map(
    memberships.flatMap((membership) => {
      const user = userById.get(membership.userId);
      return user
        ? [
            [
              membership.userId,
              {
                userId: membership.userId,
                name: user.name,
                email: user.email,
                role: membership.role,
                status: membership.status,
              },
            ] as const,
          ]
        : [];
    }),
  );
}

/** Teams as the API shows them, A to Z, with their members' names. */
async function viewsOf(
  db: Database,
  teams: TeamRecord[],
  transaction: Transaction,
): Promise<TeamView[]> {
  const people = await peopleById(
    db,
    [...new Set(teams.flatMap((team) => (team.members ?? []).map((member) => member.userId)))],
    transaction,
  );
  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    description: team.description,
    members: (team.members ?? [])
      .flatMap((member) => {
        const person = people.get(member.userId);
        return person ? [{ ...person, isLead: member.isLead }] : [];
      })
      .sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name)),
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  }));
}

async function readTeam(deps: Deps, teamId: string, transaction: Transaction): Promise<TeamView> {
  const { Team, TeamMember } = teamModels(deps.db.writer);
  const team = await Team.findByPk(teamId, {
    include: [{ model: TeamMember, as: 'members' }],
    transaction,
  });
  if (!team) throw new NotFoundError('This team does not exist.');
  const [view] = await viewsOf(deps.db, [team], transaction);
  if (!view) throw new NotFoundError('This team does not exist.');
  return view;
}

/**
 * Every team with its members (every role: tickets are routed to teams). Reads the writer: the
 * settings page reloads this list right after each change and must see it. A workspace has at
 * most MAX_TEAMS teams, so the list is not paginated.
 */
export async function listTeams(deps: Deps, signedIn: SignedIn): Promise<TeamView[]> {
  const { Team, TeamMember } = teamModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const teams = await Team.findAll({
      include: [{ model: TeamMember, as: 'members' }],
      order: [['name', 'ASC']],
      transaction,
    });
    const views = await viewsOf(deps.db, teams, transaction);
    return views.sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** One team with its members (every role). */
export async function getTeam(deps: Deps, signedIn: SignedIn, teamId: string): Promise<TeamView> {
  return withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    readTeam(deps, teamId, transaction),
  );
}

/**
 * Checks a member list: each person once, each a member of this workspace, and nobody
 * deactivated unless they are already in the team (deactivated members keep their place).
 */
async function checkMembers(
  deps: Deps,
  members: TeamMemberInput[],
  keep: Set<string>,
  transaction: Transaction,
): Promise<{ problems: Problem[]; people: Awaited<ReturnType<typeof peopleById>> }> {
  const problems: Problem[] = [];
  if (members.length > MAX_TEAM_MEMBERS) {
    problems.push({
      field: 'members',
      message: `A team can have at most ${String(MAX_TEAM_MEMBERS)} people.`,
    });
  }
  const people = await peopleById(
    deps.db,
    members.map((member) => member.userId),
    transaction,
  );
  const seen = new Set<string>();
  members.forEach((member, index) => {
    const field = `members.${String(index)}`;
    const person = people.get(member.userId);
    if (seen.has(member.userId)) {
      problems.push({ field, message: 'This person is listed twice.' });
    } else if (!person) {
      problems.push({ field, message: 'This person is not a member of this workspace.' });
    } else if (person.status === 'deactivated' && !keep.has(member.userId)) {
      problems.push({ field, message: `${person.name} is deactivated.` });
    }
    seen.add(member.userId);
  });
  return { problems, people };
}

function refuse(problems: Problem[]) {
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
}

/** A unique-name race (two saves at once) explained like the normal check. */
function explainUnique(error: unknown): never {
  if (error instanceof UniqueConstraintError) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [{ field: 'name', message: 'There is already a team with this name.' }],
    });
  }
  throw error;
}

async function nameTaken(
  models: TeamModels,
  name: string,
  teamId: string | null,
  transaction: Transaction,
): Promise<Problem[]> {
  const teams = await models.Team.findAll({ attributes: ['id', 'name'], transaction });
  const taken = teams.some(
    (team) => team.id !== teamId && team.name.toLowerCase() === name.toLowerCase(),
  );
  return taken ? [{ field: 'name', message: 'There is already a team with this name.' }] : [];
}

/** Saves the member list: adds, removes and changes leads. Returns who changed, by name. */
async function saveMembers(
  models: TeamModels,
  workspaceId: string,
  teamId: string,
  members: TeamMemberInput[],
  names: Map<string, string>,
  transaction: Transaction,
) {
  const { TeamMember } = models;
  const existing = await TeamMember.findAll({ where: { teamId }, transaction });
  const wanted = new Map(members.map((member) => [member.userId, member.isLead ?? false]));
  const change = { added: [] as string[], removed: [] as string[], leads: [] as string[] };
  const unleads: string[] = [];
  const nameOf = (userId: string) => names.get(userId) ?? 'a former member';

  for (const row of existing) {
    const isLead = wanted.get(row.userId);
    if (isLead === undefined) {
      await row.destroy({ transaction });
      change.removed.push(nameOf(row.userId));
    } else if (isLead !== row.isLead) {
      await row.update({ isLead }, { transaction });
      (isLead ? change.leads : unleads).push(nameOf(row.userId));
    }
  }
  for (const [userId, isLead] of wanted) {
    if (existing.some((row) => row.userId === userId)) continue;
    await TeamMember.create({ teamId, workspaceId, userId, isLead }, { transaction });
    change.added.push(nameOf(userId));
    if (isLead) change.leads.push(nameOf(userId));
  }
  return { ...change, unleads };
}

/** Adds a team (admins). Returns it, read from the writer. */
export async function createTeam(
  deps: Deps,
  signedIn: SignedIn,
  input: TeamInput & { name: string },
): Promise<TeamView> {
  requirePermission(signedIn, 'teams.manage');
  const models = teamModels(deps.db.writer);
  const name = input.name.trim();
  const members = input.members ?? [];

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    if ((await models.Team.count({ transaction })) >= MAX_TEAMS) {
      throw new ConflictError(`A workspace can have at most ${String(MAX_TEAMS)} teams.`);
    }
    const checked = await checkMembers(deps, members, new Set(), transaction);
    refuse([...(await nameTaken(models, name, null, transaction)), ...checked.problems]);

    const id = newId();
    try {
      await models.Team.create(
        {
          id,
          workspaceId: signedIn.workspace.id,
          name,
          description: blankToNull(input.description),
        },
        { transaction },
      );
    } catch (error) {
      explainUnique(error);
    }
    const names = new Map([...checked.people].map(([userId, person]) => [userId, person.name]));
    const saved = await saveMembers(models, signedIn.workspace.id, id, members, names, transaction);
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'team.created',
        target: { type: 'team', id, label: name },
        details: { members: saved.added, leads: saved.leads },
        meta: signedIn.meta,
      },
      transaction,
    );
    return readTeam(deps, id, transaction);
  });
}

/** Someone else saved the team after it was loaded. */
export class TeamChangedError extends AppError {
  constructor() {
    super(
      409,
      'TEAM_CHANGED',
      'Someone else changed this team after you opened it. Reload it to see their changes.',
    );
  }
}

/**
 * Changes a team (admins): only the fields given change, and `members` replaces the list. With
 * `updatedAt` (the version the editor loaded), the save is refused if the team changed since.
 */
export async function updateTeam(
  deps: Deps,
  signedIn: SignedIn,
  teamId: string,
  changes: TeamInput & { updatedAt?: Date | undefined },
): Promise<TeamView> {
  requirePermission(signedIn, 'teams.manage');
  const models = teamModels(deps.db.writer);

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const team = await models.Team.findByPk(teamId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!team) throw new NotFoundError('This team does not exist.');
    if (changes.updatedAt && changes.updatedAt.getTime() !== team.updatedAt.getTime()) {
      throw new TeamChangedError();
    }
    const current = await models.TeamMember.findAll({ where: { teamId }, transaction });
    const name = changes.name?.trim() ?? team.name;
    const problems =
      name.toLowerCase() === team.name.toLowerCase()
        ? []
        : await nameTaken(models, name, teamId, transaction);
    const checked = changes.members
      ? await checkMembers(
          deps,
          changes.members,
          new Set(current.map((row) => row.userId)),
          transaction,
        )
      : null;
    refuse([...problems, ...(checked?.problems ?? [])]);

    const changed: string[] = [];
    const details: Record<string, unknown> = {};
    if (name !== team.name) {
      details.from = team.name;
      details.to = name;
    }
    const description =
      changes.description === undefined ? team.description : blankToNull(changes.description);
    if (description !== team.description) changed.push('description');

    if (changes.members && checked) {
      const everyone = await peopleById(
        deps.db,
        [...new Set([...current.map((row) => row.userId), ...checked.people.keys()])],
        transaction,
      );
      const names = new Map([...everyone].map(([userId, person]) => [userId, person.name]));
      const saved = await saveMembers(
        models,
        signedIn.workspace.id,
        teamId,
        changes.members,
        names,
        transaction,
      );
      for (const [key, list] of Object.entries(saved)) {
        // Fixed keys from saveMembers.
        // eslint-disable-next-line security/detect-object-injection
        if (list.length > 0) details[key] = list;
      }
    }
    if (Object.keys(details).length === 0 && changed.length === 0) {
      return readTeam(deps, teamId, transaction);
    }

    try {
      team.set({ name, description });
      // A member-only change still moves the version, so other editors see it changed.
      team.changed('updatedAt', true);
      await team.save({ transaction });
    } catch (error) {
      explainUnique(error);
    }
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'team.updated',
        target: { type: 'team', id: teamId, label: name },
        details: { ...details, ...(changed.length > 0 ? { changed } : {}) },
        meta: signedIn.meta,
      },
      transaction,
    );
    return readTeam(deps, teamId, transaction);
  });
}

/** Deletes a team (admins). Its members stay in the workspace. Recorded in the audit log. */
export async function deleteTeam(deps: Deps, signedIn: SignedIn, teamId: string): Promise<void> {
  requirePermission(signedIn, 'teams.manage');
  const { Team, TeamMember } = teamModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const team = await Team.findByPk(teamId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!team) throw new NotFoundError('This team does not exist.');
    const members = await TeamMember.count({ where: { teamId }, transaction });
    await team.destroy({ transaction });
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'team.deleted',
        target: { type: 'team', id: teamId, label: team.name },
        details: { memberCount: members },
        meta: signedIn.meta,
      },
      transaction,
    );
  });
}

// --- Used by members and invitations -------------------------------------------------------------

export interface TeamRef {
  id: string;
  name: string;
}

/** Each member's teams (A to Z), for the members page. Runs inside the caller's transaction. */
export async function teamsByMember(
  db: Database,
  transaction: Transaction,
): Promise<Map<string, (TeamRef & { isLead: boolean })[]>> {
  const { Team, TeamMember } = teamModels(db.writer);
  const teams = await Team.findAll({ attributes: ['id', 'name'], transaction });
  const rows = await TeamMember.findAll({ transaction });
  const nameOf = new Map(teams.map((team) => [team.id, team.name]));
  const result = new Map<string, (TeamRef & { isLead: boolean })[]>();
  for (const row of rows) {
    const name = nameOf.get(row.teamId);
    if (!name) continue;
    const list = result.get(row.userId) ?? [];
    list.push({ id: row.teamId, name, isLead: row.isLead });
    result.set(row.userId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Problems for team ids that do not exist (inviting into teams). */
export async function checkTeamIds(
  db: Database,
  teamIds: string[],
  transaction: Transaction,
): Promise<Problem[]> {
  if (teamIds.length === 0) return [];
  const found = await teamModels(db.writer).Team.findAll({
    attributes: ['id'],
    where: { id: teamIds },
    transaction,
  });
  return found.length === new Set(teamIds).size
    ? []
    : [{ field: 'teamIds', message: 'One of these teams no longer exists. Reload and try again.' }];
}

/** Remembers the teams an invited person joins when they accept. */
export async function saveInvitationTeams(
  db: Database,
  workspaceId: string,
  invitationId: string,
  teamIds: string[],
  transaction: Transaction,
): Promise<void> {
  if (teamIds.length === 0) return;
  await teamModels(db.writer).InvitationTeam.bulkCreate(
    [...new Set(teamIds)].map((teamId) => ({ invitationId, teamId, workspaceId })),
    { transaction },
  );
}

/** The teams of each invitation (A to Z), for the members page. */
export async function teamsByInvitation(
  db: Database,
  invitationIds: string[],
  transaction: Transaction,
): Promise<Map<string, TeamRef[]>> {
  const { InvitationTeam, Team } = teamModels(db.writer);
  const result = new Map<string, TeamRef[]>();
  if (invitationIds.length === 0) return result;
  const rows = await InvitationTeam.findAll({
    where: { invitationId: invitationIds },
    transaction,
  });
  const teams = await Team.findAll({
    attributes: ['id', 'name'],
    where: { id: [...new Set(rows.map((row) => row.teamId))] },
    transaction,
  });
  const nameOf = new Map(teams.map((team) => [team.id, team.name]));
  for (const row of rows) {
    const name = nameOf.get(row.teamId);
    if (!name) continue;
    const list = result.get(row.invitationId) ?? [];
    list.push({ id: row.teamId, name });
    result.set(row.invitationId, list);
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/** Puts a person who accepted an invitation into its teams (teams deleted meanwhile are gone). */
export async function joinInvitationTeams(
  db: Database,
  workspaceId: string,
  invitationId: string,
  userId: string,
  transaction: Transaction,
): Promise<string[]> {
  const { InvitationTeam, Team, TeamMember } = teamModels(db.writer);
  const rows = await InvitationTeam.findAll({ where: { invitationId }, transaction });
  if (rows.length === 0) return [];
  await TeamMember.bulkCreate(
    rows.map((row) => ({ teamId: row.teamId, workspaceId, userId, isLead: false })),
    { transaction, ignoreDuplicates: true },
  );
  const teams = await Team.findAll({
    attributes: ['name'],
    where: { id: rows.map((row) => row.teamId) },
    transaction,
  });
  return teams.map((team) => team.name).sort((a, b) => a.localeCompare(b));
}
