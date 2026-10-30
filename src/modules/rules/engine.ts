import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { QUEUES, type JobQueue } from '../../jobs/queue.js';
import { accountModels } from '../accounts/models.js';
import { contactModels } from '../contacts/models.js';
import { conversationModels } from '../conversation/models.js';
import { teamModels } from '../teams/models.js';
import { ticketModels, type TicketRecord } from '../tickets/models.js';
import { applyTicketChanges, type ChangeActor } from '../tickets/tickets.service.js';
import { changesFrom, type RuleAction } from './actions.js';
import { evaluate, type EventContext, type TicketFacts } from './conditions.js';
import { ruleModels, type RuleEvent, type RuleRecord } from './models.js';

interface Deps {
  db: Database;
  jobs: Pick<JobQueue, 'enqueue'>;
}

/** What a rule may do: work tickets and assign anyone; never more. */
const RULE_PERMISSIONS = ['tickets.work', 'tickets.assign_any'] as const;

/** A rule as the one making a change: "Rule: Billing to Accounts" in the ticket history. */
export const ruleActor = (rule: { name: string }): ChangeActor => ({
  user: { id: null, name: `Rule: ${rule.name}` },
  permissions: RULE_PERMISSIONS,
});

/**
 * The ticket as rules see it, read inside the transaction: its fields, its tags (reloaded, since a
 * rule may just have changed them), the requester's email and fields and their company's fields.
 */
export async function factsOf(
  deps: { db: Database },
  ticket: TicketRecord,
  transaction: Transaction,
  context: EventContext = {},
): Promise<TicketFacts> {
  const { TicketTag } = ticketModels(deps.db.writer);
  const { Contact, Company } = contactModels(deps.db.writer);
  ticket.tags = await TicketTag.findAll({ where: { ticketId: ticket.id }, transaction });
  const contact = await Contact.findByPk(ticket.contactId, {
    attributes: ['email', 'customFields'],
    transaction,
  });
  const company = ticket.companyId
    ? await Company.findByPk(ticket.companyId, { attributes: ['customFields'], transaction })
    : null;
  return {
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    type: ticket.type,
    source: ticket.source,
    teamId: ticket.teamId,
    assigneeUserId: ticket.assigneeUserId,
    companyId: ticket.companyId,
    requesterEmail: contact?.email ?? null,
    tags: ticket.tags.map((row) => row.tag),
    ticketFields: ticket.customFields,
    contactFields: contact?.customFields ?? {},
    companyFields: company?.customFields ?? {},
    changed: context.changed ?? [],
    previousStatus: context.previousStatus ?? null,
    message: context.message ?? '',
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    statusChangedAt: ticket.statusChangedAt,
    now: context.now ?? new Date(),
  };
}

/**
 * The team member whose turn it is (F18): active members in the order they joined the team, the
 * one after whoever got the last ticket, going round. The team row is locked meanwhile, so two
 * tickets arriving at once never go to the same person by accident. Null when nobody active is in
 * the team.
 */
export async function nextInTurn(
  deps: { db: Database },
  teamId: string,
  transaction: Transaction,
): Promise<{ teamName: string; userId: string | null }> {
  const { Team, TeamMember } = teamModels(deps.db.writer);
  const team = await Team.findByPk(teamId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!team) return { teamName: 'the team', userId: null };
  const members = await TeamMember.findAll({
    where: { teamId },
    order: [
      ['createdAt', 'ASC'],
      ['userId', 'ASC'],
    ],
    transaction,
  });
  const active = new Set(
    (
      await accountModels(deps.db.writer).Membership.findAll({
        attributes: ['userId'],
        where: {
          workspaceId: team.workspaceId,
          userId: members.map((member) => member.userId),
          status: 'active',
        },
        transaction,
      })
    ).map((membership) => membership.userId),
  );
  const eligible = members.map((member) => member.userId).filter((id) => active.has(id));
  if (eligible.length === 0) return { teamName: team.name, userId: null };
  const last = eligible.indexOf(team.roundRobinLastUserId ?? '');
  const next = eligible[(last + 1) % eligible.length] ?? null;
  await team.update({ roundRobinLastUserId: next }, { transaction });
  return { teamName: team.name, userId: next };
}

/** A private note on the ticket, written by the rule. */
async function addNote(
  deps: Deps,
  ticket: TicketRecord,
  author: string,
  text: string,
  transaction: Transaction,
) {
  await conversationModels(deps.db.writer).TicketMessage.create(
    {
      id: newId(),
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      kind: 'note',
      bodyText: text,
      bodyHtml: null,
      authorUserId: null,
      authorContactId: null,
      authorName: author,
      toEmails: [],
      ccEmails: [],
      mentionedUserIds: [],
      emailStatus: null,
    },
    { transaction },
  );
}

