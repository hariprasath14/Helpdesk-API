import { randomUUID } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
  createInboundMailboxes,
  mailpitMailbox,
  s3Mailbox,
  type InboundMailbox,
  type S3Sender,
} from '../../adapters/inbound-email/index.js';
import { createFileStorage } from '../../adapters/storage/index.js';
import { handleInboundEmail, takeInboundEmail } from '../../jobs/inbound.js';
import { createJobQueue } from '../../jobs/queue.js';
import { accountsKit, as, type Member } from '../../test/accounts.js';
import { captureEmails, testConfig, testDatabase } from '../../test/helpers.js';
import { ticketReplyAddress } from './addresses.js';
import { customerText, MAX_EMAILS_PER_SENDER_HOUR, receiveEmail } from './incoming.service.js';
import { sendTicketEmail } from './outgoing.service.js';
import { REPLY_ABOVE_LINE } from './templates.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

const config = testConfig();
const db = testDatabase();
const storage = createFileStorage(config);
const jobs = createJobQueue(db.writer);
const deps = { config, db, storage, jobs };
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
const post = (member: Member, url: string, payload: Record<string, unknown> = {}) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });

interface Ticket {
  number: number;
  subject: string;
  description: string;
  status: string;
  source: string;
  contact: { name: string; email: string | null };
  createdBy: unknown;
}
interface Conversation {
  messages: {
    id: string;
    kind: string;
    body: string;
    author: { type: string; name: string } | null;
    attachments: { fileName: string }[];
  }[];
  descriptionFiles: { id: string; fileName: string; size: number }[];
}

/** A raw email, as a mail server would hand it over. */
function email(options: Mail.Options): Promise<Buffer> {
  return new MailComposer({
    messageId: `<${randomUUID()}@customer.test>`,
    date: new Date(),
    ...options,
  })
    .compile()
    .build();
}

async function setup() {
  const ws = await teamWorkspace();
  const [row] = await query<{ id: string; subdomain: string }>(
    'SELECT id, subdomain FROM workspaces WHERE subdomain = :subdomain',
    { subdomain: ws.admin.address.split('.')[0] },
  );
  if (!row) throw new Error('no workspace');
  return { ...ws, tenant: row, address: `${row.subdomain}@${config.TICKET_EMAIL_DOMAIN}` };
}

