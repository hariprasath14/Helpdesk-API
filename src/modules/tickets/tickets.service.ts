import { Op, type Sequelize, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission, type Permission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { contactModels } from '../contacts/models.js';
import { findOrAddContact } from '../contacts/contacts.service.js';
import { fieldDefinitions } from '../custom-fields/custom-fields.service.js';
import { checkCustomFieldValues, type CustomFieldValues } from '../custom-fields/values.js';
import { QUEUES, type JobQueue } from '../../jobs/queue.js';
import type { CustomerNotification } from '../email/templates.js';
import { notifyMembers } from '../notifications/notify.js';
import { runRules } from '../rules/engine.js';
import { nextDue, targetViews, type TargetView } from '../sla/clock.js';
import { slaModels } from '../sla/models.js';
import { updateSla } from '../sla/sla.service.js';
import { teamModels } from '../teams/models.js';
import {
  afterCursor,
  cursorAttributes,
  UNRESOLVED,
  encodeCursor,
  filterConditions,
  orderFor,
  type TicketFilters,
  type TicketSort,
} from './ticket-list.js';
import {
  ticketModels,
  type ActivityChange,
  type TicketModels,
  type TicketPriority,
  type TicketRecord,
  type TicketSource,
  type TicketStatus,
  type TicketType,
} from './models.js';

export const SUBJECT_MAX = 200;
export const DESCRIPTION_MAX = 50_000;
export const MAX_TAGS = 20;
export const TAG_MAX = 40;

interface Deps {
  db: Database;
  /** Background jobs: "assigned to you" emails (F13). */
  jobs: Pick<JobQueue, 'enqueue'>;
}

/**
 * Tells the new assignee inside the caller's transaction (F12): in the notification center (F25),
 * and by the "assigned to you" email (F13) if they keep that on. Nobody is told about tickets they
 * took themselves.
 */
async function queueAssignmentEmail(
  deps: Deps,
  signedIn: ChangeActor,
  ticket: TicketRecord,
  transaction: Transaction,
) {
  const assignee = ticket.assigneeUserId;
  if (!assignee || assignee === signedIn.user.id) return;
  const ref = `#${String(ticket.number)}`;
  await notifyMembers(
    deps,
    {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      kind: 'assigned',
      userIds: [assignee],
      subject: `Ticket ${ref} assigned to you`,
      text: `${signedIn.user.name} assigned you ticket ${ref}: ${ticket.subject}`,
    },
    transaction,
    {
      email: async () => {
        await deps.jobs.enqueue(
          QUEUES.assignmentEmail,
          {
            workspaceId: ticket.workspaceId,
            ticketId: ticket.id,
            assigneeUserId: assignee,
            assignedBy: signedIn.user.name,
          },
          transaction,
        );
      },
    },
  );
}

/**
 * Queues a customer notification (F15) inside the caller's transaction. The worker checks the
 * workspace's setting and the requester's email when it sends.
 */
async function queueCustomerEmail(
  deps: { jobs: Pick<JobQueue, 'enqueue'> },
  ticket: TicketRecord,
  event: CustomerNotification,
  transaction: Transaction,
  agentName?: string,
) {
  await deps.jobs.enqueue(
    QUEUES.customerEmail,
    {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      event,
      ...(agentName ? { agentName } : {}),
    },
    transaction,
  );
}

interface Ref {
  id: string;
  name: string;
}

export interface TicketSummary {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType | null;
  contact: Ref & { email: string | null };
  company: Ref | null;
  team: Ref | null;
  assignee: { userId: string; name: string } | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  /** The next SLA deadline still running (F23), and which target it is. */
  due: { at: Date; target: 'reply' | 'resolve' } | null;
  /** Merged into another ticket (F28): closed and read-only. */
  mergedInto: { number: number } | null;
}

/** How a ticket stands against its SLA policy (F23). */
export interface TicketSla {
  policy: Ref | null;
  reply: TargetView | null;
  resolve: TargetView | null;
}

export interface TicketView extends TicketSummary {
  description: string;
  source: TicketSource;
  customFields: CustomFieldValues;
  createdBy: { userId: string; name: string } | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  /** When the first reply to the requester went out (F11). */
  firstResponseAt: Date | null;
  sla: TicketSla | null;
  /** Copied on every reply (F28). */
  ccEmails: string[];
}

/** Statuses that count as done: "required when resolving" fields must be filled to reach them. */
const DONE: readonly TicketStatus[] = ['resolved', 'closed'];

interface Problem {
  field: string;
  message: string;
}

function refuse(problems: Problem[]) {
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
}

/** Tags as stored: trimmed, single spaces, lowercase, each once, in the order given. */
export function cleanTags(tags: string[]): { tags: string[]; problems: Problem[] } {
  const clean = [
    ...new Set(tags.map((tag) => tag.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean)),
  ];
  const problems: Problem[] = [];
  if (clean.length > MAX_TAGS) {
    problems.push({ field: 'tags', message: `Add at most ${String(MAX_TAGS)} tags.` });
  }
  clean.forEach((tag, index) => {
    if (tag.length > TAG_MAX) {
      problems.push({
        field: `tags.${String(index)}`,
        message: `Keep tags to ${String(TAG_MAX)} characters.`,
      });
    }
  });
  return { tags: clean, problems };
}

/**
 * The names behind a set of tickets' ids (contacts, companies, teams, people), in one query per
 * kind, so a page of tickets costs a fixed number of queries.
 */
async function namesFor(sequelize: Sequelize, tickets: TicketRecord[], transaction: Transaction) {
  const ids = (pick: (ticket: TicketRecord) => string | null) => [
    ...new Set(
      tickets.flatMap((ticket) => {
        const id = pick(ticket);
        return id ? [id] : [];
      }),
    ),
  ];
  const { Contact, Company } = contactModels(sequelize);
  const { Team } = teamModels(sequelize);
  const { User } = accountModels(sequelize);
  const userIds = ids((ticket) => ticket.assigneeUserId).concat(
    ids((ticket) => ticket.createdByUserId),
  );
  // One after another: queries in one transaction share its connection.
  const contacts = await Contact.findAll({
    attributes: ['id', 'name', 'email'],
    where: { id: ids((ticket) => ticket.contactId) },
    transaction,
  });
  const companies = await Company.findAll({
    attributes: ['id', 'name'],
    where: { id: ids((ticket) => ticket.companyId) },
    transaction,
  });
  const teams = await Team.findAll({
    attributes: ['id', 'name'],
    where: { id: ids((ticket) => ticket.teamId) },
    transaction,
  });
  const users =
    userIds.length > 0
      ? await User.findAll({ attributes: ['id', 'name'], where: { id: [...new Set(userIds)] } })
      : [];
  const mergedIds = ids((ticket) => ticket.mergedIntoId ?? null);
  const merged =
    mergedIds.length > 0
      ? await ticketModels(sequelize).Ticket.findAll({
          attributes: ['id', 'number'],
          where: { id: mergedIds },
          transaction,
        })
      : [];
  const policyIds = ids((ticket) => ticket.slaPolicyId ?? null);
  const policies =
    policyIds.length > 0
      ? await slaModels(sequelize).SlaPolicy.findAll({
          attributes: ['id', 'name'],
          where: { id: policyIds },
          transaction,
        })
      : [];
  return {
    contact: new Map(contacts.map((row) => [row.id, row])),
    company: new Map(companies.map((row) => [row.id, row.name])),
    team: new Map(teams.map((row) => [row.id, row.name])),
    user: new Map(users.map((row) => [row.id, row.name])),
    policy: new Map(policies.map((row) => [row.id, row.name])),
    ticketNumber: new Map(merged.map((row) => [row.id, row.number])),
  };
}

type Names = Awaited<ReturnType<typeof namesFor>>;

function summaryOf(ticket: TicketRecord, names: Names): TicketSummary {
  const contact = names.contact.get(ticket.contactId);
  const ref = (id: string | null, map: Map<string, string>): Ref | null => {
    const name = id ? map.get(id) : undefined;
    return id && name ? { id, name } : null;
  };
  const assigneeName = ticket.assigneeUserId ? names.user.get(ticket.assigneeUserId) : undefined;
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    contact: {
      id: ticket.contactId,
      name: contact?.name ?? 'Unknown contact',
      email: contact?.email ?? null,
    },
    company: ref(ticket.companyId, names.company),
    team: ref(ticket.teamId, names.team),
    assignee:
      ticket.assigneeUserId && assigneeName
        ? { userId: ticket.assigneeUserId, name: assigneeName }
        : null,
    tags: (ticket.tags ?? []).map((row) => row.tag).sort(),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    deletedAt: ticket.deletedAt,
    due: ticket.deletedAt ? null : nextDue(ticket),
    mergedInto: ticket.mergedIntoId
      ? { number: names.ticketNumber.get(ticket.mergedIntoId) ?? 0 }
      : null,
  };
}

