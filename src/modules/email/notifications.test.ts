import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFileStorage } from '../../adapters/storage/index.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, type Member } from '../../test/accounts.js';
import { captureEmails, testConfig, testDatabase } from '../../test/helpers.js';
import { ticketReplyAddress } from './addresses.js';
import { receiveEmail } from './incoming.service.js';
import { sendCustomerEmail } from './outgoing.service.js';
import { REPLY_ABOVE_LINE, type CustomerNotification } from './templates.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

const config = testConfig();
const db = testDatabase();
const jobs = createJobQueue(db.writer);
const storage = createFileStorage(config);
afterAll(async () => {
  await jobs.stop();
  await db.close();
});

type Response = Awaited<ReturnType<typeof send>>;
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });

async function setup() {
  const ws = await teamWorkspace();
  const [row] = await query<{ id: string; subdomain: string }>(
    'SELECT id, subdomain FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: ws.admin.address.split('.')[0] },
  );
  if (!row) throw new Error('no workspace');
  return { ...ws, tenant: row, address: `${row.subdomain}@${config.TICKET_EMAIL_DOMAIN}` };
}

interface Job {
  data: { ticketId: string; event: CustomerNotification; agentName?: string };
}

/** The customer-email jobs waiting for this workspace (nothing processes them in tests). */
const queued = (workspaceId: string) =>
  query<Job>(
    "SELECT data FROM pgboss.job WHERE name = 'customer-email' AND data->>'workspaceId' = :workspaceId ORDER BY created_on",
    { workspaceId },
  );

/** Runs the queued notifications as the worker would, capturing what is sent. */
async function deliver(workspaceId: string) {
  const emails = captureEmails();
  for (const { data } of await queued(workspaceId)) {
    await sendCustomerEmail(
      { config, db, email: emails.sender, storage },
      { workspaceId, ...data },
    );
  }
  return emails.sent;
}

const settingsEntries = async (admin: Member) =>
  ok<{ entries: { action: string; summary: string }[] }>(
    await get(admin, '/audit-log?category=settings'),
  ).entries.filter((entry) => entry.action === 'workspace.customer_notifications_changed');

describe('customer notification emails', () => {
  it('tells a customer who emailed in that the request was received, on the same thread', async () => {
    const ws = await setup();
    const messageId = `<${randomUUID()}@customer.test>`;
    const raw = await new MailComposer({
      from: 'Neha Iyer <neha@acme.test>',
      to: ws.address,
      subject: 'Payslip missing',
      text: 'Help',
      messageId,
    })
      .compile()
      .build();
    await receiveEmail({ config, db, storage, jobs }, raw);
    expect((await queued(ws.tenant.id)).map((job) => job.data.event)).toEqual(['received']);

    const [email] = await deliver(ws.tenant.id);
    expect(email).toMatchObject({
      to: 'neha@acme.test',
      from: `"Acme Support" <${ws.address}>`,
      replyTo: ticketReplyAddress(config, ws.tenant, 1),
      subject: 'Re: Payslip missing [#1]',
      inReplyTo: messageId,
      references: [messageId],
    });
    expect(email?.text.startsWith(REPLY_ABOVE_LINE)).toBe(true);
    expect(email?.text).toContain('Hi Neha Iyer,');
    expect(email?.text).toContain('Your ticket number is #1: Payslip missing');
    expect(email?.html).toContain('We have received your request');
  });

  it('tells the requester when their ticket is resolved, unless it opened again meanwhile', async () => {
    const ws = await setup();
    ok(
      await post(ws.agent, '/tickets', {
        subject: 'VPN down',
        contact: { name: 'Raj', email: 'raj@acme.test' },
      }),
    );
    // Agent-created tickets queue their email, which is off by default.
    expect(await deliver(ws.tenant.id)).toEqual([]);

    ok(await patch(ws.agent, '/tickets/1', { status: 'resolved' }));
    // Saving it resolved again is no new resolution.
    ok(await patch(ws.agent, '/tickets/1', { status: 'resolved', priority: 'high' }));
    expect((await queued(ws.tenant.id)).map((job) => job.data.event)).toEqual([
      'agentCreated',
      'resolved',
    ]);
    const [resolved] = await deliver(ws.tenant.id);
    expect(resolved).toMatchObject({ to: 'raj@acme.test', subject: 'Re: VPN down [#1]' });
    expect(resolved?.text).toContain('We have marked your ticket #1 (VPN down) as resolved.');
    expect(resolved?.text).toContain('reply to this email and the ticket opens again');

    ok(await patch(ws.agent, '/tickets/1', { status: 'open' }));
    expect(await deliver(ws.tenant.id)).toEqual([]);
  });

  it('follows the workspace settings, audited, even for emails already queued', async () => {
    const ws = await setup();
    ok(
      await post(ws.agent, '/tickets', {
        subject: 'Printer',
        contact: { name: 'Asha', email: 'asha@acme.test' },
      }),
    );
    expect(
      ok(
        await patch(ws.admin, '/workspace/email', {
          customerNotifications: { agentCreated: true, resolved: false },
        }),
      ),
    ).toMatchObject({
      senderName: null,
      customerNotifications: { received: true, resolved: false, agentCreated: true },
    });
    const [opened] = await deliver(ws.tenant.id);
    expect(opened).toMatchObject({ to: 'asha@acme.test', subject: 'Printer [#1]' });
    expect(opened?.text).toMatch(/opened ticket #1 for you: Printer/);

    ok(await patch(ws.agent, '/tickets/1', { status: 'resolved' }));
    expect((await deliver(ws.tenant.id)).map((email) => email.subject)).toEqual(['Printer [#1]']);
    expect((await settingsEntries(ws.admin)).map((entry) => entry.summary)).toEqual([
      'Ravi Shankar turned off the "ticket resolved" email and turned on the "ticket opened for you" email.',
    ]);
    // Saving the same settings again records nothing.
    ok(await patch(ws.admin, '/workspace/email', { customerNotifications: { resolved: false } }));
    expect(await settingsEntries(ws.admin)).toHaveLength(1);
  });

  it('sends nothing to a requester without email or on a workspace address, or about a deleted ticket', async () => {
    const ws = await setup();
    ok(
      await patch(ws.admin, '/workspace/email', { customerNotifications: { agentCreated: true } }),
    );
    ok(
      await post(ws.admin, '/tickets', {
        subject: 'Phoned',
        contact: { name: 'Caller', phone: '1' },
      }),
    );
    ok(
      await post(ws.admin, '/tickets', {
        subject: 'Loop',
        contact: { name: 'Us', email: `other@${config.TICKET_EMAIL_DOMAIN}` },
      }),
    );
    ok(
      await post(ws.admin, '/tickets', {
        subject: 'Gone',
        contact: { name: 'Raj', email: 'raj@acme.test' },
      }),
    );
    const removed = await send({ method: 'DELETE', url: '/api/v1/tickets/3', ...as(ws.admin) });
    expect(removed.statusCode).toBe(204);
    expect(await deliver(ws.tenant.id)).toEqual([]);
  });
});
