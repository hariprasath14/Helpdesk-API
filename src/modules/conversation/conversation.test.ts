import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { cleanFileName } from './attachments.service.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

type Response = Awaited<ReturnType<typeof send>>;
interface Message {
  id: string;
  kind: string;
  body: string;
  author: { type: string; name: string } | null;
  to: string[];
  cc: string[];
  mentions: { userId: string; name: string }[];
  emailStatus: string | null;
  attachments: { id: string; fileName: string; size: number }[];
}
interface Ticket {
  number: number;
  status: string;
  firstResponseAt: string | null;
  updatedAt: string;
}

const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );
const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};

const BOUNDARY = 'helpdesk-test-boundary';
/** A multipart/form-data upload with one "file" part. */
function upload(member: Member, fileName: string, content: Buffer | string, type = 'text/plain') {
  const payload = Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  return send({
    method: 'POST',
    url: '/api/v1/attachments',
    ...as(member),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload,
  });
}

/** A workspace with a ticket from Neha (neha@acme.com) and one from a phone-only caller. */
async function setup() {
  const ws = await teamWorkspace();
  const neha = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Neha Iyer', email: 'neha@acme.com' }),
  );
  const caller = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Caller', phone: '1' }),
  );
  ok(await post(ws.admin, '/tickets', { contactId: neha.id, subject: 'Payslip missing' }));
  ok(await post(ws.admin, '/tickets', { contactId: caller.id, subject: 'Phoned in' }));
  return ws;
}

describe('replies, notes and forwards', () => {
  it('queues a reply to the requester with copies, and records the first response', async () => {
    const ws = await setup();
    const before = ok<Ticket>(await get(ws.agent, '/tickets/1'));
    const messages = ok<{ messages: Message[] }>(
      await post(ws.agent, '/tickets/1/messages', {
        kind: 'reply',
        body: '  Hello Neha,\nwe are on it.  ',
        cc: ['Boss@Acme.com', 'boss@acme.com'],
        status: 'pending',
      }),
    ).messages;
    expect(messages).toMatchObject([
      {
        kind: 'reply',
        body: 'Hello Neha,\nwe are on it.',
        author: { type: 'member' },
        to: ['neha@acme.com'],
        cc: ['boss@acme.com'],
        emailStatus: 'queued',
        attachments: [],
      },
    ]);
    const after = ok<Ticket>(await get(ws.agent, '/tickets/1'));
    expect(after.status).toBe('pending');
    expect(after.firstResponseAt).not.toBeNull();
    expect(after.updatedAt > before.updatedAt).toBe(true);
    const history = ok<{ activity: { changes: { field: string }[] }[] }>(
      await get(ws.agent, '/tickets/1/activity'),
    ).activity;
    expect(history.at(-1)?.changes).toEqual([{ field: 'status', from: 'open', to: 'pending' }]);

    // A second reply keeps the first response time.
    await post(ws.agent, '/tickets/1/messages', { kind: 'reply', body: 'More' });
    expect(ok<Ticket>(await get(ws.agent, '/tickets/1')).firstResponseAt).toBe(
      after.firstResponseAt,
    );

    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'reply',
          body: 'X',
          cc: ['neha@acme.com'],
        }),
      ),
    ).toEqual({ cc: 'The requester already gets the reply.' });
    const phoneOnly = await post(ws.agent, '/tickets/2/messages', { kind: 'reply', body: 'Hi' });
    expect(phoneOnly.statusCode).toBe(409);
  });

  it('keeps notes private with @mentions of active members, and forwards to addresses', async () => {
    const ws = await setup();
    const notes = ok<{ messages: Message[] }>(
      await post(ws.agent, '/tickets/2/messages', {
        kind: 'note',
        body: '@Sam can you call them back?',
        mentions: [ws.supervisor.userId, ws.supervisor.userId],
      }),
    ).messages;
    expect(notes[0]).toMatchObject({
      kind: 'note',
      emailStatus: null,
      to: [],
      mentions: [{ userId: ws.supervisor.userId }],
    });

    await query(
      "UPDATE memberships SET status = 'deactivated' WHERE user_id = :id AND workspace_id = (SELECT id FROM workspaces WHERE subdomain = :sub)",
      { id: ws.supervisor.userId, sub: ws.workspace.body.workspaceAddress },
    );
    expect(
      problems(
        await post(ws.agent, '/tickets/2/messages', {
          kind: 'note',
          body: 'X',
          mentions: [ws.supervisor.userId],
        }),
      ),
    ).toEqual({ mentions: 'You can only mention active members.' });

    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'forward',
          body: 'FYI',
          status: 'closed',
        }),
      ),
    ).toEqual({
      to: 'Add who to forward this ticket to.',
      status: 'Change the status with a reply or a note.',
    });
    const forwarded = ok<{ messages: Message[] }>(
      await post(ws.agent, '/tickets/1/messages', {
        kind: 'forward',
        body: 'FYI',
        to: ['Payroll@Vendor.com'],
      }),
    ).messages;
    expect(forwarded.at(-1)).toMatchObject({
      kind: 'forward',
      to: ['payroll@vendor.com'],
      emailStatus: 'queued',
    });

    expect(
      problems(await post(ws.agent, '/tickets/1/messages', { kind: 'note', body: '   ' })),
    ).toEqual({
      body: 'Write a message or attach a file.',
    });
    expect(
      (await post(ws.agent, '/tickets/1/messages', { kind: 'customer', body: 'X' })).statusCode,
    ).toBe(400);
  });

  it('checks the status a reply sets like any ticket change, and refuses deleted tickets', async () => {
    const ws = await setup();
    await post(ws.admin, '/custom-fields', {
      recordType: 'ticket',
      label: 'Root cause',
      type: 'text',
      required: 'on_resolve',
    });
    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'reply',
          body: 'Fixed',
          status: 'resolved',
        }),
      ),
    ).toEqual({ 'customFields.root_cause': 'Root cause is required.' });
    // Nothing was saved.
    expect(
      ok<{ messages: Message[] }>(await get(ws.agent, '/tickets/1/messages')).messages,
    ).toEqual([]);

    await send({ method: 'DELETE', url: '/api/v1/tickets/1', ...as(ws.admin) });
    expect(
      (await post(ws.agent, '/tickets/1/messages', { kind: 'note', body: 'X' })).statusCode,
    ).toBe(409);
    expect((await get(ws.agent, '/tickets/1/messages')).statusCode).toBe(200);
    expect((await get(ws.agent, '/tickets/99/messages')).statusCode).toBe(404);
  });
});

