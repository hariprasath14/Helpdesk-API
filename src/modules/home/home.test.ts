import { describe, expect, it } from 'vitest';
import { accountsKit, as, expectOnlyRoles, type Member } from '../../test/accounts.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';

const kit = accountsKit();
const { send, teamWorkspace, signedUpWorkspace, query } = kit;

type Response = Awaited<ReturnType<typeof send>>;
interface Home {
  counts: { mine: number; overdue: number; unassigned: number; waitingOnCustomer: number };
  setup: { teamInvited: boolean; emailConnected: boolean; businessHoursSet: boolean } | null;
}

// The caller names the response shape it expects, as with response.json<T>().
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const ok = <T>(response: Response): T => {
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const home = async (member: Member) => ok<Home>(await send({ url: '/api/v1/home', ...as(member) }));
const post = (member: Member, url: string, payload: Record<string, unknown>) =>
  send({ method: 'POST', url: `/api/v1${url}`, ...as(member), payload });
const patch = (member: Member, number: number, payload: Record<string, unknown>) =>
  send({ method: 'PATCH', url: `/api/v1/tickets/${String(number)}`, ...as(member), payload });
const listTotal = async (member: Member, query: string) =>
  ok<{ total: number }>(await send({ url: `/api/v1/tickets?${query}`, ...as(member) })).total;

/** Raises a ticket for a new contact; returns its number. */
async function raise(member: Member, subject: string) {
  const contact = ok<{ id: string }>(
    await post(member, '/contacts', { name: 'Neha Iyer', phone: '1' }),
  );
  return ok<{ number: number }>(await post(member, '/tickets', { contactId: contact.id, subject }))
    .number;
}

describe('home', () => {
  it('counts the same tickets as the lists its cards open', async () => {
    const ws = await teamWorkspace();
    expect((await home(ws.agent)).counts).toEqual({
      mine: 0,
      overdue: 0,
      unassigned: 0,
      waitingOnCustomer: 0,
    });

    const first = await raise(ws.admin, 'Payslip missing');
    const second = await raise(ws.admin, 'Attendance not marking');
    const third = await raise(ws.admin, 'Leave balance wrong');
    await raise(ws.admin, 'Unassigned question');
    ok(await patch(ws.admin, first, { assigneeUserId: ws.agent.userId }));
    ok(
      await patch(ws.admin, second, {
        assigneeUserId: ws.agent.userId,
        status: 'waiting_on_customer',
      }),
    );
    ok(await patch(ws.admin, third, { assigneeUserId: ws.agent.userId, status: 'resolved' }));
    // An SLA deadline already passed.
    await query(
      `UPDATE tickets SET sla_due_at = now() - interval '5 minutes'
       WHERE number = :number AND workspace_id = (SELECT id FROM workspaces WHERE subdomain = :address)`,
      { number: first, address: ws.workspace.body.workspaceAddress },
    );

    const { counts } = await home(ws.agent);
    expect(counts).toEqual({ mine: 2, overdue: 1, unassigned: 1, waitingOnCustomer: 1 });
    expect(counts).toEqual({
      mine: await listTotal(ws.agent, 'status=open,pending,waiting_on_customer&assignee=me'),
      overdue: await listTotal(ws.agent, 'overdue=true'),
      unassigned: await listTotal(
        ws.agent,
        'status=open,pending,waiting_on_customer&assignee=none',
      ),
      waitingOnCustomer: await listTotal(ws.agent, 'status=waiting_on_customer&assignee=me'),
    });
    // "Mine" is each person's own.
    expect((await home(ws.admin)).counts.mine).toBe(0);
  });

  it('shows admins what is left to set up, ticking each step as it is done', async () => {
    const owner = await signedUpWorkspace();
    const admin: Member = { email: owner.body.email, userId: '', ...owner };
    expect((await home(admin)).setup).toEqual({
      teamInvited: false,
      emailConnected: false,
      businessHoursSet: false,
    });

    ok(await post(admin, '/invitations', { emails: ['neha@acme.test'], role: 'agent' }));
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
      (day) => ({ day, open: !day.startsWith('s'), start: '09:00', end: '18:00' }),
    );
    ok(
      await send({
        method: 'PUT',
        url: '/api/v1/workspace/business-hours',
        ...as(admin),
        payload: { timeZone: 'Asia/Kolkata', alwaysOpen: false, days },
      }),
    );
    expect((await home(admin)).setup).toEqual({
      teamInvited: true,
      emailConnected: false,
      businessHoursSet: true,
    });

    const number = await raise(admin, 'Forwarded by email');
    await query(
      `UPDATE tickets SET source = 'email'
       WHERE number = :number AND workspace_id = (SELECT id FROM workspaces WHERE subdomain = :address)`,
      { number, address: owner.body.workspaceAddress },
    );
    expect((await home(admin)).setup?.emailConnected).toBe(true);
  });

  it(
    'is for every member, with the checklist for admins only, per workspace',
    { timeout: 30_000 },
    async () => {
      const ws = await teamWorkspace();
      await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
        url: '/api/v1/home',
        ...as(member),
      }));
      expect((await home(ws.admin)).setup?.teamInvited).toBe(true);
      expect((await home(ws.supervisor)).setup).toBeNull();
      expect((await home(ws.agent)).setup).toBeNull();
      expect((await send({ url: '/api/v1/home', on: ws.admin.address })).statusCode).toBe(401);

      const intruder = await teamWorkspace();
      const byAddress = new Map([
        [ws.admin.address, ws.admin],
        [intruder.admin.address, intruder.admin],
      ]);
      await expectTenantIsolation({
        app: kit.app,
        workspaces: { owner: ws.admin.address, intruder: intruder.admin.address },
        setup: async () => {
          await raise(ws.admin, 'Secret ticket');
          return {
            secrets: ['Secret ticket'],
            checks: [{ kind: 'list', request: { method: 'GET', url: '/api/v1/home' } }],
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
      // The intruder's counts are its own: nothing of the owner's tickets.
      expect((await home(intruder.admin)).counts.unassigned).toBe(0);
    },
  );
});