function slaOf(ticket: TicketRecord, names: Names): TicketSla | null {
  if (!ticket.slaReplyDueAt && !ticket.slaResolveDueAt) return null;
  const policyName = ticket.slaPolicyId ? names.policy.get(ticket.slaPolicyId) : undefined;
  return {
    policy: ticket.slaPolicyId && policyName ? { id: ticket.slaPolicyId, name: policyName } : null,
    ...targetViews(ticket, new Date()),
  };
}

function viewOf(ticket: TicketRecord, names: Names): TicketView {
  const creator = ticket.createdByUserId ? names.user.get(ticket.createdByUserId) : undefined;
  return {
    ...summaryOf(ticket, names),
    description: ticket.description,
    source: ticket.source,
    customFields: ticket.customFields,
    createdBy:
      ticket.createdByUserId && creator ? { userId: ticket.createdByUserId, name: creator } : null,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    firstResponseAt: ticket.firstResponseAt ?? null,
    sla: slaOf(ticket, names),
    ccEmails: ticket.ccEmails,
  };
}

/** Summaries for a list of tickets, with their names and tags loaded in a few queries. */
export async function summariesOf(
  sequelize: Sequelize,
  tickets: TicketRecord[],
  transaction: Transaction,
): Promise<TicketSummary[]> {
  const names = await namesFor(sequelize, tickets, transaction);
  return tickets.map((ticket) => summaryOf(ticket, names));
}

