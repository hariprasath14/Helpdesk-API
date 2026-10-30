import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit, type AuditRecord } from '../audit/audit.service.js';
import { isWorkingTime, type Calendar } from './calendar.js';
import { businessHoursModels, type DayHours } from './models.js';

interface Deps {
  db: Database;
}

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Holidays one workspace can have. */
export const MAX_HOLIDAYS = 200;

/** Until an admin sets them: Monday to Friday, 09:00 to 18:00. */
export const DEFAULT_DAYS: readonly DayHours[] = WEEKDAYS.map((day) => ({
  open: day !== 'saturday' && day !== 'sunday',
  start: '09:00',
  end: '18:00',
}));

/** "HH:MM" from 00:00 to 23:59, or 24:00 for the end of the day. */
export const TIME_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

const minutesOf = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export interface DayView extends DayHours {
  day: Weekday;
}

export interface HolidayView {
  id: string;
  date: string;
  name: string;
}

export interface BusinessHoursView {
  timeZone: string;
  alwaysOpen: boolean;
  /** Monday first. */
  days: DayView[];
  /** Earliest first. */
  holidays: HolidayView[];
  /** Whether it is working time right now. */
  openNow: boolean;
  /** Saved once; until then the defaults apply (the home checklist, F29). */
  saved: boolean;
}

export interface BusinessHoursInput {
  timeZone: string;
  alwaysOpen: boolean;
  days: DayView[];
}

/** The workspace's working days and holidays as the SLA clocks use them (F23). */
export async function loadCalendar(
  deps: Deps,
  workspaceId: string,
  transaction: Transaction,
): Promise<Calendar> {
  const { BusinessHours, Holiday } = businessHoursModels(deps.db.writer);
  const workspace = await accountModels(deps.db.writer).Workspace.findByPk(workspaceId, {
    attributes: ['timezone'],
    transaction,
  });
  const hours = await BusinessHours.findByPk(workspaceId, { transaction });
  const holidays = hours?.alwaysOpen
    ? []
    : await Holiday.findAll({ attributes: ['date'], transaction });
  return {
    timeZone: workspace?.timezone ?? 'UTC',
    alwaysOpen: hours?.alwaysOpen ?? false,
    days: (hours?.days ?? DEFAULT_DAYS).map((day) =>
      day.open ? ([minutesOf(day.start), minutesOf(day.end)] as const) : null,
    ),
    holidays: new Set(holidays.map((holiday) => holiday.date)),
  };
}

/**
 * Days with the same hours side by side, as people write them: "Mon–Fri 09:00–18:00, Sat
 * 10:00–14:00". For the audit log.
 */
export function hoursSummary(alwaysOpen: boolean, days: readonly DayHours[]): string {
  if (alwaysOpen) return '24 hours, 7 days';
  const short = (index: number) => {
    const name = WEEKDAYS.at(index) ?? '';
    return name.charAt(0).toUpperCase() + name.slice(1, 3);
  };
  const groups: { from: number; to: number; hours: string }[] = [];
  days.forEach((day, index) => {
    if (!day.open) return;
    const hours = `${day.start}–${day.end}`;
    const last = groups.at(-1);
    if (last?.to === index - 1 && last.hours === hours) last.to = index;
    else groups.push({ from: index, to: index, hours });
  });
  if (groups.length === 0) return 'closed every day';
  return groups
    .map(({ from, to, hours }) =>
      from === to
        ? `${short(from)} ${hours}`
        : `${short(from)}${to === from + 1 ? ', ' : '–'}${short(to)} ${hours}`,
    )
    .join(', ');
}

async function readView(deps: Deps, signedIn: SignedIn, transaction: Transaction) {
  const { BusinessHours, Holiday } = businessHoursModels(deps.db.writer);
  const workspace = await accountModels(deps.db.writer).Workspace.findByPk(signedIn.workspace.id, {
    attributes: ['timezone'],
    transaction,
  });
  const hours = await BusinessHours.findByPk(signedIn.workspace.id, { transaction });
  const holidays = await Holiday.findAll({
    order: [['date', 'ASC']],
    transaction,
  });
  const calendar = await loadCalendar(deps, signedIn.workspace.id, transaction);
  return {
    timeZone: workspace?.timezone ?? signedIn.workspace.timezone,
    alwaysOpen: hours?.alwaysOpen ?? false,
    days: (hours?.days ?? DEFAULT_DAYS).map((day, index) => ({
      day: WEEKDAYS.at(index) ?? 'monday',
      open: day.open,
      start: day.start,
      end: day.end,
    })),
    holidays: holidays.map((holiday) => ({
      id: holiday.id,
      date: holiday.date,
      name: holiday.name,
    })),
    openNow: isWorkingTime(Date.now(), calendar),
    saved: hours !== null,
  };
}

/** Settings → Business hours (admins). Reads the writer: the page reloads right after a save. */
export async function getBusinessHours(deps: Deps, signedIn: SignedIn): Promise<BusinessHoursView> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    readView(deps, signedIn, transaction),
  );
}

