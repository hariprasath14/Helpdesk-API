import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, type Member } from '../../test/accounts.js';
import { captureEmails, testConfig, testDatabase } from '../../test/helpers.js';
import { sendMemberNotice } from '../email/outgoing.service.js';
import type { MemberNotice } from '../notifications/notify.js';
import { DEFAULT_TARGETS, dueAlerts, nextAlertAt, type AlertTicket } from './clock.js';
import { checkWorkspace } from './escalation.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
const kitDb = testDatabase();
const kitJobs = createJobQueue(kitDb.writer);
afterAll(async () => {
  await kitJobs.stop();
  await kitDb.close();
});
const deps = { db: kitDb, jobs: kitJobs };

const MINUTE = 60_000;

describe('SLA alert timing', () => {
  const ticket: AlertTicket = {
    status: 'open',
    createdAt: new Date('2026-10-28T10:00:00Z'),
    firstResponseAt: null,
    resolvedAt: null,
    slaReplyDueAt: new Date('2026-10-28T11:00:00Z'),
    slaResolveDueAt: new Date('2026-10-28T14:00:00Z'),
    slaResolveFrom: null,
    slaPauses: [],
    slaAlerts: {},
  };
  const at = (iso: string) => new Date(iso);

  it('warns some minutes before a deadline and escalates at it, each once per clock', () => {
    expect(nextAlertAt(ticket, 10)?.toISOString()).toBe('2026-10-28T10:50:00.000Z');
    expect(dueAlerts(ticket, 10, at('2026-10-28T10:49:00Z'))).toEqual([]);
    expect(dueAlerts(ticket, 10, at('2026-10-28T10:50:00Z'))).toMatchObject([
      { target: 'reply', kind: 'warning' },
    ]);
    const warned = { ...ticket, slaAlerts: { 'reply:warning': '2026-10-28T10:00:00.000Z' } };
    expect(nextAlertAt(warned, 10)?.toISOString()).toBe('2026-10-28T11:00:00.000Z');
    // A deadline already passed is escalated without a warning first.
    expect(dueAlerts(ticket, 10, at('2026-10-28T11:05:00Z'))).toMatchObject([
      { target: 'reply', kind: 'breach' },
    ]);
    expect(dueAlerts(ticket, null, at('2026-10-28T10:55:00Z'))).toEqual([]);
    // After a reopening the resolve clock starts again, and so do its alerts.
    const reopened = {
      ...ticket,
      firstResponseAt: at('2026-10-28T10:30:00Z'),
      slaResolveFrom: at('2026-10-28T12:00:00Z'),
      slaAlerts: { 'resolve:breach': '2026-10-28T10:00:00.000Z' },
    };
    expect(dueAlerts(reopened, null, at('2026-10-28T14:01:00Z'))).toMatchObject([
      { target: 'resolve', kind: 'breach' },
    ]);
    // Nothing while waiting on the customer or once resolved.
    expect(nextAlertAt({ ...ticket, status: 'waiting_on_customer' }, 10)).toBeNull();
    expect(nextAlertAt({ ...ticket, status: 'resolved' }, 10)).toBeNull();
  });
});

type Response = Awaited<ReturnType<typeof send>>;
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const post = (member: Member, url: string, payload: Record<string, unknown> = {}) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });

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
const workspaceIdOf = async (member: Member) => {
  const [workspace] = await query<{ id: string }>(
    'SELECT id FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: member.address.split('.')[0] },
  );
  return workspace?.id ?? '';
};
const notices = async (workspaceId: string) =>
  (
    await query<{ data: MemberNotice }>(
      "SELECT data FROM pgboss.job WHERE name = 'member-notice' AND data->>'workspaceId' = :workspaceId ORDER BY created_on",
      { workspaceId },
    )
  ).map((row) => row.data);
const defaultPolicyId = async (member: Member) =>
  ok<{ policies: { id: string }[] }>(await get(member, '/sla-policies')).policies[0]?.id ?? '';

interface Ticket {
  id: string;
  number: number;
  createdAt: string;
  assignee: { userId: string } | null;
}
interface Activity {
  actor: { name: string };
  changes: { field: string; to: unknown }[];
}

