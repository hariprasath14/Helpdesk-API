import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';

const kit = accountsKit();
const { send, teamWorkspace, signedUpWorkspace } = kit;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  type: string | null;
  contact: { id: string; name: string; email: string | null };
  company: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  tags: string[];
  customFields: Record<string, unknown>;
  createdBy: { userId: string; name: string } | null;
  resolvedAt: string | null;
  closedAt: string | null;
  deletedAt: string | null;
}
interface Activity {
  action: string;
  actor: { name: string };
  changes: { field: string; label?: string; from: unknown; to: unknown }[];
}
type Response = Awaited<ReturnType<typeof send>>;
const problems = (response: Response) =>
  Object.fromEntries(
    response
      .json<{ error: { details: { fields: { field: string; message: string }[] } } }>()
      .error.details.fields.map((item) => [item.field, item.message]),
  );

const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
const remove = (member: Member, url: string) =>
  send({ method: 'DELETE', url: `/api/v1${url}`, ...as(member) });

async function admin(): Promise<Member> {
  const workspace = await signedUpWorkspace();
  return {
    email: workspace.body.email,
    userId: '',
    address: workspace.address,
    cookie: workspace.cookie,
    csrf: workspace.csrf,
  };
}
async function created<T>(response: Response): Promise<T> {
  expect(response.statusCode, response.body).toBe(200);
  return Promise.resolve(response.json<T>());
}
const contact = (member: Member, payload: Record<string, unknown>) =>
  post(member, '/contacts', payload).then((r) => created<{ id: string }>(r));
const ticket = (member: Member, payload: Record<string, unknown>) =>
  post(member, '/tickets', payload).then((r) => created<Ticket>(r));
const activity = async (member: Member, number: number) =>
  (await get(member, `/tickets/${String(number)}/activity`)).json<{ activity: Activity[] }>()
    .activity;