/**
 * Applies one rule's actions to a ticket, with the same checks as a member's change. A change the
 * ticket refuses (for example resolving it while a required field is empty) is skipped, and the
 * rule says so in a private note instead of failing the save that started it.
 */
export async function applyRule(
  deps: Deps,
  rule: { name: string; actions: RuleAction[] },
  ticket: TicketRecord,
  tags: string[],
  transaction: Transaction,
): Promise<void> {
  const actor = ruleActor(rule);
  const { changes, notes, emails } = changesFrom(rule.actions, tags);
  // "Assign in turn" picks the person here, unless a later action sets the assignee itself.
  const assigning = rule.actions.filter(
    (action) => action.type === 'assign_in_turn' || action.type === 'set_assignee',
  );
  const inTurn = assigning.at(-1);
  if (inTurn?.type === 'assign_in_turn') {
    const teamId = Array.isArray(inTurn.value) ? (inTurn.value[0] ?? '') : inTurn.value;
    const turn = await nextInTurn(deps, teamId, transaction);
    if (turn.userId) changes.assigneeUserId = turn.userId;
    else {
      notes.push(
        `Nobody in ${turn.teamName} can take tickets right now, so this ticket was left unassigned.`,
      );
    }
  }
  try {
    await applyTicketChanges(deps, actor, ticket, changes, transaction);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const reasons =
      error instanceof ValidationError
        ? ((error.details as { fields?: { message: string }[] } | undefined)?.fields ?? []).map(
            (field) => field.message,
          )
        : [];
    notes.push(
      `This rule could not change the ticket: ${(reasons.length > 0 ? reasons : [error.message]).join(' ')}`,
    );
  }
  for (const email of emails) {
    if (email.to === 'requester') {
      const problem = await emailRequester(deps, ticket, actor.user.name, email.text, transaction);
      if (problem) notes.push(problem);
    } else {
      await deps.jobs.enqueue(
        QUEUES.teamEmail,
        {
          workspaceId: ticket.workspaceId,
          ticketId: ticket.id,
          to: email.to,
          ruleName: rule.name,
          text: email.text,
        },
        transaction,
      );
    }
  }
  for (const note of notes) await addNote(deps, ticket, actor.user.name, note, transaction);
}

/**
 * A rule's email to the requester (F19): a reply on the ticket by "Rule: <name>", sent like any
 * reply (from the workspace address, threaded), so the team sees what the customer got. Returns
 * why it could not be sent, if so.
 */
async function emailRequester(
  deps: Deps,
  ticket: TicketRecord,
  author: string,
  text: string,
  transaction: Transaction,
): Promise<string | null> {
  const requester = await contactModels(deps.db.writer).Contact.findByPk(ticket.contactId, {
    attributes: ['email'],
    transaction,
  });
  if (!requester?.email) {
    return 'This rule could not email the requester: they have no email address.';
  }
  const message = await conversationModels(deps.db.writer).TicketMessage.create(
    {
      id: newId(),
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      kind: 'reply',
      bodyText: text,
      bodyHtml: null,
      authorUserId: null,
      authorContactId: null,
      authorName: author,
      toEmails: [requester.email],
      ccEmails: [],
      mentionedUserIds: [],
      emailStatus: 'queued',
    },
    { transaction },
  );
  await deps.jobs.enqueue(
    QUEUES.ticketEmail,
    { workspaceId: ticket.workspaceId, messageId: message.id },
    transaction,
  );
  return null;
}

/** The enabled rules for an event, in order. */
export function rulesFor(
  deps: { db: Database },
  event: RuleEvent,
  transaction: Transaction,
): Promise<RuleRecord[]> {
  return ruleModels(deps.db.writer).AutomationRule.findAll({
    where: { event, enabled: true },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
}

/**
 * Runs a workspace's rules for an event on one ticket, inside the transaction that caused it
 * (F17): top to bottom, each seeing what earlier rules changed, until one says "stop here".
 * Changes made by rules do not start rules again, so rules cannot loop.
 */
export async function runRules(
  deps: Deps,
  event: RuleEvent,
  ticket: TicketRecord,
  transaction: Transaction,
  context: EventContext = {},
): Promise<void> {
  const rules = await rulesFor(deps, event, transaction);
  for (const rule of rules) {
    const facts = await factsOf(deps, ticket, transaction, context);
    if (!evaluate(rule.conditions, facts).matched) continue;
    await applyRule(deps, rule, ticket, facts.tags, transaction);
    if (rule.stopAfter) break;
  }
}
