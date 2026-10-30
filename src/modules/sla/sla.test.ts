import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER, testConfig, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import type { Calendar } from '../business-hours/calendar.js';
import { ticketReplyAddress } from '../email/addresses.js';
import { receiveEmail } from '../email/incoming.service.js';
import { DEFAULT_TARGETS, dueAfter, nextDue, targetViews, type SlaTicket } from './clock.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
const kitDb = testDatabase();
const kitJobs = createJobQueue(kitDb.writer);
afterAll(async () => {
  await kitJobs.stop();
  await kitDb.close();
});

const HOUR = 3_600_000;
const MINUTE = 60_000;

// 2026-10-30 is a Friday.
const office: Calendar = {
  timeZone: 'Asia/Kolkata',
  alwaysOpen: false,
  days: [...Array.from({ length: 5 }, () => [540, 1080] as const), null, null],
  holidays: new Set(['2026-11-02']),
};

describe('SLA clocks', () => {
  it('works due times out in business hours or round the clock, leaving pauses out', () => {
    const friday = new Date('2026-10-30T17:00:00+05:30');
    // 2 business hours from Friday 17:00: one on Friday, Monday is a holiday, one on Tuesday.
    expect(
      dueAfter(friday, { amount: 2, unit: 'hours' }, 'business', office, []).toISOString(),
    ).toBe('2026-11-03T04:30:00.000Z');
    expect(
      dueAfter(friday, { amount: 2, unit: 'hours' }, 'calendar', office, []).toISOString(),
    ).toBe('2026-10-30T13:30:00.000Z');
    // Before opening, a working day ends at the next day's opening, not at the closing before it.
    const early = new Date('2026-10-28T02:00:00+05:30');
    expect(dueAfter(early, { amount: 1, unit: 'days' }, 'business', office, []).toISOString()).toBe(
      '2026-10-29T03:30:00.000Z',
    );
    expect(
      dueAfter(early, { amount: 9, unit: 'hours' }, 'business', office, []).toISOString(),
    ).toBe('2026-10-28T12:30:00.000Z');
    // A working day is the same time on the next working day.
    expect(
      dueAfter(friday, { amount: 1, unit: 'days' }, 'business', office, []).toISOString(),
    ).toBe('2026-11-03T11:30:00.000Z');
    expect(
      dueAfter(friday, { amount: 3, unit: 'days' }, 'calendar', office, []).toISOString(),
    ).toBe('2026-11-02T11:30:00.000Z');
    const pause = [{ from: '2026-10-30T11:35:00.000Z', to: '2026-10-30T12:05:00.000Z' }];
    expect(
      dueAfter(friday, { amount: 45, unit: 'minutes' }, 'calendar', office, pause).toISOString(),
    ).toBe('2026-10-30T12:45:00.000Z');
  });

  it('says which deadline runs next and how each target stands', () => {
    const base: SlaTicket = {
      status: 'open',
      createdAt: new Date('2026-10-28T10:00:00Z'),
      firstResponseAt: null,
      resolvedAt: null,
      slaReplyDueAt: new Date('2026-10-28T11:00:00Z'),
      slaResolveDueAt: new Date('2026-10-28T14:00:00Z'),
      slaResolveFrom: null,
      slaPauses: [],
    };
    const now = new Date('2026-10-28T11:10:00Z');
    expect(nextDue(base)).toEqual({ at: base.slaReplyDueAt, target: 'reply' });
    expect(targetViews(base, now)).toMatchObject({
      reply: { state: 'overdue' },
      resolve: { state: 'running' },
    });
    const replied = { ...base, firstResponseAt: new Date('2026-10-28T10:50:00Z') };
    expect(nextDue(replied)).toEqual({ at: base.slaResolveDueAt, target: 'resolve' });
    expect(targetViews(replied, now).reply).toMatchObject({ state: 'met' });
    expect(nextDue({ ...base, status: 'waiting_on_customer' })).toBeNull();
    expect(targetViews({ ...base, status: 'waiting_on_customer' }, now).reply?.state).toBe(
      'paused',
    );
    const late = {
      ...base,
      status: 'resolved' as const,
      resolvedAt: new Date('2026-10-28T15:00:00Z'),
    };
    expect(nextDue(late)).toBeNull();
    // Resolved without a reply: no reply target to show.
    expect(targetViews(late, now)).toMatchObject({ reply: null, resolve: { state: 'missed' } });
  });
});