describe('email to a workspace address', () => {
  it('becomes a ticket from the sender, with the files that came with it', async () => {
    const ws = await setup();
    const outcome = await receiveEmail(
      deps,
      await email({
        from: '"Neha Iyer" <Neha@Acme.test>',
        to: ws.address,
        subject: "  Employees can't   mark attendance ",
        text: 'Since this morning.\nAll branches.',
        html: '<p>Since this morning.<br>All branches.</p><script>alert(1)</script>',
        attachments: [
          { filename: 'screen.png', content: Buffer.alloc(20_000, 1), contentType: 'image/png' },
          { filename: 'run-me.exe', content: Buffer.from('MZ') },
          {
            filename: 'logo.png',
            content: Buffer.alloc(500, 2),
            contentType: 'image/png',
            cid: 'logo@acme',
          },
        ],
      }),
    );
    expect(outcome).toEqual({ result: 'ticket', workspaceId: ws.tenant.id, ticketNumber: 1 });

    const ticket = ok<Ticket>(await get(ws.agent, '/tickets/1'));
    expect(ticket).toMatchObject({
      subject: "Employees can't mark attendance",
      status: 'open',
      source: 'email',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      createdBy: null,
    });
    expect(ticket.description).toBe(
      'Since this morning.\nAll branches.\n\n[Files not added: run-me.exe (a program)]',
    );
    const conversation = ok<Conversation>(await get(ws.agent, '/tickets/1/messages'));
    expect(conversation.messages).toEqual([]);
    expect(conversation.descriptionFiles).toMatchObject([{ fileName: 'screen.png', size: 20_000 }]);
    const file = conversation.descriptionFiles[0]?.id ?? '';
    const download = await get(ws.agent, `/attachments/${file}`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.length).toBe(20_000);

    const history = ok<{ activity: { actor: { name: string }; action: string }[] }>(
      await get(ws.agent, '/tickets/1/activity'),
    ).activity;
    expect(history).toMatchObject([{ action: 'created', actor: { name: 'Neha Iyer' } }]);
  });

  it('threads replies by Message-ID or the signed reply address, and opens the ticket again', async () => {
    const ws = await setup();
    await receiveEmail(
      deps,
      await email({
        from: 'Neha Iyer <neha@acme.test>',
        to: ws.address,
        subject: 'Payslip',
        text: 'Missing',
      }),
    );
    // The agent replies; the worker sends it with its own Message-ID.
    const sent = ok<Conversation>(
      await post(ws.agent, '/tickets/1/messages', {
        kind: 'reply',
        body: 'Can you send a screenshot?',
        status: 'waiting_on_customer',
      }),
    ).messages[0];
    const emails = captureEmails();
    await sendTicketEmail(
      { ...deps, email: emails.sender },
      { workspaceId: ws.tenant.id, messageId: sent?.id ?? '' },
      { retryCount: 0, retryLimit: 4 },
      { warn: () => undefined },
    );
    const ours = emails.sent[0];
    expect(ours?.references?.length).toBe(1);

    // The customer answers from their email program, above the quoted email.
    const answer = await receiveEmail(
      deps,
      await email({
        from: 'Neha Iyer <neha@acme.test>',
        to: ours?.replyTo,
        subject: `Re: ${ours?.subject ?? ''}`,
        inReplyTo: ours?.messageId,
        references: ours?.references,
        text: `Here it is.\n\nThanks\n\nOn Tue, 27 Oct 2026 at 10:00, Acme Support <${ws.address}>\nwrote:\n> ${REPLY_ABOVE_LINE}\n>\n> Can you send a screenshot?`,
        attachments: [{ filename: 'payslip.pdf', content: Buffer.alloc(12_000, 3) }],
      }),
    );
    expect(answer).toEqual({ result: 'reply', workspaceId: ws.tenant.id, ticketNumber: 1 });
    const conversation = ok<Conversation>(await get(ws.agent, '/tickets/1/messages'));
    expect(conversation.messages.at(-1)).toMatchObject({
      kind: 'customer',
      body: 'Here it is.\n\nThanks',
      author: { type: 'contact', name: 'Neha Iyer' },
      attachments: [{ fileName: 'payslip.pdf' }],
    });
    expect(ok<Ticket>(await get(ws.agent, '/tickets/1')).status).toBe('open');
    const history = ok<{ activity: { actor: { name: string }; changes: unknown[] }[] }>(
      await get(ws.agent, '/tickets/1/activity'),
    ).activity;
    expect(history.at(-1)).toMatchObject({
      actor: { name: 'Neha Iyer' },
      changes: [{ field: 'status', from: 'waiting_on_customer', to: 'open' }],
    });

    // No threading headers at all (some programs drop them): the signed address still works.
    expect(
      await receiveEmail(
        deps,
        await email({ from: 'neha@acme.test', to: ours?.replyTo, subject: 'x', text: 'Also' }),
      ),
    ).toMatchObject({ result: 'reply', ticketNumber: 1 });
    // A changed number or signature is just a new email to the workspace.
    const forged = ticketReplyAddress(config, ws.tenant, 1).replace('+1-', '+2-');
    expect(
      await receiveEmail(
        deps,
        await email({ from: 'neha@acme.test', to: forged, subject: 'Other', text: 'New' }),
      ),
    ).toMatchObject({ result: 'ticket', ticketNumber: 2 });

    // Replying to the next reply threads it under both emails.
    await post(ws.agent, '/tickets/1/messages', { kind: 'reply', body: 'Thanks, fixed.' });
    const next = ok<Conversation>(await get(ws.agent, '/tickets/1/messages')).messages.at(-1);
    await sendTicketEmail(
      { ...deps, email: emails.sender },
      { workspaceId: ws.tenant.id, messageId: next?.id ?? '' },
      { retryCount: 0, retryLimit: 4 },
      { warn: () => undefined },
    );
    expect(emails.sent[1]?.references?.length).toBe(4);
  });

  it('adds the same email once, and starts a new ticket for a closed or deleted one', async () => {
    const ws = await setup();
    const raw = await email({
      from: 'raj@acme.test',
      to: ws.address,
      subject: 'VPN',
      text: 'Down',
    });
    expect(await receiveEmail(deps, raw)).toMatchObject({ result: 'ticket', ticketNumber: 1 });
    expect(await receiveEmail(deps, raw)).toEqual({
      result: 'duplicate',
      workspaceId: ws.tenant.id,
    });
    const [original] = await query<{ email_message_id: string }>(
      'SELECT email_message_id FROM tickets WHERE workspace_id = :id',
      { id: ws.tenant.id },
    );

    ok(await patch(ws.admin, '/tickets/1', { status: 'closed' }));
    const late = await receiveEmail(
      deps,
      await email({
        from: 'raj@acme.test',
        to: ws.address,
        subject: 'Re: VPN',
        inReplyTo: original?.email_message_id,
        text: 'Down again',
      }),
    );
    expect(late).toMatchObject({ result: 'ticket', ticketNumber: 2 });
    expect(ok<Ticket>(await get(ws.agent, '/tickets/2')).description).toBe(
      'This email answers ticket #1, which is closed.\n\nDown again',
    );
  });

  it('ignores automatic email, bounces, its own mail and unknown addresses', async () => {
    const ws = await setup();
    const from = 'neha@acme.test';
    const cases: [Mail.Options, string][] = [
      [{ headers: { 'Auto-Submitted': 'auto-replied' } }, 'an automatic email (Auto-Submitted)'],
      [{ headers: { Precedence: 'bulk' } }, 'bulk email (bulk)'],
      [{ headers: { 'X-Autoreply': 'yes' } }, 'an auto-reply'],
      [{ headers: { 'X-Loop': ws.address } }, 'a mail loop'],
      [{ from: 'MAILER-DAEMON@mx.acme.test' }, 'a bounce'],
      [{ from: `other@${config.TICKET_EMAIL_DOMAIN}` }, 'sent from a workspace address'],
      [{ to: `no-such-workspace@${config.TICKET_EMAIL_DOMAIN}` }, 'unknown workspace address'],
      [{ to: 'someone@elsewhere.test' }, 'no workspace address'],
    ];
    for (const [options, reason] of cases) {
      expect(
        await receiveEmail(
          deps,
          await email({ from, to: ws.address, subject: 'Out of office', text: 'Away', ...options }),
        ),
      ).toEqual({ result: 'ignored', reason });
    }
    // A company's support@ group forwarding to the workspace (a mailing list) is welcome.
    expect(
      await receiveEmail(
        deps,
        await email({
          from,
          to: 'support@acme.test',
          cc: ws.address,
          subject: 'Help',
          text: 'Please',
          headers: { Precedence: 'list', 'List-Id': 'support.acme.test' },
        }),
      ),
    ).toMatchObject({ result: 'ticket' });
  });

  it(
    'stops a sender who emails too often (a mail loop with another system)',
    { timeout: 30_000 },
    async () => {
      const ws = await setup();
      const from = 'robot@acme.test';
      for (let n = 0; n < MAX_EMAILS_PER_SENDER_HOUR; n += 1) {
        await receiveEmail(
          deps,
          await email({ from, to: ws.address, subject: `Alert ${String(n)}`, text: 'Disk full' }),
        );
      }
      expect(
        await receiveEmail(
          deps,
          await email({ from, to: ws.address, subject: 'Alert again', text: 'Disk full' }),
        ),
      ).toEqual({ result: 'ignored', reason: 'too many emails from this sender' });
    },
  );

  it('creates the ticket and contact even when fields are required', async () => {
    const ws = await setup();
    for (const recordType of ['contact', 'ticket']) {
      ok(
        await post(ws.admin, '/custom-fields', {
          recordType,
          label: `Region ${recordType}`,
          type: 'text',
          required: 'always',
        }),
      );
    }
    expect(
      await receiveEmail(
        deps,
        await email({ from: 'new@acme.test', to: ws.address, subject: 'Hi', text: 'Hello' }),
      ),
    ).toMatchObject({ result: 'ticket', ticketNumber: 1 });
    // A member who changes the ticket is asked for the required field.
    expect((await patch(ws.agent, '/tickets/1', { priority: 'high' })).statusCode).toBe(400);
  });

  it('keeps only what the customer wrote', () => {
    expect(
      customerText(`Yes, works.\r\n\r\nOn Tue, Ravi wrote:\r\n> ${REPLY_ABOVE_LINE}\r\n> Old`),
    ).toBe('Yes, works.');
    expect(customerText('Thanks!\n\n> earlier text\n> more')).toBe('Thanks!');
    expect(customerText('Line one\nOn the way\nwrote: a poem')).toBe(
      'Line one\nOn the way\nwrote: a poem',
    );
    expect(customerText('x'.repeat(30_000)).length).toBe(20_000);
  });
});