const notFound = () => new NotFoundError('This ticket does not exist.');

export async function findTicket(
  models: TicketModels,
  number: number,
  transaction: Transaction,
  lock = false,
): Promise<TicketRecord> {
  const ticket = await models.Ticket.findOne({
    where: { number },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!ticket) throw notFound();
  ticket.tags = await models.TicketTag.findAll({ where: { ticketId: ticket.id }, transaction });
  return ticket;
}

/** A ticket's id from its number, inside the caller's transaction (deleted tickets too); 404. */
export async function ticketIdForNumber(
  deps: Deps,
  number: number,
  transaction: Transaction,
): Promise<string> {
  const ticket = await ticketModels(deps.db.writer).Ticket.findOne({
    attributes: ['id'],
    where: { number },
    transaction,
  });
  if (!ticket) throw notFound();
  return ticket.id;
}

export async function readTicket(deps: Deps, number: number, transaction: Transaction) {
  const ticket = await findTicket(ticketModels(deps.db.writer), number, transaction);
  return viewOf(ticket, await namesFor(deps.db.writer, [ticket], transaction));
}

/**
 * One ticket by its number (every member; deleted tickets too, marked by deletedAt). Reads the
 * writer: the app opens a ticket right after creating or changing it.
 */
export async function getTicket(deps: Deps, signedIn: SignedIn, number: number) {
  requirePermission(signedIn, 'tickets.work');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    readTicket(deps, number, transaction),
  );
}

