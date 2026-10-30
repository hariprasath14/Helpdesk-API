import { afterAll, describe, expect, it } from 'vitest';
import type { EmailSender } from '../../adapters/email/index.js';
import { createFileStorage } from '../../adapters/storage/index.js';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { captureEmails, LAGGING_READER, testConfig, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { cleanAbandonedUploads } from '../conversation/attachments.service.js';
import { readTicketAddress, ticketReplyAddress } from './addresses.js';
import { sendAssignmentEmail, sendTicketEmail, type OutgoingDeps } from './outgoing.service.js';
import { REPLY_ABOVE_LINE } from './templates.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

type Response = Awaited<ReturnType<typeof send>>;
interface Message {
  id: string;
  kind: string;
  emailStatus: string | null;
  emailSentAt: string | null;
  emailError: string | null;
}

const config = testConfig();
const db = testDatabase();
afterAll(() => db.close());

/** What the worker uses, with emails captured (or a sender that fails). */
function outgoing(email: EmailSender = captureEmails().sender): OutgoingDeps {
  return { config, db, email, storage: createFileStorage(config) };
}
const quiet = { warn: () => undefined };
const FIRST_TRY = { retryCount: 0, retryLimit: 4 };
const LAST_TRY = { retryCount: 4, retryLimit: 4 };
const failing: EmailSender = { send: () => Promise.reject(new Error('Mail server said no')) };

const post = (member: Member, url: string, payload: Record<string, unknown> = {}) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};

async function workspaceOf(member: Member) {
  const [row] = await query<{ id: string; subdomain: string }>(
    'SELECT id, subdomain FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: member.address.split('.')[0] },
  );
  if (!row) throw new Error('no workspace');
  return row;
}

/** Jobs waiting in a queue for this workspace (nothing processes them during tests). */
const jobsFor = (queue: string, workspaceId: string) =>
  query<{ data: Record<string, string> }>(
    "SELECT data FROM pgboss.job WHERE name = :queue AND data->>'workspaceId' = :workspaceId ORDER BY created_on",
    { queue, workspaceId },
  );

/** A workspace with ticket #1 from Neha (neha@acme.com), "Payslip missing". */
async function setup() {
  const ws = await teamWorkspace();
  const neha = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Neha Iyer', email: 'neha@acme.com' }),
  );
  ok(
    await post(ws.admin, '/tickets', {
      contactId: neha.id,
      subject: 'Payslip missing',
      description: 'My October payslip is not in the portal.',
    }),
  );
  return { ...ws, tenant: await workspaceOf(ws.admin) };
}

/** The send job for a message, as the API queues it. */
const jobOf = (ws: { tenant: { id: string } }, message: { id: string } | undefined) => ({
  workspaceId: ws.tenant.id,
  messageId: message?.id ?? '',
});

const reply = async (member: Member, payload: Record<string, unknown>) =>
  ok<{ messages: Message[] }>(await post(member, '/tickets/1/messages', payload)).messages.at(-1);