describe('searching inside tickets', () => {
  it('finds words in descriptions and messages, from their start, only in this workspace', async () => {
    const ws = await setup();
    const other = await setup();
    await receiveEmail(
      deps,
      await email({
        from: 'neha@acme.test',
        to: ws.address,
        subject: 'Payslip',
        text: 'The biometric device shows error E42. हाज़िरी नहीं लगी. Ref INV/2026/42',
      }),
    );
    await receiveEmail(
      deps,
      await email({
        from: 'neha@acme.test',
        to: other.address,
        subject: 'Payslip',
        text: 'The biometric device shows error E42',
      }),
    );
    ok(await post(ws.agent, '/tickets/1/messages', { kind: 'note', body: 'Vendor ticket ZX-981' }));
    const numbers = async (member: Member, q: string) =>
      ok<{ tickets: { number: number }[] }>(
        await get(member, `/tickets?view=all&q=${encodeURIComponent(q)}`),
      ).tickets.map((ticket) => ticket.number);

    expect(await numbers(ws.agent, 'biometric')).toEqual([1]);
    expect(await numbers(ws.agent, 'biomet erro')).toEqual([1]);
    expect(await numbers(ws.agent, 'zx-981')).toEqual([1]);
    expect(await numbers(ws.agent, 'हाज़िरी')).toEqual([1]);
    expect(await numbers(ws.agent, 'inv/2026')).toEqual([1]);
    expect(await numbers(ws.agent, 'biometric printer')).toEqual([]);
    // Quotes, backslashes and search syntax are just text.
    expect(await numbers(ws.agent, "it's \\ | & !:*")).toEqual([]);
    // The other workspace's ticket has the same words; each sees only its own.
    expect(await numbers(other.agent, 'zx')).toEqual([]);
    expect(await numbers(other.agent, 'biometric')).toEqual([1]);
  });
});

