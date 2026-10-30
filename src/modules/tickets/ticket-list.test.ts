import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member, type Team } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

type Response = Awaited<ReturnType<typeof send>>;
interface Page {
  tickets: { number: number; subject: string }[];
  nextCursor: string | null;
  total: number | null;
}
interface View {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  sort: string;
  shared: boolean;
  mine: boolean;
  canEdit: boolean;
  ownerName: string;
}

const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1${url}`, ...as(member), payload });
const get = (member: Member, url: string) => send({ url: `/api/v1${url}`, ...as(member) });
// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const numbers = async (member: Member, search: string) =>
  ok<Page>(await get(member, `/tickets?${search}`))
    .tickets.map((ticket) => ticket.number)
    .sort((a, b) => a - b);

/**
 * A workspace with five tickets:
 * #1 urgent open, Billing, assigned to the agent, tags refund; requester Neha (neha@acme.com)
 * #2 low pending, no team, unassigned, type incident; requester Arjun
 * #3 high resolved, Billing, assigned to the admin; requester Neha
 * #4 medium waiting on customer, Support; requester Arjun; subject mentions payroll
 * #5 medium open, no team; requester Arjun, tag payroll
 */
async function fiveTickets() {
  const ws = await teamWorkspace();
  const billing = ok<{ id: string }>(await post(ws.admin, '/teams', { name: 'Billing' }));
  const support = ok<{ id: string }>(await post(ws.admin, '/teams', { name: 'Support' }));
  const neha = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Neha Iyer', email: 'neha@acme.com' }),
  );
  const arjun = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Arjun Mehta', phone: '2' }),
  );
  const specs = [
    {
      contactId: neha.id,
      subject: 'Refund not received',
      priority: 'urgent',
      teamId: billing.id,
      tags: ['refund'],
    },
    {
      contactId: arjun.id,
      subject: 'Login loops',
      priority: 'low',
      status: 'pending',
      type: 'incident',
    },
    {
      contactId: neha.id,
      subject: 'Invoice copy',
      priority: 'high',
      status: 'resolved',
      teamId: billing.id,
    },
    {
      contactId: arjun.id,
      subject: 'Payroll export blank',
      status: 'waiting_on_customer',
      teamId: support.id,
    },
    { contactId: arjun.id, subject: 'Leave balance wrong', tags: ['payroll'] },
  ];
  for (const spec of specs) ok(await post(ws.admin, '/tickets', spec));
  await query(
    `UPDATE tickets SET assignee_user_id = CASE number WHEN 1 THEN CAST(:agent AS uuid) WHEN 3 THEN CAST(:admin AS uuid) END
     WHERE workspace_id = (SELECT id FROM workspaces WHERE subdomain = :sub) AND number IN (1, 3)`,
    { agent: ws.agent.userId, admin: ws.admin.userId, sub: ws.workspace.body.workspaceAddress },
  );
  return { ws, billing, support };
}

describe('filtering and searching tickets', { timeout: 30_000 }, () => {
  it('filters by status, priority, type, team, assignee and tag, and combines them', async () => {
    const { ws, billing } = await fiveTickets();
    const agent = ws.agent;
    expect(await numbers(agent, 'status=open,pending,waiting_on_customer')).toEqual([1, 2, 4, 5]);
    expect(await numbers(agent, 'priority=urgent,high')).toEqual([1, 3]);
    expect(await numbers(agent, 'type=incident')).toEqual([2]);
    expect(await numbers(agent, 'type=none')).toEqual([1, 3, 4, 5]);
    expect(await numbers(agent, `teamId=${billing.id}`)).toEqual([1, 3]);
    expect(await numbers(agent, `teamId=${billing.id},none`)).toEqual([1, 2, 3, 5]);
    expect(await numbers(agent, 'assignee=me')).toEqual([1]);
    expect(await numbers(ws.admin, 'assignee=me')).toEqual([3]);
    expect(await numbers(agent, 'assignee=none')).toEqual([2, 4, 5]);
    expect(await numbers(agent, `assignee=${ws.admin.userId},none`)).toEqual([2, 3, 4, 5]);
    expect(await numbers(agent, 'tag=refund,payroll')).toEqual([1, 5]);
    expect(await numbers(agent, `status=open&teamId=${billing.id}`)).toEqual([1]);
    expect(
      ok<Page>(await get(agent, 'tickets?priority=medium'.replace('tickets?', '/tickets?'))).total,
    ).toBe(2);
  });

  it('searches the number, subject, requester and tags', async () => {
    const { ws } = await fiveTickets();
    expect(await numbers(ws.agent, 'q=%233')).toEqual([3]);
    expect(await numbers(ws.agent, 'q=4')).toEqual([4]);
    expect(await numbers(ws.agent, 'q=PAYROLL')).toEqual([4, 5]);
    expect(await numbers(ws.agent, 'q=neha')).toEqual([1, 3]);
    expect(await numbers(ws.agent, 'q=acme.com')).toEqual([1, 3]);
    expect(await numbers(ws.agent, 'q=50%25')).toEqual([]);
  });

  it('refuses filter values it does not know', async () => {
    const { ws } = await fiveTickets();
    const response = await get(ws.agent, '/tickets?status=open,lost&teamId=billing');
    expect(response.statusCode).toBe(400);
    const fields = response
      .json<{ error: { details: { fields: { field: string }[] } } }>()
      .error.details.fields.map((item) => item.field);
    expect(fields).toEqual(expect.arrayContaining(['status', 'teamId']));
    expect((await get(ws.agent, '/tickets?sort=random')).statusCode).toBe(400);
  });
});

describe('sorting and paging', { timeout: 30_000 }, () => {
  async function allPages(member: Member, sort: string): Promise<number[]> {
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = ok<Page>(
        await get(
          member,
          `/tickets?sort=${sort}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      seen.push(...page.tickets.map((ticket) => ticket.number));
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  }

  it('pages through every order without gaps or repeats', async () => {
    const { ws } = await fiveTickets();
    await patch(ws.admin, '/tickets/2', { subject: 'Login loops again' });
    expect(await allPages(ws.agent, 'updated')).toEqual([2, 5, 4, 3, 1]);
    expect(await allPages(ws.agent, 'created')).toEqual([5, 4, 3, 2, 1]);
    expect(await allPages(ws.agent, 'oldest')).toEqual([1, 2, 3, 4, 5]);
    // Highest priority first, then most recently updated.
    expect(await allPages(ws.agent, 'priority')).toEqual([1, 3, 5, 4, 2]);
  });

  it("refuses another order's cursor", async () => {
    const { ws } = await fiveTickets();
    const page = ok<Page>(await get(ws.agent, '/tickets?sort=created&limit=2'));
    const response = await get(
      ws.agent,
      `/tickets?sort=priority&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('saved views', () => {
  const view = (member: Member, payload: Record<string, unknown>) =>
    post(member, '/ticket-views', payload);

  it('keeps a view private to its owner; shared views are for everyone', async () => {
    const ws = await teamWorkspace();
    const mine = ok<View>(
      await view(ws.agent, {
        name: '  Urgent refunds ',
        filters: { priority: ['urgent'], tag: ['refund'], q: ' ', status: [] },
        sort: 'priority',
      }),
    );
    expect(mine).toMatchObject({
      name: 'Urgent refunds',
      filters: { priority: ['urgent'], tag: ['refund'] },
      sort: 'priority',
      shared: false,
      mine: true,
      canEdit: true,
    });
    const shared = ok<View>(
      await view(ws.supervisor, {
        name: 'Team queue',
        filters: { assignee: ['none'] },
        shared: true,
      }),
    );
    const agentViews = ok<{ views: View[] }>(await get(ws.agent, '/ticket-views')).views;
    expect(agentViews.map((item) => [item.name, item.mine, item.canEdit])).toEqual([
      ['Team queue', false, false],
      ['Urgent refunds', true, true],
    ]);
    const adminViews = ok<{ views: View[] }>(await get(ws.admin, '/ticket-views')).views;
    expect(adminViews.map((item) => [item.name, item.canEdit])).toEqual([['Team queue', true]]);

    // Someone else's private view is not there for them.
    expect((await patch(ws.admin, `/ticket-views/${mine.id}`, { name: 'X' })).statusCode).toBe(404);
    // A shared view: agents can't change it; admins and supervisors can.
    expect((await patch(ws.agent, `/ticket-views/${shared.id}`, { name: 'X' })).statusCode).toBe(
      403,
    );
    expect(
      ok<View>(await patch(ws.admin, `/ticket-views/${shared.id}`, { name: 'Unassigned' })).name,
    ).toBe('Unassigned');
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/ticket-views/${shared.id}`, ...as(ws.agent) }))
        .statusCode,
    ).toBe(403);
    expect(
      (await send({ method: 'DELETE', url: `/api/v1/ticket-views/${mine.id}`, ...as(ws.agent) }))
        .statusCode,
    ).toBe(204);
    expect(ok<{ views: View[] }>(await get(ws.agent, '/ticket-views')).views).toHaveLength(1);
  });

  it('lets only admins and supervisors share views', async () => {
    const ws = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor'], (member) => ({
      method: 'POST',
      url: '/api/v1/ticket-views',
      ...as(member),
      payload: { name: `Shared ${member.email}`, shared: true },
    }));
    const own = ok<View>(await view(ws.agent, { name: 'Mine' }));
    expect((await patch(ws.agent, `/ticket-views/${own.id}`, { shared: true })).statusCode).toBe(
      403,
    );
    expect(
      ok<View>(await patch(ws.agent, `/ticket-views/${own.id}`, { sort: 'oldest' })).sort,
    ).toBe('oldest');
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/ticket-views',
      ...as(member),
    }));
  });

  it('checks the name and filters, and allows 50 views a person', async () => {
    const ws = await teamWorkspace();
    expect((await view(ws.agent, { name: ' ' })).statusCode).toBe(400);
    expect((await view(ws.agent, { name: 'X', filters: { status: ['lost'] } })).statusCode).toBe(
      400,
    );
    await query(
      `INSERT INTO ticket_views (id, workspace_id, owner_user_id, name, created_at, updated_at)
       SELECT gen_random_uuid(), w.id, :user, 'View ' || n, now(), now()
       FROM workspaces w, generate_series(1, 50) n WHERE w.subdomain = :sub`,
      { user: ws.agent.userId, sub: ws.workspace.body.workspaceAddress },
    );
    expect((await view(ws.agent, { name: 'One more' })).statusCode).toBe(409);
  });

  it("never shows another workspace's views or tickets in a filtered list", async () => {
    const owner = await teamWorkspace();
    const intruder = await teamWorkspace();
    const byAddress = new Map([
      [owner.admin.address, owner.admin],
      [intruder.admin.address, intruder.admin],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.admin.address, intruder: intruder.admin.address },
      setup: async () => {
        const saved = ok<View>(
          await view(owner.admin, {
            name: 'Secret queue',
            filters: { tag: ['secret'] },
            shared: true,
          }),
        );
        const contact = ok<{ id: string }>(
          await post(owner.admin, '/contacts', { name: 'Hidden Person', phone: '1' }),
        );
        ok(
          await post(owner.admin, '/tickets', {
            contactId: contact.id,
            subject: 'Secret subject',
            tags: ['secret'],
          }),
        );
        return {
          secrets: ['Secret queue', 'Secret subject', 'Hidden Person'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/ticket-views' } },
            { kind: 'list', request: { method: 'GET', url: '/api/v1/tickets?tag=secret' } },
            {
              kind: 'list',
              request: { method: 'GET', url: '/api/v1/tickets?q=secret&sort=priority' },
            },
            { kind: 'list', request: { method: 'GET', url: '/api/v1/people' } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/ticket-views/${saved.id}`,
                payload: { name: 'Mine' },
              },
            },
            {
              kind: 'item',
              request: { method: 'DELETE', url: `/api/v1/ticket-views/${saved.id}` },
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

  it('answers saves from the writer', async () => {
    const ws = await teamWorkspace();
    await kit.restartApp(LAGGING_READER);
    const headers = {
      host: ws.agent.address,
      cookie: ws.agent.cookie,
      'x-csrf-token': ws.agent.csrf,
    };
    const saved = await expectReadAfterWrite(
      kit.app,
      { method: 'POST', url: '/api/v1/ticket-views', headers, payload: { name: 'Lagging view' } },
      ['Lagging view'],
    );
    const id = saved.json<View>().id;
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: `/api/v1/ticket-views/${id}`,
        headers,
        payload: { name: 'Renamed view' },
      },
      ['Renamed view'],
    );
    await expectReadAfterWrite(kit.app, { method: 'GET', url: '/api/v1/ticket-views', headers }, [
      'Renamed view',
    ]);
  });
});

describe('people', () => {
  it('lists everyone by name for every role, without emails', async () => {
    const ws: Team = await teamWorkspace();
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/people',
      ...as(member),
    }));
    const response = await get(ws.agent, '/people');
    const people = ok<{ people: { userId: string; role: string; status: string }[] }>(
      response,
    ).people;
    expect(people.map((person) => person.role).sort()).toEqual(['admin', 'agent', 'supervisor']);
    expect(response.body).not.toContain('@');
  });
});
