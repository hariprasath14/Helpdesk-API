import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER, testConfig, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { ticketReplyAddress } from '../email/addresses.js';
import { receiveEmail } from '../email/incoming.service.js';
import { cleanOldNotifications } from './notifications.service.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
const kitDb = testDatabase();
const kitJobs = createJobQueue(kitDb.writer);
afterAll(async () => {
  await kitJobs.stop();
  await kitDb.close();
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

interface Item {
  id: string;
  kind: string;
  title: string;
  body: string;
  ticket: { number: number; subject: string } | null;
  read: boolean;
}
interface Page {
  notifications: Item[];
  unread: number;
  nextCursor: string | null;
}
const inbox = async (member: Member, query = '') =>
  ok<Page>(await get(member, `/notifications${query}`));
const workspaceIdOf = async (member: Member) => {
  const [workspace] = await query<{ id: string }>(
    'SELECT id FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: member.address.split('.')[0] },
  );
  return workspace?.id ?? '';
};
const jobsIn = (queue: string, workspaceId: string) =>
  query<{ data: Record<string, unknown> }>(
    "SELECT data FROM pgboss.job WHERE name = :queue AND data->>'workspaceId' = :workspaceId ORDER BY created_on",
    { queue, workspaceId },
  );
const newTicket = async (member: Member, payload: Record<string, unknown> = {}) =>
  ok<{ id: string; number: number }>(
    await post(member, '/tickets', {
      subject: 'Payslip missing',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      ...payload,
    }),
  );

describe('notifications', () => {
  it('tells people when a ticket is assigned to them or they are mentioned', async () => {
    const ws = await teamWorkspace();
    const workspaceId = await workspaceIdOf(ws.admin);
    const ticket = await newTicket(ws.admin, { assigneeUserId: ws.agent.userId });
    // Taking a ticket yourself tells nobody.
    await newTicket(ws.supervisor, { assigneeUserId: ws.supervisor.userId });

    const agent = await inbox(ws.agent);
    expect(agent.unread).toBe(1);
    expect(agent.notifications).toMatchObject([
      {
        kind: 'assigned',
        title: `Ticket #${String(ticket.number)} assigned to you`,
        ticket: { number: ticket.number, subject: 'Payslip missing' },
        read: false,
      },
    ]);
    expect(await jobsIn('assignment-email', workspaceId)).toHaveLength(1);
    expect((await inbox(ws.supervisor)).notifications).toEqual([]);

    ok(
      await post(ws.admin, `/tickets/${String(ticket.number)}/messages`, {
        kind: 'note',
        body: 'Can you check payroll?',
        mentions: [ws.supervisor.userId, ws.admin.userId],
      }),
    );
    const mentioned = await inbox(ws.supervisor);
    expect(mentioned.notifications).toMatchObject([
      { kind: 'mention', body: 'Can you check payroll?' },
    ]);
    expect(mentioned.notifications[0]?.title).toMatch(/ mentioned you on ticket #\d+$/);
    // The writer of the note is not told about their own mention.
    expect((await inbox(ws.admin)).notifications).toEqual([]);
    expect(await jobsIn('member-notice', workspaceId)).toMatchObject([
      { data: { kind: 'mention', userIds: [ws.supervisor.userId] } },
    ]);
  });

  it('emails only the kinds each person chose; the app always shows them', async () => {
    const ws = await teamWorkspace();
    const workspaceId = await workspaceIdOf(ws.admin);
    expect(ok(await get(ws.agent, '/notifications/email'))).toEqual({
      assigned: true,
      mention: true,
      sla_warning: true,
      sla_breach: true,
      customer_reply: false,
    });
    expect(
      ok(await patch(ws.agent, '/notifications/email', { assigned: false, customer_reply: true })),
    ).toMatchObject({ assigned: false, customer_reply: true, mention: true });
    const ticket = await newTicket(ws.admin, { assigneeUserId: ws.agent.userId });
    expect((await inbox(ws.agent)).unread).toBe(1);
    expect(await jobsIn('assignment-email', workspaceId)).toEqual([]);

    // The customer replies: the assignee hears about it, by email too as they chose.
    const deps = {
      config: testConfig(),
      db: kitDb,
      storage: createFileStorage(testConfig()),
      jobs: kitJobs,
    };
    const raw = await new MailComposer({
      from: 'Neha Iyer <neha@acme.test>',
      to: ticketReplyAddress(
        testConfig(),
        { id: workspaceId, subdomain: ws.admin.address.split('.')[0] ?? '' },
        ticket.number,
      ),
      subject: 'Re: Payslip missing',
      text: 'Still missing for October.',
      messageId: `<${String(Date.now())}@customer.test>`,
    })
      .compile()
      .build();
    expect(await receiveEmail(deps, raw)).toMatchObject({ result: 'reply' });
    expect((await inbox(ws.agent)).notifications[0]).toMatchObject({
      kind: 'customer_reply',
      title: `Neha Iyer replied on ticket #${String(ticket.number)}`,
      body: 'Still missing for October.',
    });
    expect(await jobsIn('member-notice', workspaceId)).toMatchObject([
      { data: { kind: 'customer_reply', userIds: [ws.agent.userId] } },
    ]);
  });

  it('pages newest first and marks one or all read', async () => {
    const ws = await teamWorkspace();
    for (const subject of ['First', 'Second', 'Third']) {
      await newTicket(ws.admin, { subject, assigneeUserId: ws.agent.userId });
    }
    const first = await inbox(ws.agent, '?limit=2');
    expect(first.notifications.map((item) => item.ticket?.subject)).toEqual(['Third', 'Second']);
    expect(first.unread).toBe(3);
    const second = await inbox(ws.agent, `?limit=2&cursor=${first.nextCursor ?? ''}`);
    expect(second.notifications.map((item) => item.ticket?.subject)).toEqual(['First']);
    expect(second.nextCursor).toBeNull();
    expect((await get(ws.agent, '/notifications?cursor=nonsense')).statusCode).toBe(400);

    const one = first.notifications[0]?.id ?? '';
    expect(ok(await post(ws.agent, '/notifications/read', { ids: [one] }))).toEqual({
      unread: 2,
    });
    expect(ok(await get(ws.agent, '/notifications/unread'))).toEqual({ unread: 2 });
    expect((await inbox(ws.agent)).notifications[0]?.read).toBe(true);
    // Someone else's notification is not found.
    expect((await post(ws.admin, '/notifications/read', { ids: [one] })).statusCode).toBe(404);
    expect(ok(await post(ws.agent, '/notifications/read', {}))).toEqual({ unread: 0 });
  });

  it('removes notifications after 90 days', async () => {
    const ws = await teamWorkspace();
    await newTicket(ws.admin, { assigneeUserId: ws.agent.userId });
    await query(
      `UPDATE notifications SET created_at = now() - interval '91 days'
       WHERE user_id = (SELECT id FROM users WHERE email = :email)`,
      { email: ws.agent.email },
    );
    expect(await cleanOldNotifications({ db: kitDb })).toBeGreaterThanOrEqual(1);
    expect((await inbox(ws.agent)).notifications).toEqual([]);
  });

  it(
    'is for every member, each seeing only their own, per workspace',
    { timeout: 30_000 },
    async () => {
      const ws = await teamWorkspace();
      await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
        url: '/api/v1/notifications',
        ...as(member),
      }));
      const intruder = await teamWorkspace();
      const byAddress = new Map([
        [ws.agent.address, ws.agent],
        [intruder.agent.address, intruder.agent],
      ]);
      await expectTenantIsolation({
        app: kit.app,
        workspaces: { owner: ws.agent.address, intruder: intruder.agent.address },
        setup: async () => {
          await newTicket(ws.admin, {
            subject: 'Secret notification ticket',
            assigneeUserId: ws.agent.userId,
          });
          const id = (await inbox(ws.agent)).notifications[0]?.id ?? '';
          return {
            secrets: ['Secret notification ticket'],
            checks: [
              { kind: 'list', request: { method: 'GET', url: '/api/v1/notifications' } },
              {
                kind: 'item',
                request: {
                  method: 'POST',
                  url: '/api/v1/notifications/read',
                  payload: { ids: [id] },
                },
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
    },
  );

  it('answers changes from the writer', async () => {
    const ws = await teamWorkspace();
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/notifications/email',
        headers: { host: ws.agent.address, cookie: ws.agent.cookie, 'x-csrf-token': ws.agent.csrf },
        payload: { customer_reply: true },
      },
      ['"customer_reply":true'],
    );
  });
});