describe('SLA warnings and escalations', () => {
  it('warns the assignee at 50 minutes; at 1 hour marks it overdue, tells the leads and reassigns', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const workspaceId = await workspaceIdOf(ws.admin);
    const team = ok<{ id: string }>(
      await post(ws.admin, '/teams', {
        name: 'Payroll',
        members: [{ userId: ws.supervisor.userId, isLead: true }, { userId: ws.agent.userId }],
      }),
    );
    ok(
      await patch(ws.admin, `/sla-policies/${await defaultPolicyId(ws.admin)}`, {
        escalation: { warnMinutes: 10, reassign: 'team_lead', reassignUserId: null },
      }),
    );
    const ticket = ok<Ticket>(
      await post(ws.admin, '/tickets', {
        subject: 'Employees cannot mark attendance',
        contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
        priority: 'urgent',
        teamId: team.id,
        assigneeUserId: ws.agent.userId,
      }),
    );
    const created = Date.parse(ticket.createdAt);
    // Other tests' tickets may be checked too: look only at this one's notices.
    const about = async () =>
      (await notices(workspaceId)).filter((notice) => notice.ticketId === ticket.id);
    // Only this workspace: the test database also holds other tests' tickets.
    const checkAt = (minutes: number) =>
      checkWorkspace(deps, workspaceId, new Date(created + minutes * MINUTE));
    // The worker's check finds the workspace once an alert is due, not before.
    const due = async (minutes: number) =>
      (
        await query<{ id: string }>(
          'SELECT workspaces_with_sla_alerts AS id FROM workspaces_with_sla_alerts(:now)',
          { now: new Date(created + minutes * MINUTE) },
        )
      ).some((row) => row.id === workspaceId);
    expect(await due(49)).toBe(false);
    expect(await due(50)).toBe(true);

    await checkAt(49);
    expect(await about()).toEqual([]);
    await checkAt(50);
    await checkAt(51);
    expect(await about()).toMatchObject([
      {
        userIds: [ws.agent.userId],
        subject: `Ticket #${String(ticket.number)}: first reply due in 10 minutes`,
      },
    ]);

    await checkAt(60);
    await checkAt(61);
    const all = await about();
    expect(all).toHaveLength(2);
    const breach = all.at(-1);
    if (!breach) throw new Error('no escalation notice');
    expect(breach).toMatchObject({
      userIds: [ws.supervisor.userId],
      subject: `Ticket #${String(ticket.number)} is overdue`,
    });
    expect(breach.text).toMatch(/the first reply was due at .*\. It was reassigned to /);
    const after = ok<Ticket>(await get(ws.agent, `/tickets/${String(ticket.number)}`));
    expect(after.assignee?.userId).toBe(ws.supervisor.userId);
    const history = ok<{ activity: Activity[] }>(
      await get(ws.agent, `/tickets/${String(ticket.number)}/activity`),
    ).activity;
    expect(history.map((entry) => [entry.actor.name, entry.changes[0]?.field])).toEqual(
      expect.arrayContaining([
        ['SLA: Default policy', 'sla'],
        ['SLA: Default policy', 'assignee'],
      ]),
    );

    // The notice reaches the lead by email.
    const emails = captureEmails();
    await sendMemberNotice(
      {
        config: testConfig(),
        db: kitDb,
        email: emails.sender,
        storage: createFileStorage(testConfig()),
      },
      breach,
    );
    expect(emails.sent).toMatchObject([
      { to: ws.supervisor.email, subject: `Ticket #${String(ticket.number)} is overdue` },
    ]);
  });

  it('tells the admins when there is no team, and can hand a ticket back to the team', async () => {
    const ws = await teamWorkspace();
    await roundTheClock(ws.admin);
    const workspaceId = await workspaceIdOf(ws.admin);
    const id = await defaultPolicyId(ws.admin);
    expect(
      (
        await patch(ws.admin, `/sla-policies/${id}`, {
          escalation: { warnMinutes: 30, reassign: 'person', reassignUserId: null },
        })
      ).statusCode,
    ).toBe(400);
    ok(
      await patch(ws.admin, `/sla-policies/${id}`, {
        escalation: { warnMinutes: 30, reassign: 'team', reassignUserId: null },
        targets: DEFAULT_TARGETS,
      }),
    );
    const unassigned = ok<Ticket>(
      await post(ws.agent, '/tickets', {
        subject: 'Unassigned one',
        contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
        priority: 'urgent',
      }),
    );
    await checkWorkspace(
      deps,
      workspaceId,
      new Date(Date.parse(unassigned.createdAt) + 31 * MINUTE),
    );
    expect((await notices(workspaceId)).at(-1)).toMatchObject({ userIds: [ws.admin.userId] });

    const mine = ok<Ticket>(
      await post(ws.agent, '/tickets', {
        subject: 'Taken one',
        contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
        priority: 'urgent',
        assigneeUserId: ws.agent.userId,
      }),
    );
    const path = `/tickets/${String(mine.number)}`;
    const about = async () =>
      (await notices(workspaceId)).filter((notice) => notice.ticketId === mine.id);
    // Nothing happens while waiting on the customer.
    ok(await patch(ws.agent, path, { status: 'waiting_on_customer' }));
    await checkWorkspace(deps, workspaceId, new Date(Date.now() + 2 * 60 * MINUTE));
    expect(await about()).toEqual([]);
    ok(await patch(ws.agent, path, { status: 'open' }));
    await checkWorkspace(deps, workspaceId, new Date(Date.now() + 5 * 60 * MINUTE));
    const back = ok<Ticket>(await get(ws.agent, path));
    expect(back.assignee).toBeNull();
    // Both deadlines passed: the first escalation hands it back, the second finds nobody to move.
    expect((await about()).map((notice) => notice.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/It is back with the team, unassigned\.$/)]),
    );
  });
});
