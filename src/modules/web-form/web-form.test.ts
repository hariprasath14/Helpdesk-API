import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, host, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { MAX_EMAILS_PER_SENDER_HOUR } from '../email/incoming.service.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

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

/** The public page's requests: no session, on the workspace address. */
const form = (address: string) => send({ url: '/api/v1/web-form', on: address });
const submit = (address: string, payload: Record<string, unknown>, headers = {}) =>
  send({ method: 'POST', url: '/api/v1/web-form/requests', on: address, payload, headers });

const REQUEST = {
  name: 'Neha Iyer',
  email: 'Neha@Acme.test',
  subject: 'Payslip missing',
  description: 'My October payslip is not in the portal.',
};

async function setup() {
  const ws = await teamWorkspace();
  const [row] = await query<{ id: string }>('SELECT id FROM workspaces WHERE subdomain = :s', {
    s: ws.admin.address.split('.')[0],
  });
  return { ...ws, workspaceId: row?.id ?? '' };
}

const ticketCount = async (workspaceId: string) =>
  Number(
    (
      await query<{ n: string }>('SELECT count(*) AS n FROM tickets WHERE workspace_id = :id', {
        id: workspaceId,
      })
    )[0]?.n,
  );

describe('the web form', () => {
  it('is off until an admin turns it on, then makes tickets from requests', async () => {
    const ws = await setup();
    const address = ws.admin.address;
    expect(ok(await form(address))).toEqual({
      enabled: false,
      workspaceName: 'Acme Support',
      title: '',
      intro: '',
    });
    expect((await submit(address, REQUEST)).statusCode).toBe(404);

    const settings = ok<{ url: string }>(
      await patch(ws.admin, '/workspace/web-form', {
        enabled: true,
        title: '  Help with payroll ',
        intro: 'We answer within a day.',
      }),
    );
    expect(settings).toEqual({
      enabled: true,
      title: 'Help with payroll',
      intro: 'We answer within a day.',
      url: `http://${address}/support`,
    });
    expect(ok(await form(address))).toEqual({
      enabled: true,
      workspaceName: 'Acme Support',
      title: 'Help with payroll',
      intro: 'We answer within a day.',
    });

    expect(ok(await submit(address, REQUEST))).toEqual({ received: true });
    const ticket = ok<{
      subject: string;
      description: string;
      source: string;
      status: string;
      contact: { name: string; email: string };
      createdBy: unknown;
    }>(await get(ws.agent, '/tickets/1'));
    expect(ticket).toMatchObject({
      subject: 'Payslip missing',
      description: 'My October payslip is not in the portal.',
      source: 'web_form',
      status: 'open',
      contact: { name: 'Neha Iyer', email: 'neha@acme.test' },
      createdBy: null,
    });
    // The person is told it arrived (F15).
    const jobs = await query<{ data: { event: string } }>(
      "SELECT data FROM pgboss.job WHERE name = 'customer-email' AND data->>'workspaceId' = :id",
      { id: ws.workspaceId },
    );
    expect(jobs.map((job) => job.data.event)).toEqual(['received']);

    const audit = ok<{ entries: { action: string; summary: string }[] }>(
      await get(ws.admin, '/audit-log?category=settings'),
    ).entries.filter((entry) => entry.action === 'workspace.web_form_changed');
    expect(audit.map((entry) => entry.summary)).toEqual(['Ravi Shankar turned on the web form.']);
    ok(await patch(ws.admin, '/workspace/web-form', { intro: 'Within two days.' }));
    ok(await patch(ws.admin, '/workspace/web-form', { intro: 'Within two days.' }));
    expect(
      ok<{ entries: { action: string; summary: string }[] }>(
        await get(ws.admin, '/audit-log?category=settings'),
      )
        .entries.filter((entry) => entry.action === 'workspace.web_form_changed')
        .map((entry) => entry.summary),
    ).toEqual([
      "Ravi Shankar changed the web form's text.",
      'Ravi Shankar turned on the web form.',
    ]);
  });

  it(
    'checks requests, and drops bots and floods without telling them',
    { timeout: 30_000 },
    async () => {
      const ws = await setup();
      const address = ws.admin.address;
      ok(await patch(ws.admin, '/workspace/web-form', { enabled: true }));
      const invalid = await submit(address, { ...REQUEST, email: 'nope', subject: ' ' });
      expect(invalid.statusCode).toBe(400);
      expect(
        invalid
          .json<{ error: { details: { fields: { field: string }[] } } }>()
          .error.details.fields.map((item) => item.field)
          .sort(),
      ).toEqual(['email', 'subject']);

      expect(ok(await submit(address, { ...REQUEST, website: 'http://spam.test' }))).toEqual({
        received: true,
      });
      expect(await ticketCount(ws.workspaceId)).toBe(0);

      for (let n = 0; n < MAX_EMAILS_PER_SENDER_HOUR; n += 1) {
        ok(await submit(address, { ...REQUEST, subject: `Request ${String(n)}` }));
      }
      expect(ok(await submit(address, REQUEST))).toEqual({ received: true });
      expect(await ticketCount(ws.workspaceId)).toBe(MAX_EMAILS_PER_SENDER_HOUR);
    },
  );

  it('refuses requests sent from another site, and unknown workspaces', async () => {
    const ws = await setup();
    ok(await patch(ws.admin, '/workspace/web-form', { enabled: true }));
    const forged = await submit(ws.admin.address, REQUEST, { origin: 'https://evil.test' });
    expect(forged.statusCode).toBe(403);
    expect((await form(host('no-such-workspace'))).statusCode).toBe(404);
    expect((await submit(host('no-such-workspace'), REQUEST)).statusCode).toBe(404);
  });

  it('has settings for admins only, answered from the writer', async () => {
    const ws = await setup();
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      url: '/api/v1/workspace/web-form',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'PATCH',
      url: '/api/v1/workspace/web-form',
      ...as(member),
      payload: { intro: 'Hi' },
    }));
    expect((await patch(ws.admin, '/workspace/web-form', { title: ' ' })).statusCode).toBe(400);
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/workspace/web-form',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: { title: 'Lagging title' },
      },
      ['Lagging title'],
    );
  });
});