describe('creating tickets', () => {
  it('numbers tickets per workspace and starts them open, medium, from the requester', async () => {
    const owner = await admin();
    const acme = await post(owner, '/companies', { name: 'Acme', domains: ['acme.com'] }).then(
      (r) => created<{ id: string }>(r),
    );
    const neha = await contact(owner, { name: 'Neha Iyer', email: 'neha@acme.com' });
    const first = await ticket(owner, {
      contactId: neha.id,
      subject: "  Employees can't mark attendance ",
      description: 'Since this morning.\nAll branches.',
      tags: [' Attendance ', 'urgent  fix', 'ATTENDANCE'],
    });
    expect(first).toMatchObject({
      number: 1,
      subject: "Employees can't mark attendance",
      description: 'Since this morning.\nAll branches.',
      status: 'open',
      priority: 'medium',
      type: null,
      source: 'agent',
      contact: { id: neha.id, name: 'Neha Iyer', email: 'neha@acme.com' },
      company: { id: acme.id, name: 'Acme' },
      team: null,
      assignee: null,
      tags: ['attendance', 'urgent fix'],
      deletedAt: null,
    });
    expect(first.createdBy?.name).toBe('Ravi Shankar');
    expect((await ticket(owner, { contactId: neha.id, subject: 'Second' })).number).toBe(2);
    expect((await get(owner, '/tickets/1')).json<Ticket>().subject).toBe(
      "Employees can't mark attendance",
    );
    expect(await activity(owner, 1)).toMatchObject([
      { action: 'created', actor: { name: 'Ravi Shankar' }, changes: [] },
    ]);

    // Another workspace starts at 1 too.
    const other = await admin();
    const someone = await contact(other, { name: 'X', phone: '1' });
    expect((await ticket(other, { contactId: someone.id, subject: 'Hello' })).number).toBe(1);
  });

  it('never gives two tickets created at once the same number', async () => {
    const owner = await admin();
    const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
    const numbers = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        ticket(owner, { contactId: neha.id, subject: `T${String(index)}` }).then((t) => t.number),
      ),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('takes a requester by email: the contact with it, or a new one linked by domain', async () => {
    const owner = await admin();
    const acme = await post(owner, '/companies', { name: 'Acme', domains: ['acme.com'] }).then(
      (r) => created<{ id: string }>(r),
    );
    const first = await ticket(owner, {
      contact: { name: 'Arjun Mehta', email: 'Arjun@ACME.com' },
      subject: 'Login fails',
    });
    expect(first.contact).toMatchObject({ name: 'Arjun Mehta', email: 'arjun@acme.com' });
    expect(first.company?.id).toBe(acme.id);
    const again = await ticket(owner, {
      contact: { name: 'Someone else', email: 'arjun@acme.com' },
      subject: 'Again',
    });
    expect(again.contact.id).toBe(first.contact.id);
    const byPhone = await ticket(owner, {
      contact: { name: 'Caller', phone: '+91 98765 43210' },
      subject: 'Phoned in',
    });
    expect(byPhone.contact.email).toBeNull();
    expect(
      problems(await post(owner, '/tickets', { contact: { name: 'Nobody' }, subject: 'X' })),
    ).toEqual({ 'contact.email': 'Enter an email or a phone number.' });
  });

  it('checks the subject, requester, team, tags and custom fields', async () => {
    const owner = await admin();
    const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
    expect((await post(owner, '/tickets', { contactId: neha.id, subject: ' ' })).statusCode).toBe(
      400,
    );
    expect(problems(await post(owner, '/tickets', { subject: 'X' }))).toEqual({
      contactId: 'Choose who raised this ticket.',
    });
    expect(
      problems(
        await post(owner, '/tickets', {
          subject: 'X',
          contactId: neha.id,
          contact: { name: 'Y', phone: '2' },
        }),
      ),
    ).toEqual({ contactId: 'Choose a contact or enter a new one, not both.' });

    await post(owner, '/custom-fields', {
      recordType: 'ticket',
      label: 'Root cause',
      type: 'text',
      required: 'on_resolve',
    });
    await post(owner, '/custom-fields', {
      recordType: 'ticket',
      label: 'Product',
      type: 'text',
      required: 'always',
    });
    expect(
      problems(
        await post(owner, '/tickets', {
          subject: 'X',
          contactId: UNKNOWN_ID,
          teamId: UNKNOWN_ID,
          status: 'resolved',
          tags: ['a'.repeat(41), ...Array.from({ length: 20 }, (_, i) => `t${String(i)}`)],
        }),
      ),
    ).toEqual({
      tags: 'Add at most 20 tags.',
      'tags.0': 'Keep tags to 40 characters.',
      teamId: 'This team no longer exists.',
      'customFields.product': 'Product is required.',
      'customFields.root_cause': 'Root cause is required.',
      contactId: 'This contact no longer exists.',
    });
    const fine = await ticket(owner, {
      contactId: neha.id,
      subject: 'Works',
      customFields: { product: 'Attendance' },
    });
    expect(fine.customFields).toEqual({ product: 'Attendance' });
  });
});

describe('changing tickets', () => {
  it('records each change in the history, with names', { timeout: 20_000 }, async () => {
    const ws = await teamWorkspace();
    const billing = await post(ws.admin, '/teams', { name: 'Billing' }).then((r) =>
      created<{ id: string }>(r),
    );
    await post(ws.admin, '/custom-fields', {
      recordType: 'ticket',
      label: 'Plan',
      type: 'text',
    });
    const neha = await contact(ws.admin, { name: 'Neha Iyer', phone: '1' });
    const arjun = await contact(ws.admin, { name: 'Arjun Mehta', phone: '2' });
    const t = await ticket(ws.agent, { contactId: neha.id, subject: 'Old', tags: ['a', 'b'] });

    const changed = await patch(ws.agent, `/tickets/${String(t.number)}`, {
      subject: 'New',
      status: 'pending',
      priority: 'urgent',
      type: 'incident',
      teamId: billing.id,
      contactId: arjun.id,
      tags: ['b', 'c'],
      customFields: { plan: 'Premium' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<Ticket>()).toMatchObject({
      subject: 'New',
      status: 'pending',
      priority: 'urgent',
      type: 'incident',
      team: { name: 'Billing' },
      contact: { name: 'Arjun Mehta' },
      tags: ['b', 'c'],
      customFields: { plan: 'Premium' },
    });
    const history = await activity(ws.admin, t.number);
    expect(history.at(-1)?.changes).toEqual([
      { field: 'subject', from: 'Old', to: 'New' },
      { field: 'status', from: 'open', to: 'pending' },
      { field: 'priority', from: 'medium', to: 'urgent' },
      { field: 'type', from: null, to: 'incident' },
      { field: 'team', from: null, to: 'Billing' },
      { field: 'contact', from: 'Neha Iyer', to: 'Arjun Mehta' },
      { field: 'customFields.plan', label: 'Plan', from: null, to: 'Premium' },
      { field: 'tags', from: ['a'], to: ['c'] },
    ]);

    // A save with nothing new records nothing.
    await patch(ws.agent, `/tickets/${String(t.number)}`, { subject: 'New', tags: ['c', 'b'] });
    expect(await activity(ws.admin, t.number)).toHaveLength(2);

    // Deleting the team leaves the ticket without one.
    await remove(ws.admin, `/teams/${billing.id}`);
    expect((await get(ws.agent, `/tickets/${String(t.number)}`)).json<Ticket>().team).toBeNull();
    expect((await patch(ws.agent, '/tickets/999', { subject: 'X' })).statusCode).toBe(404);
  });

  it('needs the "required when resolving" fields to resolve, and times resolving and closing', async () => {
    const owner = await admin();
    await post(owner, '/custom-fields', {
      recordType: 'ticket',
      label: 'Root cause',
      type: 'text',
      required: 'on_resolve',
    });
    const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
    const t = await ticket(owner, { contactId: neha.id, subject: 'Broken' });
    const url = `/tickets/${String(t.number)}`;

    expect(problems(await patch(owner, url, { status: 'closed' }))).toEqual({
      'customFields.root_cause': 'Root cause is required.',
    });
    const resolved = (
      await patch(owner, url, { status: 'resolved', customFields: { root_cause: 'Config' } })
    ).json<Ticket>();
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.closedAt).toBeNull();
    const closed = (await patch(owner, url, { status: 'closed' })).json<Ticket>();
    expect(closed.closedAt).not.toBeNull();
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);
    const reopened = (await patch(owner, url, { status: 'open' })).json<Ticket>();
    expect(reopened).toMatchObject({ resolvedAt: null, closedAt: null });
  });
});

describe('the trash', () => {
  it('lets admins delete and restore tickets, with history and audit entries', async () => {
    const ws = await teamWorkspace();
    const neha = await contact(ws.admin, { name: 'Neha Iyer', phone: '1' });
    const t = await ticket(ws.admin, { contactId: neha.id, subject: 'Spam' });
    const url = `/tickets/${String(t.number)}`;

    expect((await remove(ws.admin, url)).statusCode).toBe(204);
    expect((await get(ws.admin, '/tickets')).json<{ total: number }>().total).toBe(0);
    const trash = (await get(ws.admin, '/tickets?deleted=true')).json<{
      tickets: Ticket[];
    }>();
    expect(trash.tickets.map((item) => item.number)).toEqual([t.number]);
    expect((await get(ws.agent, url)).json<Ticket>().deletedAt).not.toBeNull();
    expect((await patch(ws.agent, url, { subject: 'X' })).statusCode).toBe(409);

    const restored = await post(ws.admin, `${url}/restore`, {});
    expect(restored.json<Ticket>().deletedAt).toBeNull();
    expect((await activity(ws.admin, t.number)).map((entry) => entry.action)).toEqual([
      'created',
      'deleted',
      'restored',
    ]);
    const log = (await get(ws.admin, '/audit-log?category=tickets')).json<{
      entries: { summary: string }[];
    }>();
    expect(log.entries.map((entry) => entry.summary)).toEqual([
      'Ravi Shankar restored the ticket #1 Spam from the trash.',
      'Ravi Shankar deleted the ticket #1 Spam.',
    ]);
  });

  it('keeps a contact who raised tickets', async () => {
    const owner = await admin();
    const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
    const t = await ticket(owner, { contactId: neha.id, subject: 'Mine' });
    await remove(owner, `/tickets/${String(t.number)}`);
    const refused = await remove(owner, `/contacts/${neha.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(
      'This contact raised a ticket (deleted tickets count too). Change its requester first.',
    );
  });
});

describe('ticket lists and tags', () => {
  it('pages most recently updated first, filters by contact and company, and suggests tags', async () => {
    const owner = await admin();
    const acme = await post(owner, '/companies', { name: 'Acme', domains: ['acme.com'] }).then(
      (r) => created<{ id: string }>(r),
    );
    const neha = await contact(owner, { name: 'Neha Iyer', email: 'neha@acme.com' });
    const arjun = await contact(owner, { name: 'Arjun Mehta', phone: '2' });
    for (const [index, requester] of [neha, arjun, neha].entries()) {
      await ticket(owner, {
        contactId: requester.id,
        subject: `T${String(index + 1)}`,
        tags: index === 0 ? ['refund', 'billing'] : ['refund'],
      });
    }
    await patch(owner, '/tickets/1', { priority: 'high' });

    const first = (await get(owner, '/tickets?limit=2')).json<{
      tickets: Ticket[];
      nextCursor: string;
      total: number;
    }>();
    expect(first.tickets.map((item) => item.number)).toEqual([1, 3]);
    expect(first.total).toBe(3);
    const second = (
      await get(owner, `/tickets?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json<{ tickets: Ticket[]; nextCursor: string | null; total: number | null }>();
    expect(second).toMatchObject({ nextCursor: null, total: null });
    expect(second.tickets.map((item) => item.number)).toEqual([2]);

    const byContact = (await get(owner, `/tickets?contactId=${neha.id}`)).json<{
      tickets: Ticket[];
    }>();
    expect(byContact.tickets.map((item) => item.number).sort()).toEqual([1, 3]);
    const byCompany = (await get(owner, `/tickets?companyId=${acme.id}`)).json<{
      total: number;
    }>();
    expect(byCompany.total).toBe(2);
    expect((await get(owner, '/tickets?cursor=nonsense')).statusCode).toBe(400);

    expect((await get(owner, '/tickets/tags')).json()).toEqual({ tags: ['refund', 'billing'] });
    expect((await get(owner, '/tickets/tags?q=BI')).json()).toEqual({ tags: ['billing'] });
  });
});

describe('ticket access', () => {
  // About 25 requests: the full parallel run on a developer machine can pass the 5 s default.
  it(
    'lets every role work tickets and only admins delete, restore and see the trash',
    { timeout: 30_000 },
    async () => {
      const ws = await teamWorkspace();
      const neha = await contact(ws.admin, { name: 'Neha Iyer', phone: '1' });
      const t = await ticket(ws.admin, { contactId: neha.id, subject: 'Shared' });
      const url = `/api/v1/tickets/${String(t.number)}`;
      for (const request of [
        (m: Member) => ({ url: '/api/v1/tickets', ...as(m) }),
        (m: Member) => ({ url, ...as(m) }),
        (m: Member) => ({ url: `${url}/activity`, ...as(m) }),
        (m: Member) => ({ url: '/api/v1/tickets/tags', ...as(m) }),
        (m: Member) => ({ method: 'PATCH' as const, url, ...as(m), payload: { subject: m.email } }),
        (m: Member) => ({
          method: 'POST' as const,
          url: '/api/v1/tickets',
          ...as(m),
          payload: { contactId: neha.id, subject: 'Mine' },
        }),
      ]) {
        await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], request);
      }
      await expectOnlyRoles(kit, ws, ['admin'], (m) => ({
        url: '/api/v1/tickets?deleted=true',
        ...as(m),
      }));
      await expectOnlyRoles(kit, ws, ['admin'], (m) => ({
        method: 'POST',
        url: `${url}/restore`,
        ...as(m),
      }));
      await expectOnlyRoles(kit, ws, ['admin'], (m) => ({ method: 'DELETE', url, ...as(m) }));
    },
  );

  it("never shows or changes another workspace's tickets", async () => {
    const owner = await admin();
    const intruder = await admin();
    const byAddress = new Map([
      [owner.address, owner],
      [intruder.address, intruder],
    ]);
    // The intruder has a ticket #1 of its own, so the check also proves numbers are per workspace.
    const theirs = await contact(intruder, { name: 'Theirs', phone: '9' });
    await ticket(intruder, { contactId: theirs.id, subject: 'Their own ticket' });
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.address, intruder: intruder.address },
      setup: async () => {
        const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
        await ticket(owner, {
          contactId: neha.id,
          subject: 'Payroll secret',
          tags: ['secret-tag'],
        });
        await ticket(owner, { contactId: neha.id, subject: 'Second secret' });
        return {
          secrets: ['Payroll secret', 'Second secret', 'secret-tag', 'Neha Iyer'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/tickets' } },
            { kind: 'list', request: { method: 'GET', url: '/api/v1/tickets/tags' } },
            { kind: 'item', request: { method: 'GET', url: '/api/v1/tickets/2' } },
            { kind: 'item', request: { method: 'GET', url: '/api/v1/tickets/2/activity' } },
            {
              kind: 'item',
              request: { method: 'PATCH', url: '/api/v1/tickets/2', payload: { subject: 'Mine' } },
            },
            { kind: 'item', request: { method: 'DELETE', url: '/api/v1/tickets/2' } },
            { kind: 'item', request: { method: 'POST', url: '/api/v1/tickets/2/restore' } },
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
    // Another workspace's contact can't be a requester.
    const neha = (await get(owner, '/contacts')).json<{ contacts: { id: string }[] }>().contacts[0];
    expect(
      problems(await post(intruder, '/tickets', { contactId: neha?.id, subject: 'Borrowed' })),
    ).toEqual({ contactId: 'This contact no longer exists.' });
  });

  it('answers creates and changes from the writer', async () => {
    const owner = await admin();
    const neha = await contact(owner, { name: 'Neha Iyer', phone: '1' });
    await kit.restartApp(LAGGING_READER);
    const headers = { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf };
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/tickets',
        headers,
        payload: { contactId: neha.id, subject: 'Lagging ticket', tags: ['lag'] },
      },
      ['Lagging ticket', 'lag', 'Neha Iyer'],
    );
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/tickets',
        headers,
        payload: { contact: { name: 'Brand New', email: 'new@example.org' }, subject: 'New one' },
      },
      ['Brand New'],
    );
    await expectReadAfterWrite(
      kit.app,
      { method: 'PATCH', url: '/api/v1/tickets/1', headers, payload: { subject: 'Renamed lag' } },
      ['Renamed lag'],
    );
    await expectReadAfterWrite(kit.app, { method: 'GET', url: '/api/v1/tickets/1', headers }, [
      'Renamed lag',
    ]);
    await expectReadAfterWrite(
      kit.app,
      { method: 'GET', url: '/api/v1/tickets/1/activity', headers },
      ['Renamed lag'],
    );
    await kit.app.inject({ method: 'DELETE', url: '/api/v1/tickets/1', headers });
    await expectReadAfterWrite(
      kit.app,
      { method: 'POST', url: '/api/v1/tickets/1/restore', headers },
      ['Renamed lag'],
    );
  });
});