type Response = Awaited<ReturnType<typeof send>>;
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
const post = (member: Member, url: string, payload: Record<string, unknown> = {}) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );

interface Target {
  dueAt: string;
  state: string;
  doneAt: string | null;
}
interface Ticket {
  id: string;
  number: number;
  createdAt: string;
  priority: string;
  due: { at: string; target: string } | null;
  sla: { policy: { name: string } | null; reply: Target | null; resolve: Target | null } | null;
}
interface Policy {
  id: string;
  name: string;
  isDefault: boolean;
  targets: typeof DEFAULT_TARGETS;
}

/** 24×7 business hours, so due times do not depend on when the test runs. */
const roundTheClock = async (member: Member) => {
  const response = await send({
    method: 'PUT',
    url: '/api/v1/workspace/business-hours',
    ...as(member),
    payload: {
      timeZone: 'Asia/Kolkata',
      alwaysOpen: true,
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
        (day) => ({ day, open: true, start: '09:00', end: '18:00' }),
      ),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
};

const newTicket = async (member: Member, payload: Record<string, unknown> = {}) =>
  ok<Ticket>(
    await post(member, '/tickets', {
      subject: 'Payslip missing',
      contact: { name: 'Neha Iyer', email: `neha.${String(Date.now())}@acme.test` },
      ...payload,
    }),
  );
const ticketOf = async (member: Member, number: number) =>
  ok<Ticket>(await get(member, `/tickets/${String(number)}`));
const after = (ticket: Ticket, iso: string | undefined) =>
  Date.parse(iso ?? '') - Date.parse(ticket.createdAt);

describe('SLA policies', () => {
  it('starts with the default policy and its starting values, which admins change', async () => {
    const ws = await teamWorkspace();
    const [fallback, ...rest] = ok<{ policies: Policy[] }>(
      await get(ws.admin, '/sla-policies'),
    ).policies;
    expect(rest).toEqual([]);
    expect(fallback).toMatchObject({
      name: 'Default policy',
      isDefault: true,
      targets: DEFAULT_TARGETS,
    });
    const changed = ok<Policy>(
      await patch(ws.admin, `/sla-policies/${fallback?.id ?? ''}`, {
        targets: {
          ...DEFAULT_TARGETS,
          urgent: {
            reply: { amount: 30, unit: 'minutes' },
            resolve: { amount: 2, unit: 'hours' },
            hours: 'calendar',
          },
        },
      }),
    );
    expect(changed.targets.urgent.hours).toBe('calendar');

    const conditions = await patch(ws.admin, `/sla-policies/${fallback?.id ?? ''}`, {
      conditions: {
        match: 'all',
        items: [{ field: 'tags', operator: 'contains_any', value: ['vip'] }],
      },
    });
    expect(problems(conditions)).toEqual({
      conditions: 'The default policy covers every ticket no other policy matches.',
    });
    expect(
      (
        await send({
          method: 'DELETE',
          url: `/api/v1/sla-policies/${fallback?.id ?? ''}`,
          ...as(ws.admin),
        })
      ).statusCode,
    ).toBe(409);
    const tooLong = await patch(ws.admin, `/sla-policies/${fallback?.id ?? ''}`, {
      targets: {
        ...DEFAULT_TARGETS,
        low: { ...DEFAULT_TARGETS.low, resolve: { amount: 400, unit: 'days' } },
      },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(
      (await send({ url: '/api/v1/audit-log?category=settings', ...as(ws.admin) })).json<{
        entries: { summary: string }[];
      }>().entries[0]?.summary,
    ).toMatch(/changed the SLA policy "Default policy" \(targets\)\.$/);
  });

  it('gives tickets due times, counting again from creation when the priority changes', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const ticket = await newTicket(ws.agent, { priority: 'urgent' });
    expect(ticket.sla?.policy?.name).toBe('Default policy');
    expect(after(ticket, ticket.sla?.reply?.dueAt)).toBe(HOUR);
    expect(after(ticket, ticket.sla?.resolve?.dueAt)).toBe(4 * HOUR);
    expect(ticket.due).toEqual({ at: ticket.sla?.reply?.dueAt, target: 'reply' });
    expect(ticket.sla?.reply?.state).toBe('running');

    const low = ok<Ticket>(
      await patch(ws.agent, `/tickets/${String(ticket.number)}`, { priority: 'low' }),
    );
    // With 24×7 hours a working day is 24 hours.
    expect(after(low, low.sla?.reply?.dueAt)).toBe(24 * HOUR);
    expect(after(low, low.sla?.resolve?.dueAt)).toBe(5 * 24 * HOUR);

    // A private note is not a reply; a reply meets the reply target.
    const path = `/tickets/${String(ticket.number)}/messages`;
    ok(await post(ws.agent, path, { kind: 'note', body: 'Checking payroll.' }));
    expect((await ticketOf(ws.agent, ticket.number)).sla?.reply?.state).toBe('running');
    ok(await post(ws.agent, path, { kind: 'reply', body: 'We are on it.' }));
    const replied = await ticketOf(ws.agent, ticket.number);
    expect(replied.sla?.reply?.state).toBe('met');
    expect(replied.due).toEqual({ at: replied.sla?.resolve?.dueAt, target: 'resolve' });
  });

  it('pauses while waiting on the customer, stops on resolve and starts again on reopen', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const ticket = await newTicket(ws.agent, { priority: 'urgent' });
    const path = `/tickets/${String(ticket.number)}`;

    // Pending still counts.
    expect(ok<Ticket>(await patch(ws.agent, path, { status: 'pending' })).due).not.toBeNull();
    const waiting = ok<Ticket>(await patch(ws.agent, path, { status: 'waiting_on_customer' }));
    expect(waiting.due).toBeNull();
    expect(waiting.sla).toMatchObject({ reply: { state: 'paused' }, resolve: { state: 'paused' } });
    // Created 40 minutes ago, waiting on the customer for the last 30.
    await query(
      `UPDATE tickets SET created_at = created_at - interval '40 minutes',
         status_changed_at = status_changed_at - interval '30 minutes' WHERE id = :id`,
      { id: ticket.id },
    );
    const back = ok<Ticket>(await patch(ws.agent, path, { status: 'open' }));
    expect(Math.abs(after(back, back.sla?.reply?.dueAt) - (HOUR + 30 * MINUTE))).toBeLessThan(5000);
    expect(back.due?.target).toBe('reply');

    const resolved = ok<Ticket>(await patch(ws.agent, path, { status: 'resolved' }));
    expect(resolved.due).toBeNull();
    expect(resolved.sla).toMatchObject({ reply: null, resolve: { state: 'met' } });

    const reopened = ok<Ticket>(await patch(ws.agent, path, { status: 'open' }));
    const resolveIn = Date.parse(reopened.sla?.resolve?.dueAt ?? '') - Date.now();
    expect(Math.abs(resolveIn - 4 * HOUR)).toBeLessThan(10_000);
    expect(reopened.sla?.resolve?.state).toBe('running');
  });

  it('starts the clocks for email tickets and follows the customer reopening them', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const [workspace] = await query<{ id: string; subdomain: string }>(
      'SELECT id, subdomain FROM workspaces WHERE subdomain = :subdomain',
      { subdomain: ws.admin.address.split('.')[0] },
    );
    const deps = {
      config: testConfig(),
      db: kitDb,
      storage: createFileStorage(testConfig()),
      jobs: kitJobs,
    };
    const email = (to: string, subject: string) =>
      new MailComposer({
        from: 'Neha Iyer <neha@acme.test>',
        to,
        subject,
        text: 'Payslip for October is missing.',
        messageId: `<${String(Date.now())}.${String(Math.random())}@customer.test>`,
      })
        .compile()
        .build();
    const raw = await email(
      `${workspace?.subdomain ?? ''}@${testConfig().TICKET_EMAIL_DOMAIN}`,
      'Payslip',
    );
    expect(await receiveEmail(deps, raw)).toMatchObject({ result: 'ticket' });
    const { tickets } = ok<{ tickets: Ticket[] }>(await get(ws.agent, '/tickets'));
    const [ticket] = tickets;
    if (!ticket) throw new Error('no ticket from the email');
    // Email tickets come in at medium: 8 hours to reply.
    expect(ticket.due?.target).toBe('reply');
    expect(after(ticket, ticket.due?.at)).toBe(8 * HOUR);

    const { number } = ticket;
    ok(await patch(ws.agent, `/tickets/${String(number)}`, { status: 'resolved' }));
    const replyTo = ticketReplyAddress(
      testConfig(),
      { id: workspace?.id ?? '', subdomain: workspace?.subdomain ?? '' },
      number,
    );
    expect(await receiveEmail(deps, await email(replyTo, 'Re: Payslip'))).toMatchObject({
      result: 'reply',
    });
    const reopened = await ticketOf(ws.agent, number);
    const resolveIn = Date.parse(reopened.sla?.resolve?.dueAt ?? '') - Date.now();
    expect(Math.abs(resolveIn - 3 * 24 * HOUR)).toBeLessThan(10_000);
  });

  it('uses the first policy whose conditions match, in the order set', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const quick = {
      reply: { amount: 15, unit: 'minutes' },
      resolve: { amount: 1, unit: 'hours' },
      hours: 'calendar',
    };
    const vip = ok<Policy>(
      await post(ws.admin, '/sla-policies', {
        name: 'VIP customers',
        conditions: {
          match: 'all',
          items: [{ field: 'tags', operator: 'contains_any', value: ['vip'] }],
        },
        targets: { urgent: quick, high: quick, medium: quick, low: quick },
      }),
    );
    const slow = { ...quick, reply: { amount: 2, unit: 'days' } };
    const outage = ok<Policy>(
      await post(ws.admin, '/sla-policies', {
        name: 'Outages',
        conditions: {
          match: 'all',
          items: [{ field: 'type', operator: 'is_any', value: ['incident'] }],
        },
        targets: { urgent: slow, high: slow, medium: slow, low: slow },
      }),
    );
    expect(
      ok<{ policies: Policy[] }>(await get(ws.admin, '/sla-policies')).policies.map((p) => p.name),
    ).toEqual(['VIP customers', 'Outages', 'Default policy']);

    const both = await newTicket(ws.agent, { tags: ['vip'], type: 'incident' });
    expect(both.sla?.policy?.name).toBe('VIP customers');
    expect(after(both, both.sla?.reply?.dueAt)).toBe(15 * MINUTE);

    ok(
      await send({
        method: 'PUT',
        url: '/api/v1/sla-policies/order',
        ...as(ws.admin),
        payload: { policyIds: [outage.id, vip.id] },
      }),
    );
    const again = await newTicket(ws.agent, { tags: ['vip'], type: 'incident' });
    expect(again.sla?.policy?.name).toBe('Outages');
    // A change that makes another policy match works the times out again.
    const plain = await newTicket(ws.agent);
    expect(plain.sla?.policy?.name).toBe('Default policy');
    const tagged = ok<Ticket>(
      await patch(ws.agent, `/tickets/${String(plain.number)}`, { tags: ['vip'] }),
    );
    expect(tagged.sla?.policy?.name).toBe('VIP customers');
    expect(after(tagged, tagged.sla?.reply?.dueAt)).toBe(15 * MINUTE);

    const wrong = await post(ws.admin, '/sla-policies', {
      name: 'Bad',
      conditions: {
        match: 'all',
        items: [{ field: 'hours_in_status', operator: 'at_least', value: '2' }],
      },
      targets: DEFAULT_TARGETS,
    });
    expect(problems(wrong)).toEqual({
      'conditions.items.0.field': 'This field can only be used in rules.',
    });
    expect(
      (
        await send({
          method: 'PUT',
          url: '/api/v1/sla-policies/order',
          ...as(ws.admin),
          payload: { policyIds: [vip.id] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/sla-policies/${vip.id}`, ...as(ws.admin) }))
        .statusCode,
    ).toBe(204);
    // Its tickets keep their due times, shown without a policy name.
    const kept = await ticketOf(ws.agent, both.number);
    expect(kept.sla).toMatchObject({ policy: null, reply: { dueAt: both.sla?.reply?.dueAt } });
  });

  it('lists overdue tickets and sorts by the deadline due soonest', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const low = await newTicket(ws.agent, { priority: 'low', subject: 'Low one' });
    const urgent = await newTicket(ws.agent, { priority: 'urgent', subject: 'Urgent one' });
    const waiting = await newTicket(ws.agent, {
      status: 'waiting_on_customer',
      subject: 'Waiting one',
    });
    const late = await newTicket(ws.agent, { priority: 'high', subject: 'Late one' });
    await query(
      // Whole milliseconds, as the app writes them.
      `UPDATE tickets SET sla_due_at = date_trunc('milliseconds', now()) - interval '10 minutes',
         sla_reply_due_at = date_trunc('milliseconds', now()) - interval '10 minutes' WHERE id = :id`,
      { id: late.id },
    );
    const overdue = ok<{ tickets: Ticket[] }>(await get(ws.agent, '/tickets?overdue=true')).tickets;
    expect(overdue.map((item) => item.number)).toEqual([late.number]);
    expect((await ticketOf(ws.agent, late.number)).sla?.reply?.state).toBe('overdue');

    const order: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { tickets: Ticket[]; nextCursor: string | null } = ok(
        await get(ws.agent, `/tickets?sort=due&limit=1${cursor ? `&cursor=${cursor}` : ''}`),
      );
      order.push(...page.tickets.map((item) => item.number));
      cursor = page.nextCursor;
    } while (cursor && order.length < 10);
    expect(order).toEqual([late.number, urgent.number, low.number, waiting.number]);

    // A saved view keeps the Overdue filter.
    const view = ok<{ filters: Record<string, unknown> }>(
      await post(ws.agent, '/ticket-views', {
        name: 'Overdue',
        filters: { overdue: true },
        sort: 'due',
      }),
    );
    expect(view.filters).toEqual({ overdue: true });
  });

  it('is for admins only, and per workspace', { timeout: 30_000 }, async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      url: '/api/v1/sla-policies',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'POST',
      url: '/api/v1/sla-policies',
      ...as(member),
      payload: { name: 'P', conditions: { match: 'all', items: [] }, targets: DEFAULT_TARGETS },
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
        const secret = ok<Policy>(
          await post(ws.admin, '/sla-policies', {
            name: 'Secret SLA policy',
            conditions: { match: 'all', items: [] },
            targets: DEFAULT_TARGETS,
          }),
        );
        return {
          secrets: ['Secret SLA policy'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/sla-policies' } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/sla-policies/${secret.id}`,
                payload: { name: 'Taken' },
              },
            },
            {
              kind: 'item',
              request: { method: 'DELETE', url: `/api/v1/sla-policies/${secret.id}` },
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
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/sla-policies',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: {
          name: 'Lagging policy',
          conditions: { match: 'all', items: [] },
          targets: DEFAULT_TARGETS,
        },
      },
      ['Lagging policy'],
    );
  });
});