describe('sending replies and forwards', () => {
  it('queues each reply with its send job and emails it once, threaded and signed', async () => {
    const ws = await setup();
    const first = await reply(ws.agent, {
      kind: 'reply',
      body: 'Hello Neha',
      cc: ['boss@acme.com'],
    });
    if (!first) throw new Error('no reply');
    expect(first).toMatchObject({ emailStatus: 'queued', emailSentAt: null, emailError: null });
    expect((await jobsFor('ticket-email', ws.tenant.id)).map((job) => job.data)).toEqual([
      { workspaceId: ws.tenant.id, messageId: first.id },
    ]);
    // Notes are never emailed.
    await reply(ws.agent, { kind: 'note', body: 'Internal' });
    expect(await jobsFor('ticket-email', ws.tenant.id)).toHaveLength(1);

    const emails = captureEmails();
    await sendTicketEmail(outgoing(emails.sender), jobOf(ws, first), FIRST_TRY, quiet);
    const domain = config.TICKET_EMAIL_DOMAIN;
    expect(emails.sent).toHaveLength(1);
    const email = emails.sent[0];
    expect(email).toMatchObject({
      to: 'neha@acme.com',
      cc: ['boss@acme.com'],
      from: `"Acme Support" <${ws.tenant.subdomain}@${domain}>`,
      replyTo: ticketReplyAddress(config, ws.tenant, 1),
      subject: 'Re: Payslip missing [#1]',
      messageId: `<${first.id}@${domain}>`,
      attachments: [],
    });
    expect(email?.inReplyTo).toBeUndefined();
    expect(email?.text.startsWith(REPLY_ABOVE_LINE)).toBe(true);
    expect(email?.text).toContain('Hello Neha');
    expect(email?.text).toContain('> My October payslip is not in the portal.');
    expect(email?.text).toContain('This email is about ticket #1.');
    expect(email?.html).toContain('Hello Neha');

    const sent = ok<{ messages: Message[] }>(await get(ws.agent, '/tickets/1/messages')).messages;
    expect(sent[0]).toMatchObject({ emailStatus: 'sent', emailError: null });
    expect(sent[0]?.emailSentAt).not.toBeNull();

    // A job that runs again (a retry after a crash) does not send twice.
    await sendTicketEmail(outgoing(emails.sender), jobOf(ws, first), FIRST_TRY, quiet);
    expect(emails.sent).toHaveLength(1);

    // The next reply is threaded under the first.
    const second = await reply(ws.agent, { kind: 'reply', body: 'Fixed now' });
    if (!second) throw new Error('no reply');
    await sendTicketEmail(outgoing(emails.sender), jobOf(ws, second), FIRST_TRY, quiet);
    expect(emails.sent[1]).toMatchObject({
      inReplyTo: `<${first.id}@${domain}>`,
      references: [`<${first.id}@${domain}>`],
    });
    expect(emails.sent[1]?.text).toContain('> Hello Neha');
  });

  it('forwards with the conversation quoted, and attaches files', async () => {
    const ws = await setup();
    await reply(ws.agent, { kind: 'reply', body: 'Looking into it' });
    const forward = await reply(ws.agent, {
      kind: 'forward',
      body: 'Can payroll check this?',
      to: ['payroll@acme.com'],
    });
    if (!forward) throw new Error('no forward');
    const emails = captureEmails();
    await sendTicketEmail(outgoing(emails.sender), jobOf(ws, forward), FIRST_TRY, quiet);
    expect(emails.sent[0]).toMatchObject({
      to: 'payroll@acme.com',
      cc: [],
      subject: 'Fwd: Payslip missing [#1]',
    });
    expect(emails.sent[0]?.text).toContain('Forwarded ticket #1: Payslip missing');
    expect(emails.sent[0]?.text).toContain('> Looking into it');
    expect(emails.sent[0]?.text).toContain('> My October payslip is not in the portal.');
  });

  it('retries a failed send, then shows why it failed and sends it again on request', async () => {
    const ws = await setup();
    const message = await reply(ws.agent, { kind: 'reply', body: 'Hello' });
    if (!message) throw new Error('no reply');
    const job = { workspaceId: ws.tenant.id, messageId: message.id };

    // Not the last try: the queue retries it, and the ticket still shows it as being sent.
    await expect(sendTicketEmail(outgoing(failing), job, FIRST_TRY, quiet)).rejects.toThrow(
      'Mail server said no',
    );
    const [queued] = ok<{ messages: Message[] }>(
      await get(ws.agent, '/tickets/1/messages'),
    ).messages;
    expect(queued).toMatchObject({ emailStatus: 'queued', emailError: null });

    await sendTicketEmail(outgoing(failing), job, LAST_TRY, quiet);
    const [failed] = ok<{ messages: Message[] }>(
      await get(ws.agent, '/tickets/1/messages'),
    ).messages;
    expect(failed).toMatchObject({ emailStatus: 'failed', emailError: 'Mail server said no' });
    const [attempts] = await query<{ email_attempts: number }>(
      'SELECT email_attempts FROM ticket_messages WHERE id = :id',
      { id: message.id },
    );
    expect(attempts?.email_attempts).toBe(2);

    // Send again: queued with a new job.
    const url = `/tickets/1/messages/${message.id}/resend`;
    const [again] = ok<{ messages: Message[] }>(await post(ws.agent, url)).messages;
    expect(again).toMatchObject({ emailStatus: 'queued', emailError: null });
    expect(await jobsFor('ticket-email', ws.tenant.id)).toHaveLength(2);
    // Only a failed one can be sent again.
    expect((await post(ws.agent, url)).statusCode).toBe(409);
    const note = await reply(ws.agent, { kind: 'note', body: 'Note' });
    const noteUrl = `/tickets/1/messages/${note?.id ?? ''}/resend`;
    expect((await post(ws.agent, noteUrl)).statusCode).toBe(404);
  });

  it('sends nothing for a message of another workspace', async () => {
    const ws = await setup();
    const other = await setup();
    const message = await reply(ws.agent, { kind: 'reply', body: 'Hello' });
    const emails = captureEmails();
    await sendTicketEmail(
      outgoing(emails.sender),
      { workspaceId: other.tenant.id, messageId: message?.id ?? '' },
      FIRST_TRY,
      quiet,
    );
    expect(emails.sent).toEqual([]);
  });

  it("never resends another workspace's message", { timeout: 30_000 }, async () => {
    const owner = await setup();
    const intruder = await setup();
    const message = await reply(owner.agent, { kind: 'reply', body: 'Hello' });
    await sendTicketEmail(
      outgoing(failing),
      { workspaceId: owner.tenant.id, messageId: message?.id ?? '' },
      LAST_TRY,
      quiet,
    );
    const byAddress = new Map([
      [owner.admin.address, owner.admin],
      [intruder.admin.address, intruder.admin],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.admin.address, intruder: intruder.admin.address },
      setup: () =>
        Promise.resolve({
          secrets: ['Mail server said no'],
          checks: [
            {
              kind: 'item',
              request: {
                method: 'POST',
                url: `/api/v1/tickets/1/messages/${message?.id ?? ''}/resend`,
              },
            },
          ],
        }),
      actAs: (address) => {
        const member = byAddress.get(address);
        if (!member) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: member.address, cookie: member.cookie, 'x-csrf-token': member.csrf },
        });
      },
    });
  });
});