describe('attachments', () => {
  it('uploads, sends with a message and downloads files, never inline', async () => {
    const ws = await setup();
    const file = ok<{ id: string; fileName: string; size: number }>(
      await upload(ws.agent, 'C:\\fakepath\\payslip Oct.pdf', '%PDF-1.4 hello', 'application/pdf'),
    );
    expect(file).toMatchObject({ fileName: 'payslip Oct.pdf', size: 14 });
    // Not sent yet: only the uploader can see it.
    expect((await get(ws.supervisor, `/attachments/${file.id}`)).statusCode).toBe(404);

    const messages = ok<{ messages: Message[] }>(
      await post(ws.agent, '/tickets/1/messages', {
        kind: 'note',
        body: '',
        attachmentIds: [file.id],
      }),
    ).messages;
    expect(messages[0]?.attachments).toEqual([
      { id: file.id, fileName: 'payslip Oct.pdf', contentType: 'application/pdf', size: 14 },
    ]);
    const download = await get(ws.supervisor, `/attachments/${file.id}`);
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('%PDF-1.4 hello');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('payslip Oct.pdf')}`,
    );
    expect(download.headers['content-security-policy']).toContain('sandbox');
    expect(download.headers['x-content-type-options']).toBe('nosniff');

    // Sent files stay; the same upload can't be sent twice.
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/attachments/${file.id}`, ...as(ws.agent) }))
        .statusCode,
    ).toBe(409);
    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'note',
          body: 'Again',
          attachmentIds: [file.id],
        }),
      ),
    ).toEqual({ attachmentIds: 'A file is missing. Upload it again.' });
  });

  it("refuses programs, files over the limit and other people's uploads; removes unsent ones", async () => {
    const ws = await setup();
    expect(problems(await upload(ws.agent, 'setup.EXE', 'MZ'))).toEqual({
      file: ".EXE files can run programs, so they can't be attached.",
    });
    const big = await upload(ws.agent, 'big.bin', Buffer.alloc(1024 * 1024 + 10, 1));
    expect(big.statusCode).toBe(413);
    expect(big.json<{ error: { code: string } }>().error.code).toBe('FILE_TOO_LARGE');

    const theirs = ok<{ id: string }>(await upload(ws.supervisor, 'notes.txt', 'theirs'));
    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'note',
          body: 'X',
          attachmentIds: [theirs.id],
        }),
      ),
    ).toEqual({ attachmentIds: 'A file is missing. Upload it again.' });
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/attachments/${theirs.id}`, ...as(ws.agent) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await send({
          method: 'DELETE',
          url: `/api/v1/attachments/${theirs.id}`,
          ...as(ws.supervisor),
        })
      ).statusCode,
    ).toBe(204);
    expect((await get(ws.supervisor, `/attachments/${theirs.id}`)).statusCode).toBe(404);

    const tooMany = await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        upload(ws.agent, `f${String(i)}.txt`, 'x').then((r) => ok<{ id: string }>(r).id),
      ),
    );
    expect(
      problems(
        await post(ws.agent, '/tickets/1/messages', {
          kind: 'note',
          body: 'X',
          attachmentIds: tooMany,
        }),
      ),
    ).toEqual({ attachmentIds: 'Attach at most 10 files.' });
    expect(
      (
        await send({
          method: 'POST',
          url: '/api/v1/attachments',
          ...as(ws.agent),
          payload: { file: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('cleans up uploads that were never sent, after a day', async () => {
    const ws = await setup();
    const old = ok<{ id: string }>(await upload(ws.agent, 'old.txt', 'old'));
    await query(
      "UPDATE ticket_attachments SET created_at = now() - interval '2 days' WHERE id = :id",
      { id: old.id },
    );
    ok(await upload(ws.agent, 'new.txt', 'new'));
    expect(await query('SELECT id FROM ticket_attachments WHERE id = :id', { id: old.id })).toEqual(
      [],
    );
    expect((await get(ws.agent, `/attachments/${old.id}`)).statusCode).toBe(404);
  });

  it('keeps file names safe', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('a\u0000b\u001f.txt')).toBe('ab.txt');
    expect(cleanFileName('say "hi".txt')).toBe('say hi.txt');
    expect(cleanFileName('   ')).toBe('file');
    expect(cleanFileName(`${'x'.repeat(300)}.pdf`)).toHaveLength(255);
  });
});

describe('conversation access', () => {
  it('lets every role read and write the conversation and upload files', async () => {
    const ws = await setup();
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/tickets/1/messages',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      method: 'POST',
      url: '/api/v1/tickets/1/messages',
      ...as(member),
      payload: { kind: 'note', body: `From ${member.email}` },
    }));
  });

  it(
    "never shows or changes another workspace's conversation or files",
    { timeout: 20_000 },
    async () => {
      const owner = await setup();
      const intruder = await setup();
      const byAddress = new Map([
        [owner.admin.address, owner.admin],
        [intruder.admin.address, intruder.admin],
      ]);
      await expectTenantIsolation({
        app: kit.app,
        workspaces: { owner: owner.admin.address, intruder: intruder.admin.address },
        setup: async () => {
          const file = ok<{ id: string }>(
            await upload(owner.admin, 'secret-plan.txt', 'secret contents'),
          );
          ok(
            await post(owner.admin, '/tickets/1/messages', {
              kind: 'note',
              body: 'Secret note',
              attachmentIds: [file.id],
            }),
          );
          const unsent = ok<{ id: string }>(await upload(owner.admin, 'draft.txt', 'draft'));
          return {
            secrets: ['Secret note', 'secret-plan.txt', 'secret contents'],
            checks: [
              { kind: 'list', request: { method: 'GET', url: '/api/v1/tickets/1/messages' } },
              { kind: 'item', request: { method: 'GET', url: `/api/v1/attachments/${file.id}` } },
              {
                kind: 'item',
                request: { method: 'DELETE', url: `/api/v1/attachments/${unsent.id}` },
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
      // Another workspace's upload can't be attached here.
      const theirs = ok<{ id: string }>(await upload(intruder.admin, 'theirs.txt', 'x'));
      expect(
        (
          await post(owner.admin, '/tickets/1/messages', {
            kind: 'note',
            body: 'X',
            attachmentIds: [theirs.id],
          })
        ).statusCode,
      ).toBe(400);
    },
  );

  it('answers sends from the writer', async () => {
    const ws = await setup();
    await kit.restartApp(LAGGING_READER);
    const headers = {
      host: ws.agent.address,
      cookie: ws.agent.cookie,
      'x-csrf-token': ws.agent.csrf,
    };
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/tickets/1/messages',
        headers,
        payload: { kind: 'note', body: 'Lagging note' },
      },
      ['Lagging note'],
    );
    await expectReadAfterWrite(
      kit.app,
      { method: 'GET', url: '/api/v1/tickets/1/messages', headers },
      ['Lagging note'],
    );
  });
});
