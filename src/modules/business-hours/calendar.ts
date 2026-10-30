/**
 * Working time (F22): which moments count when an SLA clock runs in business hours (F23). Pure
 * functions over a workspace calendar; times are milliseconds since 1970 (UTC instants), days and
 * hours are the workspace's local ones.
 */

/** One stretch of time, from (inclusive) to (exclusive), in milliseconds. */
export type Interval = readonly [from: number, to: number];

export interface Calendar {
  timeZone: string;
  /** 24×7: every moment counts, holidays too. */
  alwaysOpen: boolean;
  /** Monday first: the working minutes of the day [start, end), or null when closed. */
  days: readonly (readonly [start: number, end: number] | null)[];
  /** Days off, "2026-12-25". */
  holidays: ReadonlySet<string>;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;
/** How far ahead to look for working time: a calendar is checked to have some every week. */
const MAX_DAYS = 3 * 366;

export class NoWorkingTimeError extends Error {
  constructor() {
    super('The business hours have no working time ahead.');
  }
}

/** How far the time zone is ahead of UTC at that moment, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    parts.get('year') ?? 1970,
    (parts.get('month') ?? 1) - 1,
    parts.get('day') ?? 1,
    parts.get('hour') ?? 0,
    parts.get('minute') ?? 0,
    parts.get('second') ?? 0,
  );
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The local day ("2026-10-28") and minute of the day of an instant. */
export function localTime(at: number, timeZone: string): { day: string; minute: number } {
  const local = new Date(at + zoneOffset(at, timeZone));
  return {
    day: local.toISOString().slice(0, 10),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** The instant of a local wall-clock time; two passes settle days when the clocks change. */
export function instantAt(day: string, minute: number, timeZone: string): number {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  const guess = Date.UTC(year, month - 1, date) + minute * MINUTE_MS;
  const first = guess - zoneOffset(guess, timeZone);
  return guess - zoneOffset(first, timeZone);
}

export const nextDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/** 0 for Monday to 6 for Sunday. */
export const weekdayOf = (day: string): number =>
  (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

/** The working window of one local day, or null when it is closed or a holiday. */
function windowOf(day: string, calendar: Calendar): Interval | null {
  if (calendar.holidays.has(day)) return null;
  const hours = calendar.days[weekdayOf(day)];
  if (!hours) return null;
  const [start, end] = hours;
  const from = instantAt(day, start, calendar.timeZone);
  const to =
    end >= 1440
      ? instantAt(nextDay(day), end - 1440, calendar.timeZone)
      : instantAt(day, end, calendar.timeZone);
  return to > from ? [from, to] : null;
}

/** Working time from `start` on, window by window; 24×7 is one endless window. */
export function* workingWindows(start: number, calendar: Calendar): Generator<Interval> {
  if (calendar.alwaysOpen) {
    yield [start, Infinity];
    return;
  }
  let day = localTime(start, calendar.timeZone).day;
  for (let count = 0; count < MAX_DAYS; count += 1) {
    const window = windowOf(day, calendar);
    if (window && window[1] > start) yield [Math.max(window[0], start), window[1]];
    day = nextDay(day);
  }
  throw new NoWorkingTimeError();
}

/** Every moment from `start` on: the round-the-clock time an SLA can also count in. */
export function* allTime(start: number): Generator<Interval> {
  yield [start, Infinity];
}

/** The windows with the paused stretches taken out. */
export function* without(
  windows: Iterable<Interval>,
  pauses: readonly Interval[],
): Generator<Interval> {
  const sorted = [...pauses].sort((a, b) => a[0] - b[0]);
  for (const [from, to] of windows) {
    let cursor = from;
    for (const [pauseFrom, pauseTo] of sorted) {
      if (pauseTo <= cursor || pauseFrom >= to) continue;
      if (pauseFrom > cursor) yield [cursor, pauseFrom];
      cursor = Math.max(cursor, pauseTo);
      if (cursor >= to) break;
    }
    if (cursor < to) yield [cursor, to];
  }
}

/**
 * The moment `minutes` of counted time have passed, counting only inside the windows. When the
 * time runs out exactly at the end of a window, `atEnd: 'next'` gives the start of the next window
 * instead (the same counted time: a whole working day ends at the next day's opening).
 */
export function addCountedMinutes(
  windows: Iterable<Interval>,
  minutes: number,
  atEnd: 'end' | 'next' = 'end',
): number {
  let left = minutes * MINUTE_MS;
  let usedUp = false;
  for (const [from, to] of windows) {
    if (usedUp) return from;
    if (to - from > left || (to - from === left && atEnd === 'end')) return from + left;
    left -= to - from;
    usedUp = left === 0;
  }
  throw new NoWorkingTimeError();
}

/** Counted minutes from the start of the windows up to `until` (whole and part minutes). */
export function countedMinutesUntil(windows: Iterable<Interval>, until: number): number {
  let total = 0;
  for (const [from, to] of windows) {
    if (from >= until) break;
    total += Math.min(to, until) - from;
  }
  return total / MINUTE_MS;
}

/** Whether the moment is inside working time. */
export function isWorkingTime(at: number, calendar: Calendar): boolean {
  const first = workingWindows(at, calendar).next();
  return !first.done && first.value[0] === at;
}

/**
 * The same time of day `days` working days later (F23 targets in days): from the next working
 * moment, skipping closed days and holidays, held inside that day's hours. 24×7 counts whole days.
 */
export function addWorkingDays(start: number, days: number, calendar: Calendar): number {
  if (calendar.alwaysOpen) return start + days * DAY_MS;
  const first = workingWindows(start, calendar).next();
  if (first.done) throw new NoWorkingTimeError();
  const { day: firstDay, minute } = localTime(first.value[0], calendar.timeZone);
  let day = firstDay;
  let window: Interval | null = null;
  for (let counted = 0, step = 0; counted < days; step += 1) {
    if (step >= MAX_DAYS) throw new NoWorkingTimeError();
    day = nextDay(day);
    window = windowOf(day, calendar);
    if (window) counted += 1;
  }
  if (!window) return first.value[0];
  const at = instantAt(day, minute, calendar.timeZone);
  return Math.min(Math.max(at, window[0]), window[1]);
}