/** Names of people by user id (users are not a workspace table). */
async function personNames(deps: Deps, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>();
  const users = await accountModels(deps.db.writer).User.findAll({
    attributes: ['id', 'name'],
    where: { id: userIds },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

/** Someone else may assign anyone; agents may take unassigned tickets or give back their own. */
export class AssignOthersError extends ForbiddenError {
  constructor() {
    super(
      'You can take unassigned tickets or give back your own. A supervisor or admin can reassign others.',
    );
  }
}

/**
 * Checks an assignee change from `current` to `next` (a user id or null). Admins and supervisors
 * (tickets.assign_any) assign anyone; others only take an unassigned ticket or unassign
 * themselves (403 otherwise). The new assignee must be an active member of this workspace.
 */
async function checkAssignee(
  deps: Deps,
  signedIn: ChangeActor,
  current: string | null,
  next: string | null,
  transaction: Transaction,
): Promise<Problem[]> {
  const me = signedIn.user.id;
  const allowed =
    signedIn.permissions.includes('tickets.assign_any') ||
    (next === me && current === null) ||
    (next === null && current === me);
  if (!allowed) throw new AssignOthersError();
  if (next === null) return [];
  const membership = await accountModels(deps.db.writer).Membership.findOne({
    attributes: ['status'],
    where: { userId: next },
    transaction,
  });
  return membership?.status === 'active'
    ? []
    : [
        {
          field: 'assigneeUserId',
          message: 'This person is deactivated or not in this workspace.',
        },
      ];
}

/**
 * Unassigns a member's unresolved tickets when they are deactivated (F12), inside the caller's
 * transaction, with a history entry on each by the admin who deactivated them. Resolved and closed
 * tickets keep their assignee. Returns how many were unassigned.
 */
export async function unassignOpenTickets(
  deps: { db: Database },
  signedIn: SignedIn,
  userId: string,
  name: string,
  transaction: Transaction,
): Promise<number> {
  const models = ticketModels(deps.db.writer);
  const tickets = await models.Ticket.findAll({
    where: { assigneeUserId: userId, status: UNRESOLVED as TicketStatus[] },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const ticket of tickets) {
    ticket.set({ assigneeUserId: null });
    ticket.changed('updatedAt', true);
    await ticket.save({ transaction });
    await recordActivity(
      models,
      signedIn,
      ticket,
      'updated',
      [{ field: 'assignee', from: name, to: null }],
      transaction,
    );
  }
  return tickets.length;
}

async function checkTeam(deps: Deps, teamId: string | null | undefined, transaction: Transaction) {
  if (!teamId) return [];
  const team = await teamModels(deps.db.writer).Team.findByPk(teamId, {
    attributes: ['id'],
    transaction,
  });
  return team ? [] : [{ field: 'teamId', message: 'This team no longer exists.' }];
}

/** Saves a ticket's tags to match `tags`; returns those added and removed. */
export async function saveTags(
  models: TicketModels,
  ticket: TicketRecord,
  tags: string[],
  transaction: Transaction,
) {
  const current = (ticket.tags ?? []).map((row) => row.tag);
  const added = tags.filter((tag) => !current.includes(tag));
  const removed = current.filter((tag) => !tags.includes(tag));
  if (removed.length > 0) {
    await models.TicketTag.destroy({ where: { ticketId: ticket.id, tag: removed }, transaction });
  }
  if (added.length > 0) {
    await models.TicketTag.bulkCreate(
      added.map((tag) => ({ ticketId: ticket.id, workspaceId: ticket.workspaceId, tag })),
      { transaction },
    );
  }
  return { added, removed };
}

export async function nextNumber(
  deps: { db: Database },
  workspaceId: string,
  transaction: Transaction,
) {
  const [rows] = await deps.db.writer.query(
    `INSERT INTO ticket_counters (workspace_id, last_number) VALUES (:workspaceId, 1)
     ON CONFLICT (workspace_id) DO UPDATE SET last_number = ticket_counters.last_number + 1
     RETURNING last_number`,
    { replacements: { workspaceId }, transaction },
  );
  const number = (rows as { last_number: number }[])[0]?.last_number;
  if (!number) throw new Error('No ticket number');
  return number;
}

/** Who changed a ticket, for its history: a member, or a customer or rule (no user id). */
interface Actor {
  user: { id: string | null; name: string };
}

/**
 * Who makes a ticket change: the signed-in member, or a rule acting with the permissions it was
 * given (F17). The same checks and history apply either way.
 */
export interface ChangeActor extends Actor {
  permissions: readonly Permission[];
}

export async function recordActivity(
  models: TicketModels,
  actor: Actor,
  ticket: TicketRecord,
  action: 'created' | 'updated' | 'deleted' | 'restored',
  changes: ActivityChange[],
  transaction: Transaction,
) {
  await models.TicketActivity.create(
    {
      id: newId(),
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      actorUserId: actor.user.id,
      actorName: actor.user.name,
      action,
      changes,
    },
    { transaction },
  );
}

/**
 * Times that follow the status: resolved and closed are set on reaching them and cleared on
 * reopening; statusChangedAt is every change of status (F20).
 */
export function statusTimes(
  status: TicketStatus,
  current?: { resolvedAt: Date | null; closedAt: Date | null },
) {
  const now = new Date();
  if (status === 'closed') {
    return {
      resolvedAt: current?.resolvedAt ?? now,
      closedAt: current?.closedAt ?? now,
      statusChangedAt: now,
    };
  }
  if (status === 'resolved') {
    return { resolvedAt: current?.resolvedAt ?? now, closedAt: null, statusChangedAt: now };
  }
  return { resolvedAt: null, closedAt: null, statusChangedAt: now };
}

export interface TicketInput {
  subject?: string | undefined;
  status?: TicketStatus | undefined;
  priority?: TicketPriority | undefined;
  type?: TicketType | null | undefined;
  teamId?: string | null | undefined;
  tags?: string[] | undefined;
  customFields?: CustomFieldValues | undefined;
  /** The requester: an existing contact. */
  contactId?: string | undefined;
  /** Who works the ticket; null for nobody. See checkAssignee() for who may set what. */
  assigneeUserId?: string | null | undefined;
}

export interface NewTicketInput extends TicketInput {
  subject: string;
  description?: string | undefined;
  /** Or a requester by name and email/phone: the contact with this email, or a new one. */
  contact?: { name: string; email?: string | null | undefined; phone?: string | null | undefined };
}

/** Custom field problems as a list (checkCustomFieldValues throws them together). */
function customFieldCheck(run: () => CustomFieldValues): {
  values: CustomFieldValues | null;
  problems: Problem[];
} {
  try {
    return { values: run(), problems: [] };
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { values: null, problems: (error.details as { fields: Problem[] }).fields };
  }
}

/**
 * Creates a ticket for a requester (every member, tickets.work). The requester is an existing
 * contact (`contactId`) or a name with an email or phone (`contact`): the contact with that email,
 * or a new one. Takes the requester's company. Returns the ticket, read from the writer.
 */
export async function createTicket(
  deps: Deps,
  signedIn: SignedIn,
  input: NewTicketInput,
): Promise<TicketView> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  const status = input.status ?? 'open';
  const { tags, problems } = cleanTags(input.tags ?? []);
  if (!input.contactId && !input.contact) {
    problems.push({ field: 'contactId', message: 'Choose who raised this ticket.' });
  }
  if (input.contactId && input.contact) {
    problems.push({
      field: 'contactId',
      message: 'Choose a contact or enter a new one, not both.',
    });
  }

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    problems.push(...(await checkTeam(deps, input.teamId, transaction)));
    if (input.assigneeUserId) {
      problems.push(
        ...(await checkAssignee(deps, signedIn, null, input.assigneeUserId, transaction)),
      );
    }
    const definitions = await fieldDefinitions(deps, 'ticket', transaction);
    const custom = customFieldCheck(() =>
      checkCustomFieldValues(definitions, input.customFields, {
        creating: true,
        resolving: DONE.includes(status),
      }),
    );
    problems.push(...custom.problems);

    let requester: { id: string; companyId: string | null } | null = null;
    if (input.contactId) {
      requester = await contactModels(deps.db.writer).Contact.findByPk(input.contactId, {
        attributes: ['id', 'companyId'],
        transaction,
      });
      if (!requester) {
        problems.push({ field: 'contactId', message: 'This contact no longer exists.' });
      }
    }
    refuse(problems);
    if (!requester && input.contact) {
      requester = await findOrAddContact(deps, signedIn.workspace.id, input.contact, transaction);
    }
    if (!requester) throw new ValidationError('Choose who raised this ticket.');

    const number = await nextNumber(deps, signedIn.workspace.id, transaction);
    const ticket = await models.Ticket.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        number,
        subject: input.subject.trim(),
        description: input.description?.trim() ?? '',
        contactId: requester.id,
        companyId: requester.companyId,
        status,
        priority: input.priority ?? 'medium',
        type: input.type ?? null,
        teamId: input.teamId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        source: 'agent',
        customFields: custom.values ?? {},
        createdByUserId: signedIn.user.id,
        ...statusTimes(status),
        deletedAt: null,
      },
      { transaction },
    );
    ticket.tags = [];
    await saveTags(models, ticket, tags, transaction);
    await recordActivity(models, signedIn, ticket, 'created', [], transaction);
    await queueAssignmentEmail(deps, signedIn, ticket, transaction);
    await queueCustomerEmail(deps, ticket, 'agentCreated', transaction, signedIn.user.name);
    await runRules(deps, 'ticket_created', ticket, transaction);
    await updateSla(deps, ticket, transaction);
    return readTicket(deps, number, transaction);
  });
}

