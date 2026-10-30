import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { captureEmails, LAGGING_READER, testConfig, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { ticketReplyAddress } from '../email/addresses.js';
import { receiveEmail } from '../email/incoming.service.js';
import { sendCustomerEmail } from '../email/outgoing.service.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;
const kitDb = testDatabase();
const kitJobs = createJobQueue(kitDb.writer);
afterAll(async () => {
  await kitJobs.stop();
  await kitDb.close();
});
const emailDeps = () => ({
  config: testConfig(),
  db: kitDb,
  storage: createFileStorage(testConfig()),
  jobs: kitJobs,
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

interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: string;
  tags: string[];
  ccEmails: string[];
  mergedInto: { number: number } | null;
  contact: { id: string };
}
interface Message {
  id: string;
  kind: string;
  body: string;
  fromTicketNumber: number | null;
  cc: string[];
  createdAt: string;
  author: { type: string; name: string } | null;
}
const messagesOf = async (member: Member, number: number) =>
  ok<{ messages: Message[] }>(await get(member, `/tickets/${String(number)}/messages`)).messages;
const historyOf = async (member: Member, number: number) =>
  ok<{ activity: { changes: { field: string; to: unknown }[] }[] }>(
    await get(member, `/tickets/${String(number)}/activity`),
  ).activity.flatMap((entry) => entry.changes);

const newTicket = async (member: Member, payload: Record<string, unknown>) =>
  ok<Ticket>(await post(member, '/tickets', payload));
const workspaceOf = async (member: Member) => {
  const [workspace] = await query<{ id: string; subdomain: string }>(
    'SELECT id, subdomain FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: member.address.split('.')[0] },
  );
  return { id: workspace?.id ?? '', subdomain: workspace?.subdomain ?? '' };
};
const customerEmail = (to: string, subject: string, text: string) =>
  new MailComposer({
    from: 'Arjun Mehta <arjun@acme.test>',
    to,
    subject,
    text,
    messageId: `<${String(Date.now())}.${String(Math.random())}@customer.test>`,
  })
    .compile()
    .build();

describe('merging tickets', () => {
  it('moves everything into the main ticket and closes the others', async () => {
    const ws = await teamWorkspace();
    const main = await newTicket(ws.agent, {
      subject: 'Payslip missing',
      description: 'October payslip is not there.',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      tags: ['payroll'],
    });
    const second = await newTicket(ws.agent, {
      subject: 'Salary slip',
      description: 'Cannot download my slip.',
      contact: { name: 'Arjun Mehta', email: 'arjun@acme.test' },
      tags: ['download'],
    });
    const third = await newTicket(ws.agent, {
      subject: 'Payslip again',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
    });
    ok(
      await post(ws.agent, `/tickets/${String(second.number)}/messages`, {
        kind: 'note',
        body: 'Checked with payroll.',
      }),
    );

    // Agents cannot merge; supervisors can.
    expect(
      (await post(ws.agent, `/tickets/${String(main.number)}/merge`, { numbers: [second.number] }))
        .statusCode,
    ).toBe(403);
    const merged = ok<Ticket>(
      await post(ws.supervisor, `/tickets/${String(main.number)}/merge`, {
        numbers: [third.number, second.number],
        tellCustomers: true,
      }),
    );
    expect(merged.tags.sort()).toEqual(['download', 'payroll']);
    // Arjun is copied on replies; Neha is already the requester.
    expect(merged.ccEmails).toEqual(['arjun@acme.test']);

    const conversation = await messagesOf(ws.agent, main.number);
    expect(
      conversation.map((message) => [message.kind, message.fromTicketNumber, message.body]),
    ).toEqual([
      ['customer', second.number, 'Salary slip\n\nCannot download my slip.'],
      ['customer', third.number, 'Payslip again'],
      ['note', second.number, 'Checked with payroll.'],
    ]);
    expect(conversation[0]?.author).toMatchObject({ type: 'contact', name: 'Arjun Mehta' });

    for (const other of [second, third]) {
      const closed = ok<Ticket>(await get(ws.agent, `/tickets/${String(other.number)}`));
      expect(closed).toMatchObject({ status: 'closed', mergedInto: { number: main.number } });
      expect(await historyOf(ws.agent, other.number)).toContainEqual({
        field: 'merged_into',
        from: null,
        to: main.number,
      });
    }
    // Lists (a contact's or company's tickets) say where each one went too.
    const listed = ok<{ tickets: Ticket[] }>(await get(ws.agent, '/tickets?status=closed'));
    expect(listed.tickets.map((ticket) => ticket.mergedInto)).toEqual([
      { number: main.number },
      { number: main.number },
    ]);
    // Merged tickets are read-only.
    const change = await patch(ws.agent, `/tickets/${String(second.number)}`, { priority: 'high' });
    expect(change.statusCode).toBe(409);
    expect(change.json<{ error: { message: string } }>().error.message).toBe(
      `This ticket was merged into #${String(main.number)}. Work on that one instead.`,
    );
    expect(
      (
        await post(ws.agent, `/tickets/${String(second.number)}/messages`, {
          kind: 'note',
          body: 'x',
        })
      ).statusCode,
    ).toBe(409);
    expect(await historyOf(ws.agent, main.number)).toContainEqual({
      field: 'merged',
      from: null,
      to: [second.number, third.number],
    });

    // Replies copy the merged requesters.
    ok(
      await post(ws.agent, `/tickets/${String(main.number)}/messages`, {
        kind: 'reply',
        body: 'Fixed.',
      }),
    );
    expect((await messagesOf(ws.agent, main.number)).at(-1)?.cc).toEqual(['arjun@acme.test']);

    const audit = ok<{ entries: { action: string; summary: string }[] }>(
      await get(ws.admin, '/audit-log?category=tickets'),
    ).entries;
    expect(audit[0]?.summary).toContain(
      `merged #${String(second.number)} and #${String(third.number)} into #${String(main.number)} Payslip missing, telling the customers.`,
    );

    // The customers are told, and their replies go to the main ticket.
    const { id: workspaceId, subdomain } = await workspaceOf(ws.admin);
    const jobs = await query<{ data: Record<string, unknown> }>(
      "SELECT data FROM pgboss.job WHERE name = 'customer-email' AND data->>'workspaceId' = :workspaceId AND data->>'event' = 'merged'",
      { workspaceId },
    );
    expect(jobs).toHaveLength(2);
    const emails = captureEmails();
    await sendCustomerEmail(
      { ...emailDeps(), email: emails.sender },
      jobs.find((job) => job.data.ticketId === second.id)?.data as Parameters<
        typeof sendCustomerEmail
      >[1],
    );
    expect(emails.sent[0]).toMatchObject({
      to: 'arjun@acme.test',
      replyTo: ticketReplyAddress(testConfig(), { id: workspaceId, subdomain }, main.number),
    });
    expect(emails.sent[0]?.text).toContain(`handled together with ticket #${String(main.number)}`);
  });

  it('sends replies to a merged ticket’s old thread to the main one', async () => {
    const ws = await teamWorkspace();
    const main = await newTicket(ws.agent, {
      subject: 'Main',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
    });
    const old = await newTicket(ws.agent, {
      subject: 'Old',
      contact: { name: 'Arjun Mehta', email: 'arjun@acme.test' },
    });
    ok(await post(ws.admin, `/tickets/${String(main.number)}/merge`, { numbers: [old.number] }));
    const workspace = await workspaceOf(ws.admin);
    const raw = await customerEmail(
      ticketReplyAddress(testConfig(), workspace, old.number),
      'Re: Old',
      'Any news?',
    );
    expect(await receiveEmail(emailDeps(), raw)).toMatchObject({
      result: 'reply',
      ticketNumber: main.number,
    });
    expect((await messagesOf(ws.agent, main.number)).at(-1)).toMatchObject({
      kind: 'customer',
      body: 'Any news?',
      fromTicketNumber: null,
    });
  });

  it('refuses what cannot be merged', async () => {
    const ws = await teamWorkspace();
    const contact = { name: 'Neha Iyer', email: 'neha@acme.test' };
    const [a, b, c] = [
      await newTicket(ws.agent, { subject: 'A', contact }),
      await newTicket(ws.agent, { subject: 'B', contact }),
      await newTicket(ws.agent, { subject: 'C', contact }),
    ];
    const merge = (number: number, numbers: number[]) =>
      post(ws.admin, `/tickets/${String(number)}/merge`, { numbers });
    expect((await merge(a.number, [])).statusCode).toBe(400);
    expect((await merge(a.number, [a.number])).statusCode).toBe(400);
    expect((await merge(a.number, [1, 2, 3, 4, 5])).statusCode).toBe(400);
    expect((await merge(a.number, [999])).statusCode).toBe(404);
    const removed = await send({
      method: 'DELETE',
      url: `/api/v1/tickets/${String(c.number)}`,
      ...as(ws.admin),
    });
    expect(removed.statusCode).toBe(204);
    expect((await merge(a.number, [c.number])).statusCode).toBe(409);
    ok(await merge(a.number, [b.number]));
    // Already merged: neither way round.
    expect((await merge(a.number, [b.number])).statusCode).toBe(409);
    expect((await merge(b.number, [a.number])).statusCode).toBe(409);
  });
});

describe('splitting a message', () => {
  it("makes a customer's message a new ticket with the same requester", async () => {
    const ws = await teamWorkspace();
    ok(
      await post(ws.admin, '/rules', {
        name: 'Tag new tickets',
        event: 'ticket_created',
        conditions: { match: 'all', items: [] },
        actions: [{ type: 'add_tags', value: ['new'] }],
      }),
    );
    const original = await newTicket(ws.agent, {
      subject: 'Payslip missing',
      contact: { name: 'Arjun Mehta', email: 'arjun@acme.test' },
      priority: 'high',
    });
    const workspace = await workspaceOf(ws.admin);
    const raw = await customerEmail(
      ticketReplyAddress(testConfig(), workspace, original.number),
      'Re: Payslip missing',
      'Also, my leave balance is wrong.',
    );
    expect(await receiveEmail(emailDeps(), raw)).toMatchObject({ result: 'reply' });
    const message = (await messagesOf(ws.agent, original.number)).find(
      (item) => item.kind === 'customer',
    );
    ok(
      await post(ws.agent, `/tickets/${String(original.number)}/messages`, {
        kind: 'note',
        body: 'Note',
      }),
    );
    const note = (await messagesOf(ws.agent, original.number)).find((item) => item.kind === 'note');

    expect(
      (await post(ws.agent, `/tickets/${String(original.number)}/messages/${note?.id ?? ''}/split`))
        .statusCode,
    ).toBe(409);
    const split = ok<Ticket>(
      await post(
        ws.agent,
        `/tickets/${String(original.number)}/messages/${message?.id ?? ''}/split`,
      ),
    );
    expect(split).toMatchObject({
      subject: 'Payslip missing',
      description: 'Also, my leave balance is wrong.',
      status: 'open',
      contact: { id: original.contact.id },
      tags: ['new'],
    });
    expect((await messagesOf(ws.agent, original.number)).map((item) => item.kind)).toEqual([
      'note',
    ]);
    expect(await historyOf(ws.agent, original.number)).toContainEqual({
      field: 'split_into',
      from: null,
      to: split.number,
    });
    expect(await historyOf(ws.agent, split.number)).toContainEqual({
      field: 'split_from',
      from: null,
      to: original.number,
    });
    expect(
      (
        await post(
          ws.agent,
          `/tickets/${String(original.number)}/messages/${message?.id ?? ''}/split`,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('merge and split access', () => {
  it('are per workspace', { timeout: 30_000 }, async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor'], (member) => ({
      method: 'POST',
      url: '/api/v1/tickets/1/merge',
      ...as(member),
      payload: { numbers: [999] },
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
        const contact = { name: 'Neha Iyer', email: 'neha@acme.test' };
        const a = await newTicket(ws.admin, { subject: 'Secret main ticket', contact });
        const b = await newTicket(ws.admin, { subject: 'Secret other ticket', contact });
        const split = await newTicket(ws.admin, { subject: 'Secret split ticket', contact });
        const raw = await customerEmail(
          ticketReplyAddress(testConfig(), await workspaceOf(ws.admin), split.number),
          'Re: Secret split ticket',
          'One more thing.',
        );
        await receiveEmail(emailDeps(), raw);
        const [message] = await messagesOf(ws.admin, split.number);
        return {
          secrets: ['Secret main ticket', 'Secret other ticket', 'Secret split ticket'],
          checks: [
            {
              kind: 'item',
              request: {
                method: 'POST',
                url: `/api/v1/tickets/${String(a.number)}/merge`,
                payload: { numbers: [b.number] },
              },
            },
            {
              kind: 'item',
              request: {
                method: 'POST',
                url: `/api/v1/tickets/${String(split.number)}/messages/${message?.id ?? ''}/split`,
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
  });

  it('answers a merge from the writer', async () => {
    const ws = await teamWorkspace();
    const contact = { name: 'Neha Iyer', email: 'neha@acme.test' };
    const a = await newTicket(ws.admin, { subject: 'Lagging main', contact });
    const b = await newTicket(ws.admin, { subject: 'Lagging other', contact });
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: `/api/v1/tickets/${String(a.number)}/merge`,
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: { numbers: [b.number] },
      },
      ['Lagging main', `"mergedInto":null`],
    );
  });
});