describe('the "assigned to you" email', () => {
  it('is queued when someone else assigns you, and sent only if it is still yours', async () => {
    const ws = await setup();
    ok(await patch(ws.admin, '/tickets/1', { assigneeUserId: ws.agent.userId }));
    // Taking a ticket yourself sends nothing.
    ok(await patch(ws.supervisor, '/tickets/1', { assigneeUserId: ws.supervisor.userId }));
    const jobs = await jobsFor('assignment-email', ws.tenant.id);
    expect(jobs.map((job) => job.data.assigneeUserId)).toEqual([ws.agent.userId]);
    const job = jobs[0]?.data;
    if (!job) throw new Error('no job');

    // The ticket has moved on to the supervisor: nothing is sent.
    const emails = captureEmails();
    const assignment = {
      workspaceId: ws.tenant.id,
      ticketId: job.ticketId ?? '',
      assigneeUserId: ws.agent.userId,
      assignedBy: job.assignedBy ?? '',
    };
    await sendAssignmentEmail(outgoing(emails.sender), assignment);
    expect(emails.sent).toEqual([]);

    ok(await patch(ws.supervisor, '/tickets/1', { assigneeUserId: ws.agent.userId }));
    await sendAssignmentEmail(outgoing(emails.sender), assignment);
    expect(emails.sent[0]).toMatchObject({
      to: ws.agent.email,
      subject: 'Ticket #1 assigned to you: Payslip missing',
    });
    expect(emails.sent[0]?.text).toContain(`http://${ws.tenant.subdomain}.helpdesk.test/tickets/1`);
  });

  it('is queued for a ticket created already assigned', async () => {
    const ws = await setup();
    const contact = ok<{ id: string }>(
      await post(ws.admin, '/contacts', { name: 'Raj', email: 'raj@acme.com' }),
    );
    ok(
      await post(ws.admin, '/tickets', {
        contactId: contact.id,
        subject: 'VPN down',
        assigneeUserId: ws.agent.userId,
      }),
    );
    expect(await jobsFor('assignment-email', ws.tenant.id)).toHaveLength(1);
  });
});