/**
 * A ticket raised by a customer, by email (F14) or the web form (F16), inside the caller's
 * transaction: open, medium priority, nobody assigned yet (assignment rules: F18). Ticket fields get their defaults; required ones are asked
 * for when a member next saves the ticket. The history shows the customer as who raised it.
 */
export async function createCustomerTicket(
  deps: { db: Database; jobs: Pick<JobQueue, 'enqueue'> },
  workspaceId: string,
  input: {
    contact: { id: string; companyId: string | null; name: string };
    subject: string;
    description: string;
    source: 'email' | 'web_form';
    emailMessageId: string | null;
  },
  transaction: Transaction,
): Promise<TicketRecord> {
  const models = ticketModels(deps.db.writer);
  const customFields = checkCustomFieldValues(
    await fieldDefinitions(deps, 'ticket', transaction),
    {},
    { creating: true, skipRequired: true },
  );
  const ticket = await models.Ticket.create(
    {
      id: newId(),
      workspaceId,
      number: await nextNumber(deps, workspaceId, transaction),
      subject: input.subject,
      description: input.description,
      contactId: input.contact.id,
      companyId: input.contact.companyId,
      status: 'open',
      priority: 'medium',
      type: null,
      teamId: null,
      assigneeUserId: null,
      source: input.source,
      customFields,
      createdByUserId: null,
      ...statusTimes('open'),
      deletedAt: null,
      emailMessageId: input.emailMessageId,
    },
    { transaction },
  );
  await recordActivity(
    models,
    { user: { id: null, name: input.contact.name } },
    ticket,
    'created',
    [],
    transaction,
  );
  await queueCustomerEmail(deps, ticket, 'received', transaction);
  await runRules(deps, 'ticket_created', ticket, transaction);
  await updateSla(deps, ticket, transaction);
  return ticket;
}

/**
 * The customer wrote again on a ticket (F14): one that was waiting or resolved opens again, with a
 * history entry by the customer. Every message moves the ticket's "last updated".
 */
