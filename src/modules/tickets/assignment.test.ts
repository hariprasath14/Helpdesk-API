import { describe, expect, it } from 'vitest';
import { accountsKit, as, type Member, type Team } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

type Response = Awaited<ReturnType<typeof send>>;
interface Ticket {
  number: number;
  status: string;
  assignee: { userId: string; name: string } | null;
}
interface Activity {
  actor: { name: string };
  changes: { field: string; from: unknown; to: unknown }[];
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
const assign = (member: Member, number: number, assigneeUserId: string | null) =>
  patch(member, `/tickets/${String(number)}`, { assigneeUserId });
const forbidden = (response: Response) => {
  expect(response.statusCode).toBe(403);
  expect(response.json<{ error: { message: string } }>().error.message).toBe(
    'You can take unassigned tickets or give back your own. A supervisor or admin can reassign others.',
  );
};

/** A workspace (Ravi admin, Sam supervisor, Ana agent) with two open tickets from Neha. */
async function setup(): Promise<Team & { contactId: string }> {
  const ws = await teamWorkspace();
  for (const [role, name] of [
    ['admin', 'Ravi Shankar'],
    ['supervisor', 'Sam Supervisor'],
    ['agent', 'Ana Agent'],
  ] as const) {
    // eslint-disable-next-line security/detect-object-injection -- a fixed role name
    const { userId } = ws[role];
    await query('UPDATE users SET name = :name WHERE id = :id', { name, id: userId });
  }
  const neha = ok<{ id: string }>(
    await post(ws.admin, '/contacts', { name: 'Neha Iyer', phone: '1' }),
  );
  ok(await post(ws.admin, '/tickets', { contactId: neha.id, subject: 'First' }));
  ok(await post(ws.admin, '/tickets', { contactId: neha.id, subject: 'Second' }));
  return { ...ws, contactId: neha.id };
}

describe('assigning tickets', () => {
  it('lets admins and supervisors assign anyone, with history', async () => {
    const ws = await setup();
    expect(ok<Ticket>(await assign(ws.admin, 1, ws.agent.userId)).assignee).toEqual({
      userId: ws.agent.userId,
      name: 'Ana Agent',
    });
    expect(ok<Ticket>(await assign(ws.supervisor, 1, ws.admin.userId)).assignee?.name).toBe(
      'Ravi Shankar',
    );
    expect(ok<Ticket>(await assign(ws.supervisor, 1, null)).assignee).toBeNull();
    const history = ok<{ activity: Activity[] }>(
      await get(ws.admin, '/tickets/1/activity'),
    ).activity;
    expect(history.slice(1).map((entry) => [entry.actor.name, entry.changes])).toEqual([
      ['Ravi Shankar', [{ field: 'assignee', from: null, to: 'Ana Agent' }]],
      ['Sam Supervisor', [{ field: 'assignee', from: 'Ana Agent', to: 'Ravi Shankar' }]],
      ['Sam Supervisor', [{ field: 'assignee', from: 'Ravi Shankar', to: null }]],
    ]);
    const list = ok<{ tickets: Ticket[] }>(await get(ws.agent, '/tickets?assignee=none')).tickets;
    expect(list.map((ticket) => ticket.number).sort()).toEqual([1, 2]);
  });

  it('lets agents take unassigned tickets and give back their own, nothing more', async () => {
    const ws = await setup();
    expect(ok<Ticket>(await assign(ws.agent, 1, ws.agent.userId)).assignee?.name).toBe('Ana Agent');
    expect(ok<Ticket>(await assign(ws.agent, 1, null)).assignee).toBeNull();
    forbidden(await assign(ws.agent, 1, ws.supervisor.userId));

    ok(await assign(ws.admin, 2, ws.supervisor.userId));
    forbidden(await assign(ws.agent, 2, ws.agent.userId));
    forbidden(await assign(ws.agent, 2, null));
    // Saving the same assignee is no change, so it is allowed.
    expect(ok<Ticket>(await assign(ws.agent, 2, ws.supervisor.userId)).assignee?.name).toBe(
      'Sam Supervisor',
    );
  });

  it('assigns on creating, with the same rules', async () => {
    const ws = await setup();
    const mine = ok<Ticket>(
      await post(ws.agent, '/tickets', {
        contactId: ws.contactId,
        subject: 'Mine',
        assigneeUserId: ws.agent.userId,
      }),
    );
    expect(mine.assignee?.name).toBe('Ana Agent');
    forbidden(
      await post(ws.agent, '/tickets', {
        contactId: ws.contactId,
        subject: 'Theirs',
        assigneeUserId: ws.supervisor.userId,
      }),
    );
    const theirs = ok<Ticket>(
      await post(ws.supervisor, '/tickets', {
        contactId: ws.contactId,
        subject: 'For Ana',
        assigneeUserId: ws.agent.userId,
      }),
    );
    expect(theirs.assignee?.name).toBe('Ana Agent');
  });

  it('refuses deactivated people and people from elsewhere', async () => {
    const ws = await setup();
    const other = await teamWorkspace();
    const refused = await assign(ws.admin, 1, other.agent.userId);
    expect(refused.statusCode).toBe(400);
    expect(
      refused.json<{ error: { details: { fields: { field: string; message: string }[] } } }>().error
        .details.fields,
    ).toEqual([
      { field: 'assigneeUserId', message: 'This person is deactivated or not in this workspace.' },
    ]);
    await query(
      "UPDATE memberships SET status = 'deactivated' WHERE user_id = :id AND workspace_id = (SELECT id FROM workspaces WHERE subdomain = :sub)",
      { id: ws.supervisor.userId, sub: ws.workspace.body.workspaceAddress },
    );
    expect((await assign(ws.admin, 1, ws.supervisor.userId)).statusCode).toBe(400);
  });

  it("unassigns a member's unresolved tickets when they are deactivated", async () => {
    const ws = await setup();
    ok(await assign(ws.admin, 1, ws.agent.userId));
    ok(
      await patch(ws.admin, '/tickets/2', { assigneeUserId: ws.agent.userId, status: 'resolved' }),
    );
    const deactivated = await send({
      method: 'POST',
      url: `/api/v1/members/${ws.agent.userId}/deactivate`,
      ...as(ws.admin),
    });
    expect(deactivated.statusCode, deactivated.body).toBe(204);
    expect(ok<Ticket>(await get(ws.admin, '/tickets/1')).assignee).toBeNull();
    expect(ok<Ticket>(await get(ws.admin, '/tickets/2')).assignee?.name).toBe('Ana Agent');
    const history = ok<{ activity: Activity[] }>(
      await get(ws.admin, '/tickets/1/activity'),
    ).activity;
    expect(history.at(-1)).toMatchObject({
      actor: { name: 'Ravi Shankar' },
      changes: [{ field: 'assignee', from: 'Ana Agent', to: null }],
    });
  });

  it('answers an assignment from the writer', async () => {
    const ws = await setup();
    await kit.restartApp(LAGGING_READER);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/tickets/1',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie, 'x-csrf-token': ws.admin.csrf },
        payload: { assigneeUserId: ws.agent.userId },
      },
      ['Ana Agent'],
    );
  });
});