const audit = (
  deps: Deps,
  signedIn: SignedIn,
  action: AuditRecord['action'],
  target: { id: string | null; label: string },
  details: Record<string, unknown>,
  transaction: Transaction,
) =>
  recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action,
      target: { type: 'workspace', ...target },
      details,
      meta: signedIn.meta,
    },
    transaction,
  );

function checkDays(input: BusinessHoursInput): DayHours[] {
  const problems: { field: string; message: string }[] = [];
  const days = input.days.map((day, index) => {
    const path = `days.${String(index)}`;
    if (day.day !== WEEKDAYS.at(index)) {
      problems.push({ field: `${path}.day`, message: 'List the days from Monday to Sunday.' });
    }
    if (day.start === '24:00') {
      problems.push({ field: `${path}.start`, message: 'Start before midnight.' });
    } else if (day.open && minutesOf(day.end) <= minutesOf(day.start)) {
      problems.push({ field: `${path}.end`, message: 'End after the start time.' });
    }
    return { open: day.open, start: day.start, end: day.end };
  });
  if (!input.alwaysOpen && !days.some((day) => day.open)) {
    problems.push({ field: 'days', message: 'Choose at least one working day, or 24×7.' });
  }
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
  return days;
}

/**
 * Saves the time zone and working hours (admins). The time zone is the workspace's, used
 * everywhere times are shown. Each change is audited. SLA due times already worked out stay;
 * new ones use the new hours (F23).
 */
export async function updateBusinessHours(
  deps: Deps,
  signedIn: SignedIn,
  input: BusinessHoursInput,
): Promise<BusinessHoursView> {
  requirePermission(signedIn, 'settings.manage');
  const days = checkDays(input);
  const { BusinessHours } = businessHoursModels(deps.db.writer);
  const { Workspace } = accountModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const workspace = await Workspace.findByPk(signedIn.workspace.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!workspace) throw new NotFoundError('This workspace does not exist.');
    if (workspace.timezone !== input.timeZone) {
      const from = workspace.timezone;
      await workspace.update({ timezone: input.timeZone }, { transaction });
      await audit(
        deps,
        signedIn,
        'workspace.time_zone_changed',
        { id: workspace.id, label: workspace.name },
        { from, to: input.timeZone },
        transaction,
      );
    }
    const current = await BusinessHours.findByPk(signedIn.workspace.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const before = hoursSummary(current?.alwaysOpen ?? false, current?.days ?? DEFAULT_DAYS);
    const changed =
      current?.alwaysOpen !== input.alwaysOpen ||
      JSON.stringify(current.days) !== JSON.stringify(days);
    if (changed) {
      if (current) {
        await current.update({ alwaysOpen: input.alwaysOpen, days }, { transaction });
      } else {
        await BusinessHours.create(
          { workspaceId: signedIn.workspace.id, alwaysOpen: input.alwaysOpen, days },
          { transaction },
        );
      }
      const after = hoursSummary(input.alwaysOpen, days);
      if (after !== before) {
        await audit(
          deps,
          signedIn,
          'workspace.business_hours_changed',
          { id: workspace.id, label: workspace.name },
          { from: before, to: after },
          transaction,
        );
      }
    }
    return readView(deps, signedIn, transaction);
  });
}

/** Adds a day off (admins); one per date. Audited. */
export async function addHoliday(
  deps: Deps,
  signedIn: SignedIn,
  input: { date: string; name: string },
): Promise<BusinessHoursView> {
  requirePermission(signedIn, 'settings.manage');
  const { Holiday } = businessHoursModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    if ((await Holiday.count({ transaction })) >= MAX_HOLIDAYS) {
      throw new ConflictError(
        `A workspace can have up to ${String(MAX_HOLIDAYS)} holidays. Remove past ones first.`,
      );
    }
    const taken = await Holiday.findOne({ where: { date: input.date }, transaction });
    if (taken) {
      throw new ValidationError('Check the highlighted fields.', {
        fields: [{ field: 'date', message: `This day is already a holiday: ${taken.name}.` }],
      });
    }
    const holiday = await Holiday.create(
      { id: newId(), workspaceId: signedIn.workspace.id, date: input.date, name: input.name },
      { transaction },
    );
    await audit(
      deps,
      signedIn,
      'holiday.added',
      { id: holiday.id, label: holiday.name },
      { date: holiday.date },
      transaction,
    );
    return readView(deps, signedIn, transaction);
  });
}

/** Removes a day off (admins). Audited. */
export async function removeHoliday(
  deps: Deps,
  signedIn: SignedIn,
  holidayId: string,
): Promise<BusinessHoursView> {
  requirePermission(signedIn, 'settings.manage');
  const { Holiday } = businessHoursModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const holiday = await Holiday.findByPk(holidayId, { transaction });
    if (!holiday) throw new NotFoundError('This holiday does not exist.');
    await holiday.destroy({ transaction });
    await audit(
      deps,
      signedIn,
      'holiday.removed',
      { id: holiday.id, label: holiday.name },
      { date: holiday.date },
      transaction,
    );
    return readView(deps, signedIn, transaction);
  });
}