describe('picking up email from Mailpit', () => {
  it('stores each email, queues it, then removes it; the job makes the ticket', async () => {
    const ws = await setup();
    const raw = await email({ from: 'neha@acme.test', to: ws.address, subject: 'Hi', text: 'Hey' });
    const removed: string[][] = [];
    const mailbox: InboundMailbox = {
      take: () => Promise.resolve([{ id: 'm1', raw }]),
      remove: (ids) => {
        removed.push(ids);
        return Promise.resolve();
      },
    };
    const jobs: { key: string }[] = [];
    expect(
      await takeInboundEmail(mailbox, storage, 1024 * 1024, (job) => {
        jobs.push(job);
        return Promise.resolve();
      }),
    ).toBe(1);
    expect(removed).toEqual([['m1']]);
    expect(jobs[0]?.key).toMatch(/^inbound\/[0-9a-f-]{36}$/);

    const logged: object[] = [];
    const job = jobs[0] ?? { key: '' };
    await handleInboundEmail(deps, job, { info: (data: object) => logged.push(data) });
    expect(logged).toMatchObject([{ result: 'ticket', ticketNumber: 1 }]);
    // Run again (a retry after the email was handled): nothing happens.
    await handleInboundEmail(deps, job, { info: (data: object) => logged.push(data) });
    expect(logged).toHaveLength(1);
  });

  it("reads Mailpit's API: To, Cc and Bcc on the ticket domain, too-large ones removed", async () => {
    const calls: string[] = [];
    const fake: typeof fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push(
        `${init?.method ?? 'GET'} ${url.pathname}${url.search ? `?${url.searchParams.get('query') ?? ''}` : ''}`,
      );
      if (url.pathname === '/api/v1/search') {
        const header = url.searchParams.get('query')?.split(':')[0];
        const messages =
          header === 'to'
            ? [
                { ID: 'a', Size: 100 },
                { ID: 'big', Size: 30 * 1024 * 1024 },
              ]
            : header === 'cc'
              ? [{ ID: 'a', Size: 100 }]
              : [];
        return Promise.resolve(Response.json({ messages }));
      }
      if (url.pathname.endsWith('/raw')) return Promise.resolve(new Response('raw email'));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const mailbox = mailpitMailbox(config, fake);
    const emails = await mailbox.take(10);
    expect(emails.map((item) => [item.id, item.raw.toString()])).toEqual([['a', 'raw email']]);
    expect(calls).toEqual([
      `GET /api/v1/search?to:"@${config.TICKET_EMAIL_DOMAIN}"`,
      `GET /api/v1/search?cc:"@${config.TICKET_EMAIL_DOMAIN}"`,
      `GET /api/v1/search?bcc:"@${config.TICKET_EMAIL_DOMAIN}"`,
      'DELETE /api/v1/messages',
      'GET /api/v1/message/a/raw',
    ]);
    const failing = mailpitMailbox(config, () =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    await expect(failing.take(1)).rejects.toThrow('Mailpit answered 503');
  });

  it('reads the emails SES receiving saved in S3, and deletes what it took or cannot take', async () => {
    const calls: string[] = [];
    const objects: Record<string, string> = { 'inbound/a': 'email a', 'inbound/b': 'email b' };
    const client: S3Sender = {
      send: (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          calls.push(`list ${command.input.Bucket ?? ''} ${command.input.Prefix ?? ''}`);
          return Promise.resolve({
            Contents: [
              { Key: 'inbound/a', Size: 7 },
              { Key: 'inbound/big', Size: 30 * 1024 * 1024 },
              { Key: 'inbound/b', Size: 7 },
              { Size: 1 },
            ],
          });
        }
        if (command instanceof GetObjectCommand) {
          const key = command.input.Key ?? '';
          calls.push(`get ${key}`);
          const body = new Map(Object.entries(objects)).get(key);
          return Promise.resolve(
            body
              ? { Body: { transformToByteArray: () => Promise.resolve(Buffer.from(body)) } }
              : {},
          );
        }
        if (command instanceof DeleteObjectsCommand) {
          calls.push(
            `delete ${(command.input.Delete?.Objects ?? []).map((item) => item.Key ?? '').join(',')}`,
          );
          return Promise.resolve({});
        }
        return Promise.reject(new Error('unexpected command'));
      },
    };
    const mailbox = s3Mailbox(
      { ...config, INBOUND_EMAIL_BUCKET: 'helpdesk-dev-inbound-email' },
      client,
    );
    const emails = await mailbox.take(25);
    expect(emails.map((item) => [item.id, item.raw.toString()])).toEqual([
      ['inbound/a', 'email a'],
      ['inbound/b', 'email b'],
    ]);
    await mailbox.remove(['inbound/a']);
    await mailbox.remove([]);
    expect(calls).toEqual([
      'list helpdesk-dev-inbound-email inbound/',
      'delete inbound/big',
      'get inbound/a',
      'get inbound/b',
      'delete inbound/a',
    ]);
    expect(
      createInboundMailboxes({
        ...config,
        INBOUND_EMAIL_DRIVER: ['mailpit', 's3'],
        INBOUND_EMAIL_BUCKET: 'x-bucket',
      }),
    ).toHaveLength(2);
  });
});
