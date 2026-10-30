import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { DEFAULT_DAYS, hoursSummary } from './business-hours.service.js';
import {
  addCountedMinutes,
  addWorkingDays,
  allTime,
  countedMinutesUntil,
  instantAt,
  isWorkingTime,
  localTime,
  without,
  workingWindows,
  type Calendar,
} from './calendar.js';

const kit = accountsKit();
const { send, teamWorkspace } = kit;

const IST = 'Asia/Kolkata';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

/** Monday to Friday 09:00–18:00 in India, as a workspace starts. */
const office = (overrides: Partial<Calendar> = {}): Calendar => ({
  timeZone: IST,
  alwaysOpen: false,
  days: [...Array.from({ length: 5 }, () => [540, 1080] as const), null, null],
  holidays: new Set(),
  ...overrides,
});

describe('working time', () => {
  // 2026-10-30 is a Friday; 2026-11-02 the Monday after.
  it('counts only working hours, skipping the weekend and holidays', () => {
    const calendar = office();
    expect(
      iso(addCountedMinutes(workingWindows(at('2026-10-30T17:30:00+05:30'), calendar), 60)),
    ).toBe(
      '2026-11-02T04:00:00.000Z', // Monday 09:30 in India
    );
    const holiday = office({ holidays: new Set(['2026-11-02']) });
    expect(
      iso(addCountedMinutes(workingWindows(at('2026-10-30T17:30:00+05:30'), holiday), 60)),
    ).toBe('2026-11-03T04:00:00.000Z');
    // Starting outside hours counts from the next opening.
    expect(
      iso(addCountedMinutes(workingWindows(at('2026-10-31T12:00:00+05:30'), calendar), 60)),
    ).toBe('2026-11-02T04:30:00.000Z');
    // 24×7 counts every minute, holidays too.
    const always = office({ alwaysOpen: true, holidays: new Set(['2026-10-31']) });
    expect(
      iso(addCountedMinutes(workingWindows(at('2026-10-31T12:00:00+05:30'), always), 90)),
    ).toBe('2026-10-31T08:00:00.000Z');
  });

  it('leaves paused stretches out', () => {
    const start = at('2026-10-28T10:00:00+05:30');
    const pause = [[at('2026-10-28T11:00:00+05:30'), at('2026-10-28T13:00:00+05:30')]] as const;
    // 4 working hours from 10:00 with 11:00–13:00 paused: 16:00.
    expect(iso(addCountedMinutes(without(workingWindows(start, office()), pause), 240))).toBe(
      '2026-10-28T10:30:00.000Z',
    );
    // Round the clock, a pause also pushes the time on.
    expect(iso(addCountedMinutes(without(allTime(start), pause), 90))).toBe(
      '2026-10-28T08:00:00.000Z',
    );
    expect(
      countedMinutesUntil(
        without(workingWindows(start, office()), pause),
        at('2026-10-29T10:00:00+05:30'),
      ),
    ).toBe(6 * 60 + 60);
  });

  it('moves whole working days, holding the time inside the hours', () => {
    const calendar = office();
    expect(iso(addWorkingDays(at('2026-10-28T15:00:00+05:30'), 1, calendar))).toBe(
      '2026-10-29T09:30:00.000Z',
    );
    // Friday 15:00 plus one day is Monday 15:00; after hours it starts from Monday 09:00.
    expect(iso(addWorkingDays(at('2026-10-30T15:00:00+05:30'), 1, calendar))).toBe(
      '2026-11-02T09:30:00.000Z',
    );
    expect(iso(addWorkingDays(at('2026-10-30T20:00:00+05:30'), 1, calendar))).toBe(
      '2026-11-03T03:30:00.000Z',
    );
    // A short Saturday holds the time inside its hours.
    const saturdays = office({
      days: [...office().days.slice(0, 5), [600, 840], null] as Calendar['days'],
    });
    expect(iso(addWorkingDays(at('2026-10-30T15:00:00+05:30'), 1, saturdays))).toBe(
      '2026-10-31T08:30:00.000Z',
    );
    expect(
      iso(addWorkingDays(at('2026-10-30T15:00:00+05:30'), 5, office({ alwaysOpen: true }))),
    ).toBe('2026-11-04T09:30:00.000Z');
  });

  it('follows clock changes in the time zone', () => {
    const london: Calendar = { ...office(), timeZone: 'Europe/London' };
    // Clocks went forward on Sunday 29 March 2026: 09:00 was 09:00 UTC on Friday, 08:00 on Monday.
    expect(iso(instantAt('2026-03-27', 540, 'Europe/London'))).toBe('2026-03-27T09:00:00.000Z');
    expect(iso(instantAt('2026-03-30', 540, 'Europe/London'))).toBe('2026-03-30T08:00:00.000Z');
    expect(iso(addCountedMinutes(workingWindows(at('2026-03-27T17:00:00Z'), london), 120))).toBe(
      '2026-03-30T09:00:00.000Z',
    );
    expect(localTime(at('2026-03-30T08:00:00Z'), 'Europe/London')).toEqual({
      day: '2026-03-30',
      minute: 540,
    });
  });

  it('knows whether it is working time, and says the hours as people write them', () => {
    expect(isWorkingTime(at('2026-10-28T09:00:00+05:30'), office())).toBe(true);
    expect(isWorkingTime(at('2026-10-28T18:00:00+05:30'), office())).toBe(false);
    expect(isWorkingTime(at('2026-10-31T12:00:00+05:30'), office())).toBe(false);
    expect(hoursSummary(false, DEFAULT_DAYS)).toBe('Mon–Fri 09:00–18:00');
    expect(
      hoursSummary(false, [
        ...DEFAULT_DAYS.slice(0, 5),
        { open: true, start: '10:00', end: '14:00' },
        { open: true, start: '10:00', end: '14:00' },
      ]),
    ).toBe('Mon–Fri 09:00–18:00, Sat, Sun 10:00–14:00');
    expect(hoursSummary(true, DEFAULT_DAYS)).toBe('24 hours, 7 days');
  });
});

