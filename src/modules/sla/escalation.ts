import { Op, QueryTypes, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import type { JobQueue } from '../../jobs/queue.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { notifyMembers } from '../notifications/notify.js';
import { teamModels } from '../teams/models.js';
import { ticketModels, type TicketRecord } from '../tickets/models.js';
import { applyTicketChanges, type ChangeActor } from '../tickets/tickets.service.js';
import {
  alertKey,
  anchorOf,
  DEFAULT_ESCALATION,
  dueAlerts,
  nextAlertAt,
  type Escalation,
  type SlaTargetName,
} from './clock.js';
import { slaModels } from './models.js';

interface Deps {
  db: Database;
  jobs: Pick<JobQueue, 'enqueue'>;
}

/** Tickets one workspace's check looks at per run, the most urgent first. */
export const MAX_TICKETS_PER_CHECK = 500;

/** What an escalation may do to a ticket: reassign it, like a supervisor. */
const SLA_PERMISSIONS = ['tickets.work', 'tickets.assign_any'] as const;

const slaActor = (policyName: string): ChangeActor => ({
  user: { id: null, name: `SLA: ${policyName}` },
  permissions: SLA_PERMISSIONS,
});

/** The active members among these people, in the same order. */
async function activeOnly(
  deps: Deps,
  workspaceId: string,
  userIds: string[],
  transaction: Transaction,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const active = await accountModels(deps.db.writer).Membership.findAll({
    attributes: ['userId'],
    where: { workspaceId, userId: userIds, status: 'active' },
    transaction,
  });
  const ids = new Set(active.map((membership) => membership.userId));
  return userIds.filter((id) => ids.has(id));
}

/** The leads of the ticket's team (in the order they joined it); the admins without one. */
async function leadsOf(deps: Deps, ticket: TicketRecord, transaction: Transaction) {
  const leads = ticket.teamId
    ? await activeOnly(
        deps,
        ticket.workspaceId,
        (
          await teamModels(deps.db.writer).TeamMember.findAll({
            attributes: ['userId'],
            where: { teamId: ticket.teamId, isLead: true },
            order: [
              ['createdAt', 'ASC'],
              ['userId', 'ASC'],
            ],
            transaction,
          })
        ).map((member) => member.userId),
        transaction,
      )
    : [];
  if (leads.length > 0) return leads;
  const admins = await accountModels(deps.db.writer).Membership.findAll({
    attributes: ['userId'],
    where: { workspaceId: ticket.workspaceId, role: 'admin', status: 'active' },
    transaction,
  });
  return admins.map((admin) => admin.userId);
}

/** "17:30" today, or "29 Oct, 17:30", in the workspace's time zone. */
function timeText(at: Date, timeZone: string, now: Date): string {
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(at);
  return `${date}, ${time}`;
}

const what = (target: SlaTargetName) => (target === 'reply' ? 'first reply' : 'resolve time');

/** The person an escalation hands the ticket to: undefined to leave it, null for nobody. */
async function newAssignee(
  deps: Deps,
  ticket: TicketRecord,
  escalation: Escalation,
  transaction: Transaction,
): Promise<string | null | undefined> {
  switch (escalation.reassign) {
    case 'nobody':
      return undefined;
    case 'team':
      return ticket.assigneeUserId ? null : undefined;
    case 'person': {
      const [person] = await activeOnly(
        deps,
        ticket.workspaceId,
        escalation.reassignUserId ? [escalation.reassignUserId] : [],
        transaction,
      );
      return person && person !== ticket.assigneeUserId ? person : undefined;
    }
    case 'team_lead': {
      if (!ticket.teamId) return undefined;
      const leads = await activeOnly(
        deps,
        ticket.workspaceId,
        (
          await teamModels(deps.db.writer).TeamMember.findAll({
            attributes: ['userId'],
            where: { teamId: ticket.teamId, isLead: true },
            order: [
              ['createdAt', 'ASC'],
              ['userId', 'ASC'],
            ],
            transaction,
          })
        ).map((member) => member.userId),
        transaction,
      );
      return leads.find((lead) => lead !== ticket.assigneeUserId);
    }
  }
}

/** A deadline passed: the history says so, the ticket may be reassigned, the leads are told. */
async function escalate(
  deps: Deps,
  ticket: TicketRecord,
  target: SlaTargetName,
  dueAt: Date,
  policy: { name: string; escalation: Escalation },
  timeZone: string,
  now: Date,
  transaction: Transaction,
) {
  const actor = slaActor(policy.name);
  await ticketModels(deps.db.writer).TicketActivity.create(
    {
      id: newId(),
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      actorUserId: null,
      actorName: actor.user.name,
      action: 'updated',
      changes: [{ field: 'sla', from: null, to: `${target}_overdue` }],
    },
    { transaction },
  );
  const ref = `#${String(ticket.number)}`;
  let outcome = '';
  const assignee = await newAssignee(deps, ticket, policy.escalation, transaction);
  if (assignee !== undefined) {
    try {
      await applyTicketChanges(deps, actor, ticket, { assigneeUserId: assignee }, transaction);
      if (assignee) {
        const person = await accountModels(deps.db.writer).User.findByPk(assignee, {
          attributes: ['name'],
        });
        outcome = ` It was reassigned to ${person?.name ?? 'a team lead'}.`;
      } else {
        outcome = ' It is back with the team, unassigned.';
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      outcome = ' It could not be reassigned.';
    }
  }
  await notifyMembers(
    deps,
    {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      kind: 'sla_breach',
      userIds: await leadsOf(deps, ticket, transaction),
      subject: `Ticket ${ref} is overdue`,
      text: `Ticket ${ref} is overdue: the ${what(target)} was due at ${timeText(dueAt, timeZone, now)}.${outcome}`,
    },
    transaction,
  );
}

/** A deadline is near: the assignee is warned, or the team's leads when nobody has it. */
async function warn(
  deps: Deps,
  ticket: TicketRecord,
  target: SlaTargetName,
  dueAt: Date,
  timeZone: string,
  now: Date,
  transaction: Transaction,
) {
  const assignee = await activeOnly(
    deps,
    ticket.workspaceId,
    ticket.assigneeUserId ? [ticket.assigneeUserId] : [],
    transaction,
  );
  const minutes = Math.max(1, Math.round((dueAt.getTime() - now.getTime()) / 60_000));
  const ref = `#${String(ticket.number)}`;
  const left = `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  await notifyMembers(
    deps,
    {
      workspaceId: ticket.workspaceId,
      ticketId: ticket.id,
      kind: 'sla_warning',
      userIds: assignee.length > 0 ? assignee : await leadsOf(deps, ticket, transaction),
      subject:
        target === 'reply'
          ? `Ticket ${ref}: first reply due in ${left}`
          : `Ticket ${ref}: resolve time in ${left}`,
      text:
        target === 'reply'
          ? `The first reply to ticket ${ref} is due in ${left}, at ${timeText(dueAt, timeZone, now)}.`
          : `Ticket ${ref} should be resolved in ${left}, by ${timeText(dueAt, timeZone, now)}.`,
    },
    transaction,
  );
}

/** One ticket's due warnings and escalations, each once, in its own transaction. */
async function checkTicket(
  deps: Deps,
  workspaceId: string,
  ticketId: string,
  timeZone: string,
  now: Date,
): Promise<number> {
  return withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(ticketId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!ticket || ticket.deletedAt) return 0;
    const { SlaPolicy } = slaModels(deps.db.writer);
    const policy =
      (ticket.slaPolicyId ? await SlaPolicy.findByPk(ticket.slaPolicyId, { transaction }) : null) ??
      (await SlaPolicy.findOne({ where: { isDefault: true }, transaction }));
    const settings = {
      name: policy?.name ?? 'Default policy',
      escalation: policy?.escalation ?? DEFAULT_ESCALATION,
    };
    const alerts = dueAlerts(ticket, settings.escalation.warnMinutes, now);
    for (const alert of alerts) {
      // Recorded first, so a change made by the escalation does not raise it again.
      ticket.slaAlerts = {
        ...ticket.slaAlerts,
        [alertKey(alert.target, alert.kind)]: anchorOf(ticket, alert.target),
      };
      if (alert.kind === 'warning') {
        await warn(deps, ticket, alert.target, alert.dueAt, timeZone, now, transaction);
      } else {
        await escalate(
          deps,
          ticket,
          alert.target,
          alert.dueAt,
          settings,
          timeZone,
          now,
          transaction,
        );
      }
    }
    ticket.slaAlertAt = nextAlertAt(ticket, settings.escalation.warnMinutes);
    await ticket.save({ transaction, silent: true });
    return alerts.length;
  });
}

/**
 * The SLA check (the worker's sla-check job, every minute, F24). For each workspace with a
 * warning or escalation due (`tickets.sla_alert_at`), it warns before a deadline and escalates
 * at it: each once per ticket and clock. Returns how many were done.
 */
export async function runSlaChecks(deps: Deps, now: Date = new Date()): Promise<number> {
  const workspaces = await deps.db.writer.query<{ id: string }>(
    'SELECT workspaces_with_sla_alerts AS id FROM workspaces_with_sla_alerts(:now)',
    { replacements: { now }, type: QueryTypes.SELECT },
  );
  let done = 0;
  for (const { id: workspaceId } of workspaces) {
    done += await checkWorkspace(deps, workspaceId, now);
  }
  return done;
}

/** The SLA check for one workspace: its tickets with a warning or escalation due by `now`. */
export async function checkWorkspace(deps: Deps, workspaceId: string, now: Date): Promise<number> {
  const workspace = await accountModels(deps.db.writer).Workspace.findByPk(workspaceId, {
    attributes: ['timezone'],
  });
  const tickets = await withWorkspace(deps.db.writer, workspaceId, (transaction) =>
    ticketModels(deps.db.writer).Ticket.findAll({
      attributes: ['id'],
      where: { deletedAt: null, slaAlertAt: { [Op.lte]: now } },
      order: [['slaAlertAt', 'ASC']],
      limit: MAX_TICKETS_PER_CHECK,
      transaction,
    }),
  );
  let done = 0;
  for (const ticket of tickets) {
    done += await checkTicket(deps, workspaceId, ticket.id, workspace?.timezone ?? 'UTC', now);
  }
  return done;
}