describe('Settings → Email', () => {
  it('shows and changes the sender name customers see, audited', async () => {
    const ws = await setup();
    const address = `${ws.tenant.subdomain}@${config.TICKET_EMAIL_DOMAIN}`;
    expect(ok(await get(ws.admin, '/workspace/email'))).toEqual({
      senderName: null,
      workspaceName: 'Acme Support',
      address,
      from: `"Acme Support" <${address}>`,
      customerNotifications: { received: true, resolved: true, agentCreated: false },
    });
    expect(
      ok(await patch(ws.admin, '/workspace/email', { senderName: '  Acme Helpdesk  ' })),
    ).toMatchObject({ senderName: 'Acme Helpdesk', from: `"Acme Helpdesk" <${address}>` });
    expect(
      (await patch(ws.admin, '/workspace/email', { senderName: 'x'.repeat(81) })).statusCode,
    ).toBe(400);

    const message = await reply(ws.agent, { kind: 'reply', body: 'Hi' });
    const emails = captureEmails();
    await sendTicketEmail(outgoing(emails.sender), jobOf(ws, message), FIRST_TRY, quiet);
    expect(emails.sent[0]?.from).toBe(`"Acme Helpdesk" <${address}>`);
    expect(emails.sent[0]?.text).toContain('--\nAna Agent'.slice(0, 3));

    // Empty goes back to the workspace name.
    expect(ok(await patch(ws.admin, '/workspace/email', { senderName: '' }))).toMatchObject({
      senderName: null,
    });
    const audit = ok<{ entries: { action: string; summary: string }[] }>(
      await get(ws.admin, '/audit-log?category=settings'),
    ).entries.filter((entry) => entry.action === 'workspace.email_sender_changed');
    expect(audit.map((entry) => entry.summary)).toEqual([
      'Ravi Shankar set the email sender name back to the workspace name.',
      'Ravi Shankar changed the email sender name to "Acme Helpdesk".',
    ]);
  });

  it('sends the admin a test email from the workspace address', async () => {
    const ws = await setup();
    const response = ok<{ to: string }>(await post(ws.admin, '/workspace/email/test'));
    expect(response.to).toBe(ws.admin.email);
    const email = kit.emails.lastTo(ws.admin.email);
    expect(email?.from).toBe(
      `"Acme Support" <${ws.tenant.subdomain}@${config.TICKET_EMAIL_DOMAIN}>`,
    );
    expect(email?.subject).toBe('Test email from Acme Support');
  });

  it('is for admins only', async () => {
    const ws = await setup();
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      url: '/api/v1/workspace/email',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'PATCH',
      url: '/api/v1/workspace/email',
      ...as(member),
      payload: { senderName: 'Acme' },
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'POST',
      url: '/api/v1/workspace/email/test',
      ...as(member),
    }));
  });

  it('answers a change from the writer', async () => {
    const ws = await setup();
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/workspace/email',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: { senderName: 'Lagging Name' },
      },
      ['Lagging Name'],
    );
  });
});

describe('reply addresses', () => {
  it('reads back the workspace and ticket, and ignores a changed number or signature', () => {
    const workspace = { id: '0b8f1c1e-7a52-4e2f-9a5e-2f0c1b7a9d11', subdomain: 'acme' };
    const idOf = (subdomain: string) => (subdomain === 'acme' ? workspace.id : null);
    const address = ticketReplyAddress(config, workspace, 42);
    expect(address).toMatch(/^acme\+42-[0-9a-f]{12}@/);
    expect(readTicketAddress(config, address.toUpperCase(), idOf)).toEqual({
      subdomain: 'acme',
      ticketNumber: 42,
    });
    expect(readTicketAddress(config, address.replace('+42-', '+43-'), idOf)).toEqual({
      subdomain: 'acme',
      ticketNumber: null,
    });
    expect(readTicketAddress(config, `acme@${config.TICKET_EMAIL_DOMAIN}`, idOf)).toEqual({
      subdomain: 'acme',
      ticketNumber: null,
    });
    expect(readTicketAddress(config, 'acme@example.com', idOf)).toBeNull();
    expect(readTicketAddress(config, `Acme Team@${config.TICKET_EMAIL_DOMAIN}`, idOf)).toBeNull();
  });
});

describe('the daily clean-up of unsent uploads', () => {
  it('removes uploads older than a day that were never sent, in every workspace', async () => {
    const ws = await setup();
    const [old, recent] = await query<{ id: string }>(
      `INSERT INTO ticket_attachments
         (id, workspace_id, uploaded_by_user_id, file_name, content_type, size_bytes, created_at)
       VALUES (gen_random_uuid(), :workspaceId, :userId, 'old.txt', 'text/plain', 1, now() - interval '2 days'),
              (gen_random_uuid(), :workspaceId, :userId, 'new.txt', 'text/plain', 1, now())
       RETURNING id`,
      { workspaceId: ws.tenant.id, userId: ws.agent.userId },
    );
    // Another test file's worker may clean up first, so only what is left is checked.
    await cleanAbandonedUploads({ db, storage: createFileStorage(config) });
    const left = await query<{ id: string }>(
      'SELECT id FROM ticket_attachments WHERE id IN (:ids)',
      { ids: [old?.id, recent?.id] },
    );
    expect(left.map((row) => row.id)).toEqual([recent?.id]);
  });
});