export async function reopenForCustomer(
  deps: { db: Database },
  ticket: TicketRecord,
  customerName: string,
  transaction: Transaction,
): Promise<void> {
  const from = ticket.status;
  const before = {
    status: ticket.status,
    priority: ticket.priority,
    statusChangedAt: ticket.statusChangedAt,
  };
  if (from !== 'open') {
    ticket.status = 'open';
    Object.assign(ticket, statusTimes('open'));
    await recordActivity(
      ticketModels(deps.db.writer),
      { user: { id: null, name: customerName } },
      ticket,
      'updated',
      [{ field: 'status', from, to: 'open' }],
      transaction,
    );
  }
  ticket.changed('updatedAt', true);
  await ticket.save({ transaction });
  if (from !== 'open') await updateSla(deps, ticket, transaction, before);
}

/** A change for the history, with names instead of ids where people read it. */
async function describeChanges(
  deps: Deps,
  ticket: TicketRecord,
  next: Partial<TicketRecord>,
  labels: Map<string, string>,
  transaction: Transaction,
): Promise<ActivityChange[]> {
  const changes: ActivityChange[] = [];
  const teamName = async (id: string | null | undefined) =>
    id
      ? ((await teamModels(deps.db.writer).Team.findByPk(id, { transaction }))?.name ?? null)
      : null;
  const contactName = async (id: string | null | undefined) =>
    id
      ? ((await contactModels(deps.db.writer).Contact.findByPk(id, { transaction }))?.name ?? null)
      : null;
  for (const field of ['subject', 'status', 'priority', 'type'] as const) {
    // eslint-disable-next-line security/detect-object-injection -- fixed field names
    const [before, after] = [ticket[field], next[field]];
    if (after !== undefined && after !== before) changes.push({ field, from: before, to: after });
  }
  if (next.teamId !== undefined && next.teamId !== ticket.teamId) {
    changes.push({
      field: 'team',
      from: await teamName(ticket.teamId),
      to: await teamName(next.teamId),
    });
  }
  if (next.assigneeUserId !== undefined && next.assigneeUserId !== ticket.assigneeUserId) {
    const names = await personNames(
      deps,
      [ticket.assigneeUserId, next.assigneeUserId].flatMap((id) => (id ? [id] : [])),
    );
    changes.push({
      field: 'assignee',
      from: ticket.assigneeUserId ? (names.get(ticket.assigneeUserId) ?? null) : null,
      to: next.assigneeUserId ? (names.get(next.assigneeUserId) ?? null) : null,
    });
  }
  if (next.contactId !== undefined && next.contactId !== ticket.contactId) {
    changes.push({
      field: 'contact',
      from: await contactName(ticket.contactId),
      to: await contactName(next.contactId),
    });
  }
  if (next.customFields) {
    const before = new Map(Object.entries(ticket.customFields));
    const after = new Map(Object.entries(next.customFields));
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const from = before.get(key) ?? null;
      const to = after.get(key) ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changes.push({ field: `customFields.${key}`, label: labels.get(key) ?? key, from, to });
      }
    }
  }
  return changes;
}

/**
 * Changes a ticket (every member, tickets.work); only the fields given change, and `tags`
 * replaces the list. Reaching resolved or closed needs the "required when resolving" custom
 * fields. Changing the requester also takes their company. Every change goes in the ticket's
 * history. Deleted tickets must be restored first.
 */
export async function updateTicket(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
  changes: TicketInput,
): Promise<TicketView> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticket = await lockTicketForChange(models, number, transaction);
    const previousStatus = ticket.status;
    const made = await applyTicketChanges(deps, signedIn, ticket, changes, transaction);
    await afterMemberChange(deps, ticket, made, previousStatus, transaction);
    return readTicket(deps, number, transaction);
  });
}

/** The ticket, locked for this transaction; 404 when missing, 409 when in the trash or merged (F28). */
export async function lockTicketForChange(
  models: TicketModels,
  number: number,
  transaction: Transaction,
): Promise<TicketRecord> {
  const ticket = await findTicket(models, number, transaction, true);
  if (ticket.deletedAt) throw new ConflictError('This ticket is deleted. Restore it first.');
  if (ticket.mergedIntoId) {
    const main = await models.Ticket.findByPk(ticket.mergedIntoId, {
      attributes: ['number'],
      transaction,
    });
    throw new ConflictError(
      `This ticket was merged into #${String(main?.number ?? '')}. Work on that one instead.`,
    );
  }
  return ticket;
}

/**
 * Checks and saves changes to a locked ticket inside the caller's transaction, with a history
 * entry. Shared by "change a ticket" and by replies that also set the status (F11). Returns
 * the changes made (empty when nothing changed).
 */
