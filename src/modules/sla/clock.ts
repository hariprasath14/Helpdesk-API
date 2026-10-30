import {
  addCountedMinutes,
  addWorkingDays,
  allTime,
  countedMinutesUntil,
  without,
  workingWindows,
  type Calendar,
  type Interval,
} from '../business-hours/calendar.js';
import type { SlaPause, TicketPriority, TicketStatus } from '../tickets/models.js';

/**
 * SLA clocks (F23): due times from a policy's targets, and how a ticket stands against them. Pure
 * functions; the service reads and saves.
 */

export const DURATION_UNITS = ['minutes', 'hours', 'days'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export interface Duration {
  amount: number;
  unit: DurationUnit;
}

/** Business hours (F22) or every hour of the day. */
export const SLA_HOURS = ['business', 'calendar'] as const;
export type SlaHours = (typeof SLA_HOURS)[number];

/** One priority's targets: first reply and resolve, and which hours they count. */
export interface PriorityTarget {
  reply: Duration;
  resolve: Duration;
  hours: SlaHours;
}

export type SlaTargets = Record<TicketPriority, PriorityTarget>;

const hours = (amount: number): Duration => ({ amount, unit: 'hours' });
const days = (amount: number): Duration => ({ amount, unit: 'days' });

/** The starting values of a workspace's default policy, all in business hours. */
export const DEFAULT_TARGETS: SlaTargets = {
  urgent: { reply: hours(1), resolve: hours(4), hours: 'business' },
  high: { reply: hours(4), resolve: days(1), hours: 'business' },
  medium: { reply: hours(8), resolve: days(3), hours: 'business' },
  low: { reply: days(1), resolve: days(5), hours: 'business' },
};

/** Statuses where the clocks have stopped. */
const DONE: readonly TicketStatus[] = ['resolved', 'closed'];
/** The status where the clocks pause. */
export const PAUSED_STATUS: TicketStatus = 'waiting_on_customer';

const intervalsOf = (pauses: readonly SlaPause[]): Interval[] =>
  pauses.map((pause) => [Date.parse(pause.from), Date.parse(pause.to)] as const);

/**
 * When a target falls due, counting from `start` in the target's hours and leaving the paused
 * stretches out. In business hours a day is a working day: the same time on the next working day.
 */
export function dueAfter(
  start: Date,
  duration: Duration,
  counting: SlaHours,
  calendar: Calendar,
  pauses: readonly SlaPause[],
): Date {
  const begin = start.getTime();
  const windows = () =>
    counting === 'business' ? workingWindows(begin, calendar) : allTime(begin);
  let minutes: number;
  if (duration.unit === 'days') {
    minutes =
      counting === 'business'
        ? countedMinutesUntil(windows(), addWorkingDays(begin, duration.amount, calendar))
        : duration.amount * 1440;
  } else {
    minutes = duration.unit === 'hours' ? duration.amount * 60 : duration.amount;
  }
  // Whole working days end at an opening (Thursday 09:00), not the closing before it.
  const atEnd = duration.unit === 'days' ? 'next' : 'end';
  return new Date(addCountedMinutes(without(windows(), intervalsOf(pauses)), minutes, atEnd));
}

/** What the clocks look at on a ticket. */
export interface SlaTicket {
  status: TicketStatus;
  createdAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  slaReplyDueAt: Date | null;
  slaResolveDueAt: Date | null;
  slaResolveFrom: Date | null;
  slaPauses: SlaPause[];
}

/** The reply and resolve due times for a ticket under one priority's targets. */
export function dueTimes(
  ticket: SlaTicket,
  target: PriorityTarget,
  calendar: Calendar,
): { reply: Date; resolve: Date } {
  return {
    reply: dueAfter(ticket.createdAt, target.reply, target.hours, calendar, ticket.slaPauses),
    resolve: dueAfter(
      ticket.slaResolveFrom ?? ticket.createdAt,
      target.resolve,
      target.hours,
      calendar,
      ticket.slaPauses,
    ),
  };
}

/**
 * The next deadline still running: the reply until there is one, and the resolve time. None while
 * waiting on the customer or once resolved.
 */
export function nextDue(ticket: SlaTicket): { at: Date; target: 'reply' | 'resolve' } | null {
  if (DONE.includes(ticket.status) || ticket.status === PAUSED_STATUS) return null;
  const reply = !ticket.firstResponseAt ? ticket.slaReplyDueAt : null;
  const resolve = ticket.slaResolveDueAt;
  if (reply && (!resolve || reply <= resolve)) return { at: reply, target: 'reply' };
  return resolve ? { at: resolve, target: 'resolve' } : null;
}

/** What happens to a deadline's ticket at the deadline, besides marking it overdue (F24). */
export const REASSIGN_TO = ['nobody', 'team_lead', 'person', 'team'] as const;
export type ReassignTo = (typeof REASSIGN_TO)[number];

/** A policy's warning and escalation (F24). */
export interface Escalation {
  /** Warn this many minutes before each deadline; null for no warning. */
  warnMinutes: number | null;
  /** nobody: keep the assignee; team_lead: a lead of the ticket's team; person: the chosen one;
   * team: back to the team, unassigned. */
  reassign: ReassignTo;
  reassignUserId: string | null;
}

export const DEFAULT_ESCALATION: Escalation = {
  warnMinutes: 10,
  reassign: 'nobody',
  reassignUserId: null,
};

export type SlaTargetName = 'reply' | 'resolve';
export type AlertKind = 'warning' | 'breach';

/** What the alerts look at, besides the clocks. */
export interface AlertTicket extends SlaTicket {
  slaAlerts: Record<string, string>;
}

/** When a target's clock started: alerts done for an earlier start count again after it. */
export const anchorOf = (ticket: SlaTicket, target: SlaTargetName): string =>
  (target === 'resolve'
    ? (ticket.slaResolveFrom ?? ticket.createdAt)
    : ticket.createdAt
  ).toISOString();

export const alertKey = (target: SlaTargetName, kind: AlertKind) => `${target}:${kind}`;

/** Whether this warning or escalation was already done for the target's current clock. */
export const alertDone = (ticket: AlertTicket, target: SlaTargetName, kind: AlertKind) =>
  ticket.slaAlerts[alertKey(target, kind)] === anchorOf(ticket, target);

/** The deadlines still running: the reply until there is one, and the resolve time. */
export function runningTargets(ticket: SlaTicket): { target: SlaTargetName; dueAt: Date }[] {
  if (DONE.includes(ticket.status) || ticket.status === PAUSED_STATUS) return [];
  const running: { target: SlaTargetName; dueAt: Date }[] = [];
  if (!ticket.firstResponseAt && ticket.slaReplyDueAt) {
    running.push({ target: 'reply', dueAt: ticket.slaReplyDueAt });
  }
  if (ticket.slaResolveDueAt) running.push({ target: 'resolve', dueAt: ticket.slaResolveDueAt });
  return running;
}

/**
 * The warnings and escalations due by `now` and not done yet, in time order. A deadline already
 * passed is escalated without warning first.
 */
export function dueAlerts(
  ticket: AlertTicket,
  warnMinutes: number | null,
  now: Date,
): { target: SlaTargetName; kind: AlertKind; dueAt: Date }[] {
  const alerts: { target: SlaTargetName; kind: AlertKind; dueAt: Date; at: number }[] = [];
  for (const { target, dueAt } of runningTargets(ticket)) {
    if (now >= dueAt) {
      if (!alertDone(ticket, target, 'breach')) {
        alerts.push({ target, kind: 'breach', dueAt, at: dueAt.getTime() });
      }
    } else if (
      warnMinutes !== null &&
      now.getTime() >= dueAt.getTime() - warnMinutes * 60_000 &&
      !alertDone(ticket, target, 'warning')
    ) {
      alerts.push({ target, kind: 'warning', dueAt, at: dueAt.getTime() - warnMinutes * 60_000 });
    }
  }
  return alerts
    .sort((a, b) => a.at - b.at)
    .map(({ target, kind, dueAt }) => ({ target, kind, dueAt }));
}

/** When the next warning or escalation not done yet falls due; null when none will. */
export function nextAlertAt(ticket: AlertTicket, warnMinutes: number | null): Date | null {
  const times: number[] = [];
  for (const { target, dueAt } of runningTargets(ticket)) {
    if (!alertDone(ticket, target, 'breach')) times.push(dueAt.getTime());
    if (warnMinutes !== null && !alertDone(ticket, target, 'warning')) {
      times.push(dueAt.getTime() - warnMinutes * 60_000);
    }
  }
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/** running and overdue count down or up; paused while waiting; met and missed once done. */
export const TARGET_STATES = ['running', 'overdue', 'paused', 'met', 'missed'] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export interface TargetView {
  dueAt: Date;
  state: TargetState;
  /** When it was met or missed: the first reply, or resolving. */
  doneAt: Date | null;
}

function stateOf(dueAt: Date, doneAt: Date | null, status: TicketStatus, now: Date): TargetView {
  if (doneAt) return { dueAt, doneAt, state: doneAt <= dueAt ? 'met' : 'missed' };
  if (status === PAUSED_STATUS) return { dueAt, doneAt: null, state: 'paused' };
  return { dueAt, doneAt: null, state: now > dueAt ? 'overdue' : 'running' };
}

/**
 * How a ticket stands against its first-reply and resolve targets. A ticket resolved without a
 * reply has no reply target to show.
 */
export function targetViews(
  ticket: SlaTicket,
  now: Date,
): { reply: TargetView | null; resolve: TargetView | null } {
  const done = DONE.includes(ticket.status);
  return {
    reply:
      ticket.slaReplyDueAt && (ticket.firstResponseAt || !done)
        ? stateOf(ticket.slaReplyDueAt, ticket.firstResponseAt, ticket.status, now)
        : null,
    resolve: ticket.slaResolveDueAt
      ? stateOf(
          ticket.slaResolveDueAt,
          done ? (ticket.resolvedAt ?? now) : null,
          ticket.status,
          now,
        )
      : null,
  };
}