type Response = Awaited<ReturnType<typeof send>>;
interface Hours {
  timeZone: string;
  alwaysOpen: boolean;
  days: { day: string; open: boolean; start: string; end: string }[];
  holidays: { id: string; date: string; name: string }[];
  openNow: boolean;
}
const ok = (response: Response): Hours => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Hours>();
};
const get = (member: Member) => send({ url: '/api/v1/workspace/business-hours', ...as(member) });
const put = (member: Member, payload: Record<string, unknown>) =>
  send({ method: 'PUT', url: '/api/v1/workspace/business-hours', ...as(member), payload });
const addHoliday = (member: Member, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: '/api/v1/workspace/holidays', ...as(member), payload });
const fields = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );
const weekDays = (hours: Partial<Hours['days'][number]>[] = []) =>
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
    (day, index) => ({
      day,
      open: index < 5,
      start: '09:00',
      end: '18:00',
      ...hours.at(index),
    }),
  );
const auditOf = async (member: Member) =>
  (await send({ url: '/api/v1/audit-log?category=settings', ...as(member) })).json<{
    entries: { action: string; summary: string }[];
  }>().entries;

describe('business hours', () => {
  it('starts Monday to Friday 09:00–18:00 and saves the hours and time zone', async () => {
    const ws = await teamWorkspace();
    const start = ok(await get(ws.admin));
    expect(start).toMatchObject({
      timeZone: 'Asia/Kolkata',
      alwaysOpen: false,
      holidays: [],
      saved: false,
    });
    expect(start.days.filter((day) => day.open).map((day) => day.day)).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
    ]);

    const saved = ok(
      await put(ws.admin, {
        timeZone: 'Asia/Dubai',
        alwaysOpen: false,
        days: weekDays([{}, {}, {}, {}, {}, { open: true, start: '10:00', end: '14:00' }]),
      }),
    );
    expect(saved).toMatchObject({ timeZone: 'Asia/Dubai', saved: true });
    expect(saved.days[5]).toEqual({ day: 'saturday', open: true, start: '10:00', end: '14:00' });
    expect(ok(await get(ws.admin)).days[5]?.open).toBe(true);
    // The time zone is the workspace's own, shown everywhere.
    const me = await send({ url: '/api/v1/me', ...as(ws.admin) });
    expect(me.json<{ workspace: { timezone: string } }>().workspace.timezone).toBe('Asia/Dubai');

    expect(
      ok(await put(ws.admin, { timeZone: 'Asia/Dubai', alwaysOpen: true, days: weekDays() })),
    ).toMatchObject({ alwaysOpen: true, openNow: true });

    const descriptions = (await auditOf(ws.admin)).map((entry) => entry.summary);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /changed the workspace time zone from Asia\/Kolkata to Asia\/Dubai\.$/,
        ),
        expect.stringMatching(
          /changed the business hours to Mon–Fri 09:00–18:00, Sat 10:00–14:00\.$/,
        ),
        expect.stringMatching(/changed the business hours to 24 hours, 7 days\.$/),
      ]),
    );
  });

  it('refuses hours that make no sense', async () => {
    const ws = await teamWorkspace();
    const wrong = await put(ws.admin, {
      timeZone: 'Asia/Kolkata',
      alwaysOpen: false,
      days: weekDays([
        { start: '18:00', end: '09:00' },
        { start: '24:00', end: '24:00' },
      ]),
    });
    expect(wrong.statusCode).toBe(400);
    expect(fields(wrong)).toEqual({
      'days.0.end': 'End after the start time.',
      'days.1.start': 'Start before midnight.',
    });
    const closed = await put(ws.admin, {
      timeZone: 'Asia/Kolkata',
      alwaysOpen: false,
      days: weekDays(Array.from({ length: 7 }, () => ({ open: false }))),
    });
    expect(fields(closed)).toEqual({ days: 'Choose at least one working day, or 24×7.' });
    const badZone = await put(ws.admin, {
      timeZone: 'Mars/Olympus',
      alwaysOpen: false,
      days: weekDays(),
    });
    expect(badZone.statusCode).toBe(400);
    const shuffled = await put(ws.admin, {
      timeZone: 'Asia/Kolkata',
      alwaysOpen: false,
      days: weekDays().reverse(),
    });
    expect(fields(shuffled)['days.0.day']).toBe('List the days from Monday to Sunday.');
    // A working day may run to midnight.
    expect(
      ok(
        await put(ws.admin, {
          timeZone: 'Asia/Kolkata',
          alwaysOpen: false,
          days: weekDays([{ start: '00:00', end: '24:00' }]),
        }),
      ).days[0],
    ).toMatchObject({ start: '00:00', end: '24:00' });
  });

  it('keeps holidays, one per date, earliest first', async () => {
    const ws = await teamWorkspace();
    ok(await addHoliday(ws.admin, { date: '2026-12-25', name: 'Christmas' }));
    const both = ok(await addHoliday(ws.admin, { date: '2026-11-08', name: ' Diwali ' }));
    expect(both.holidays.map((holiday) => [holiday.date, holiday.name])).toEqual([
      ['2026-11-08', 'Diwali'],
      ['2026-12-25', 'Christmas'],
    ]);
    const twice = await addHoliday(ws.admin, { date: '2026-12-25', name: 'Again' });
    expect(fields(twice)).toEqual({ date: 'This day is already a holiday: Christmas.' });
    expect((await addHoliday(ws.admin, { date: '2026-02-30', name: 'X' })).statusCode).toBe(400);
    expect((await addHoliday(ws.admin, { date: '2026-12-31', name: '' })).statusCode).toBe(400);

    const diwali = both.holidays[0]?.id ?? '';
    const left = ok(
      await send({
        method: 'DELETE',
        url: `/api/v1/workspace/holidays/${diwali}`,
        ...as(ws.admin),
      }),
    );
    expect(left.holidays.map((holiday) => holiday.name)).toEqual(['Christmas']);
    expect(
      (
        await send({
          method: 'DELETE',
          url: `/api/v1/workspace/holidays/${diwali}`,
          ...as(ws.admin),
        })
      ).statusCode,
    ).toBe(404);

    const descriptions = (await auditOf(ws.admin)).map((entry) => entry.summary);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/added the holiday "Christmas" on 2026-12-25\.$/),
        expect.stringMatching(/removed the holiday "Diwali" on 2026-11-08\.$/),
      ]),
    );
  });

  it('is for admins only, and per workspace', { timeout: 30_000 }, async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      url: '/api/v1/workspace/business-hours',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'POST',
      url: '/api/v1/workspace/holidays',
      ...as(member),
      payload: { date: '2027-01-01', name: 'New year' },
    }));
    const intruder = await teamWorkspace();
    const byAddress = new Map([
      [ws.admin.address, ws.admin],
      [intruder.admin.address, intruder.admin],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: ws.admin.address, intruder: intruder.admin.address },
      setup: async () => {
        const hours = ok(
          await addHoliday(ws.admin, { date: '2027-01-26', name: 'Secret day off' }),
        );
        const id = hours.holidays.find((holiday) => holiday.name === 'Secret day off')?.id ?? '';
        return {
          secrets: ['Secret day off'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/workspace/business-hours' } },
            {
              kind: 'item',
              request: { method: 'DELETE', url: `/api/v1/workspace/holidays/${id}` },
            },
          ],
        };
      },
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });
  });

  it('answers changes from the writer', async () => {
    const ws = await teamWorkspace();
    await kit.restartApp(LAGGING_READER);
    const headers = {
      host: ws.admin.address,
      cookie: ws.admin.cookie,
      'x-csrf-token': ws.admin.csrf,
    };
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/workspace/holidays',
        headers,
        payload: { date: '2027-08-15', name: 'Independence Day' },
      },
      ['Independence Day'],
    );
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PUT',
        url: '/api/v1/workspace/business-hours',
        headers,
        payload: { timeZone: 'Europe/London', alwaysOpen: false, days: weekDays() },
      },
      ['Europe/London'],
    );
  });
});