export async function applyTicketChanges(
  deps: Deps,
  signedIn: ChangeActor,
  ticket: TicketRecord,
  changes: TicketInput,
  transaction: Transaction,
): Promise<ActivityChange[]> {
  const models = ticketModels(deps.db.writer);
  const previousStatus = ticket.status;
  const before = {
    status: ticket.status,
    priority: ticket.priority,
    statusChangedAt: ticket.statusChangedAt,
  };
  const status = changes.status ?? ticket.status;
  const reaching = DONE.includes(status) && !DONE.includes(ticket.status);
  const cleaned = changes.tags ? cleanTags(changes.tags) : null;
  const problems: Problem[] = [...(cleaned?.problems ?? [])];
  if (changes.teamId !== undefined) {
    problems.push(...(await checkTeam(deps, changes.teamId, transaction)));
  }
  if (changes.assigneeUserId !== undefined && changes.assigneeUserId !== ticket.assigneeUserId) {
    problems.push(
      ...(await checkAssignee(
        deps,
        signedIn,
        ticket.assigneeUserId,
        changes.assigneeUserId,
        transaction,
      )),
    );
  }
  let companyId = ticket.companyId;
  if (changes.contactId && changes.contactId !== ticket.contactId) {
    const contact = await contactModels(deps.db.writer).Contact.findByPk(changes.contactId, {
      attributes: ['id', 'companyId'],
      transaction,
    });
    if (contact) companyId = contact.companyId;
    else problems.push({ field: 'contactId', message: 'This contact no longer exists.' });
  }
  const definitions = await fieldDefinitions(deps, 'ticket', transaction);
  // Reaching resolved or closed checks every "required when resolving" field, even when custom
  // fields are not part of this change.
  const custom = customFieldCheck(() =>
    checkCustomFieldValues(definitions, changes.customFields, {
      existing: ticket.customFields,
      resolving: reaching,
    }),
  );
  problems.push(...custom.problems);
  refuse(problems);

  const next: Partial<TicketRecord> = {
    ...(changes.subject !== undefined ? { subject: changes.subject.trim() } : {}),
    ...(changes.status !== undefined ? { status: changes.status } : {}),
    ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
    ...(changes.type !== undefined ? { type: changes.type } : {}),
    ...(changes.teamId !== undefined ? { teamId: changes.teamId } : {}),
    ...(changes.contactId !== undefined ? { contactId: changes.contactId, companyId } : {}),
    ...(changes.assigneeUserId !== undefined ? { assigneeUserId: changes.assigneeUserId } : {}),
    ...(changes.customFields !== undefined && custom.values ? { customFields: custom.values } : {}),
  };
  const labels = new Map(definitions.map((field) => [field.key, field.label]));
  const described = await describeChanges(deps, ticket, next, labels, transaction);
  const tagChange = cleaned ? await saveTags(models, ticket, cleaned.tags, transaction) : null;
  if (tagChange && (tagChange.added.length > 0 || tagChange.removed.length > 0)) {
    described.push({ field: 'tags', from: tagChange.removed, to: tagChange.added });
  }
  if (described.length === 0) return [];

  ticket.set({ ...next, ...(status !== ticket.status ? statusTimes(status, ticket) : {}) });
  // A tag-only change still marks the ticket as updated (lists sort by it).
  ticket.changed('updatedAt', true);
  await ticket.save({ transaction });
  await recordActivity(models, signedIn, ticket, 'updated', described, transaction);
  await updateSla(deps, ticket, transaction, before);
  if (described.some((change) => change.field === 'assignee')) {
    await queueAssignmentEmail(deps, signedIn, ticket, transaction);
  }
  if (status === 'resolved' && previousStatus !== 'resolved') {
    await queueCustomerEmail(deps, ticket, 'resolved', transaction);
  }
  return described;
}

/**
 * What a member's change touched, as rules name it (F19): status, priority, type, team, assignee,
 * requester, subject, tags, or custom_fields for any custom field.
 */
export const changedFields = (changes: ActivityChange[]): string[] => [
  ...new Set(
    changes.map((change) =>
      change.field.startsWith('customFields.')
        ? 'custom_fields'
        : change.field === 'contact'
          ? 'requester'
          : change.field,
    ),
  ),
];

/**
 * A member changed a ticket: the "ticket is changed" rules run (F19), told what changed and what
 * the status was. Changes made by rules do not come here, so rules never start rules.
 */
export async function afterMemberChange(
  deps: Deps,
  ticket: TicketRecord,
  changes: ActivityChange[],
  previousStatus: TicketStatus,
  transaction: Transaction,
): Promise<void> {
  if (changes.length === 0) return;
  await runRules(deps, 'ticket_updated', ticket, transaction, {
    changed: changedFields(changes),
    previousStatus,
  });
}

/** An audit entry for a ticket moved to or out of the trash. */
function auditTicket(
  deps: Deps,
  signedIn: SignedIn,
  ticket: TicketRecord,
  action: 'ticket.deleted' | 'ticket.restored',
  transaction: Transaction,
) {
  return recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action,
      target: {
        type: 'ticket',
        id: ticket.id,
        label: `#${String(ticket.number)} ${ticket.subject}`,
      },
      meta: signedIn.meta,
    },
    transaction,
  );
}

/** Moves a ticket to the trash (admins, tickets.delete): hidden from lists, kept, restorable. */
export async function deleteTicket(deps: Deps, signedIn: SignedIn, number: number): Promise<void> {
  requirePermission(signedIn, 'tickets.delete');
  const models = ticketModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticket = await findTicket(models, number, transaction, true);
    if (ticket.deletedAt) return;
    await ticket.update({ deletedAt: new Date() }, { transaction });
    await recordActivity(models, signedIn, ticket, 'deleted', [], transaction);
    await auditTicket(deps, signedIn, ticket, 'ticket.deleted', transaction);
  });
}

/** Brings a ticket back from the trash (admins). Returns it. */
export async function restoreTicket(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
): Promise<TicketView> {
  requirePermission(signedIn, 'tickets.delete');
  const models = ticketModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticket = await findTicket(models, number, transaction, true);
    if (ticket.deletedAt) {
      await ticket.update({ deletedAt: null }, { transaction });
      await recordActivity(models, signedIn, ticket, 'restored', [], transaction);
      await auditTicket(deps, signedIn, ticket, 'ticket.restored', transaction);
    }
    return readTicket(deps, number, transaction);
  });
}

export interface ActivityView {
  id: string;
  at: Date;
  actor: { userId: string | null; name: string };
  action: 'created' | 'updated' | 'deleted' | 'restored';
  changes: ActivityChange[];
}

/** A ticket's history, oldest first (every member). Reads the writer, like the ticket. */
export async function ticketActivity(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
): Promise<ActivityView[]> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticket = await findTicket(models, number, transaction);
    const rows = await models.TicketActivity.findAll({
      where: { ticketId: ticket.id },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction,
    });
    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      actor: { userId: row.actorUserId, name: row.actorName },
      action: row.action,
      changes: row.changes,
    }));
  });
}

/** Tags in use that start with `q` (the most used first), for suggestions. */
export async function suggestTags(
  deps: Deps,
  signedIn: SignedIn,
  q: string | undefined,
): Promise<string[]> {
  requirePermission(signedIn, 'tickets.work');
  const prefix = q?.trim().toLowerCase() ?? '';
  return withWorkspace(deps.db.reader, signedIn.workspace.id, async (transaction) => {
    const [rows] = await deps.db.reader.query(
      `SELECT tag FROM ticket_tags
       WHERE workspace_id = :workspaceId AND (:prefix = '' OR starts_with(tag, :prefix))
       GROUP BY tag ORDER BY count(*) DESC, tag LIMIT 10`,
      { replacements: { workspaceId: signedIn.workspace.id, prefix }, transaction },
    );
    return (rows as { tag: string }[]).map((row) => row.tag);
  });
}

// --- Lists ---------------------------------------------------------------------------------------

/**
 * One page of tickets matching the filters, in the chosen order (every member; the trash for
 * admins). Reads the reader. `total` is counted on the first page only. A page costs a fixed
 * number of queries: the tickets, their tags, then the names behind them.
 */
export async function listTickets(
  deps: Deps,
  signedIn: SignedIn,
  filters: TicketFilters,
  page: { cursor?: string | undefined; limit: number; sort?: TicketSort | undefined },
): Promise<{ tickets: TicketSummary[]; nextCursor: string | null; total: number | null }> {
  requirePermission(signedIn, 'tickets.work');
  if (filters.deleted) requirePermission(signedIn, 'tickets.delete');
  const sequelize = deps.db.reader;
  const { Ticket, TicketTag } = ticketModels(sequelize);
  const sort = page.sort ?? 'updated';
  const conditions = filterConditions(sequelize, filters, signedIn.user.id);
  const after = page.cursor ? [afterCursor(sequelize, sort, page.cursor)] : [];

  return withWorkspace(sequelize, signedIn.workspace.id, async (transaction) => {
    const rows = await Ticket.findAll({
      attributes: { include: cursorAttributes(sort) },
      where: { [Op.and]: [...conditions, ...after] },
      order: orderFor(sort),
      limit: page.limit + 1,
      transaction,
    });
    const total = page.cursor
      ? null
      : await Ticket.count({ where: { [Op.and]: conditions }, transaction });
    const tickets = rows.slice(0, page.limit);
    const tags =
      tickets.length > 0
        ? await TicketTag.findAll({
            where: { ticketId: tickets.map((ticket) => ticket.id) },
            transaction,
          })
        : [];
    for (const ticket of tickets) {
      ticket.tags = tags.filter((row) => row.ticketId === ticket.id);
    }
    const last = tickets.at(-1);
    return {
      tickets: await summariesOf(sequelize, tickets, transaction),
      total,
      nextCursor: rows.length > page.limit && last ? encodeCursor(sort, last) : null,
    };
  });
}
