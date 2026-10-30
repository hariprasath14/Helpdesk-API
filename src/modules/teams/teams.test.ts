import { describe, expect, it } from 'vitest';
import {
  accountsKit,
  as,
  expectOnlyRoles,
  tokenFrom,
  type Member,
  type Team as Workspace,
} from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';

const kit = accountsKit();
const { send, teamWorkspace, query } = kit;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

interface TeamMember {
  userId: string;
  name: string;
  isLead: boolean;
  status: string;
  role: string;
}
interface Team {
  id: string;
  name: string;
  description: string | null;
  members: TeamMember[];
  updatedAt: string;
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

async function team(member: Member, payload: Record<string, unknown>): Promise<Team> {
  const response = await post(member, '/teams', payload);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Team>();
}
async function auditSummaries(member: Member, count = 1) {
  const response = await get(member, '/audit-log?category=settings');
  return response
    .json<{ entries: { summary: string }[] }>()
    .entries.slice(0, count)
    .map((entry) => entry.summary);
}

/** The people of a test workspace by first name: Ravi (admin, owner), Sam (supervisor), Ana (agent). */
async function named(workspace: Workspace) {
  for (const [role, name] of [
    ['admin', 'Ravi Shankar'],
    ['supervisor', 'Sam Supervisor'],
    ['agent', 'Ana Agent'],
  ] as const) {
    // eslint-disable-next-line security/detect-object-injection -- a fixed role name
    const { userId } = workspace[role];
    await query('UPDATE users SET name = :name WHERE id = :id', { name, id: userId });
  }
  return workspace;
}

describe('teams', () => {
  it('adds a team with members and leads; everyone can list and read it', async () => {
    const ws = await named(await teamWorkspace());
    const added = await team(ws.admin, {
      name: '  Billing ',
      description: 'Invoices and refunds',
      members: [{ userId: ws.agent.userId }, { userId: ws.supervisor.userId, isLead: true }],
    });
    expect(added).toMatchObject({
      name: 'Billing',
      description: 'Invoices and refunds',
      members: [
        { userId: ws.supervisor.userId, name: 'Sam Supervisor', isLead: true, role: 'supervisor' },
        { userId: ws.agent.userId, name: 'Ana Agent', isLead: false, status: 'active' },
      ],
    });
    await team(ws.admin, { name: 'Accounts' });

    for (const member of [ws.admin, ws.supervisor, ws.agent]) {
      const list = (await get(member, '/teams')).json<{ teams: Team[] }>();
      expect(list.teams.map((item) => item.name)).toEqual(['Accounts', 'Billing']);
      expect((await get(member, `/teams/${added.id}`)).json<Team>().name).toBe('Billing');
    }
    expect((await get(ws.agent, `/teams/${UNKNOWN_ID}`)).statusCode).toBe(404);
    expect(await auditSummaries(ws.admin, 2)).toEqual([
      'Ravi Shankar created the team "Accounts".',
      'Ravi Shankar created the team "Billing" with Ana Agent and Sam Supervisor.',
    ]);
  });

  it('keeps names unique ignoring case, and checks the member list', async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, { name: 'Billing' });
    const support = await team(ws.admin, { name: 'Support' });
    expect(problems(await post(ws.admin, '/teams', { name: 'BILLING' }))).toEqual({
      name: 'There is already a team with this name.',
    });
    expect(problems(await patch(ws.admin, `/teams/${support.id}`, { name: 'billing' }))).toEqual({
      name: 'There is already a team with this name.',
    });
    // Changing only the case of its own name is fine.
    expect((await patch(ws.admin, `/teams/${billing.id}`, { name: 'BILLING' })).statusCode).toBe(
      200,
    );
    expect((await post(ws.admin, '/teams', { name: '   ' })).statusCode).toBe(400);

    const outsider = await kit.signedUpWorkspace();
    const [row] = await query<{ id: string }>('SELECT id FROM users WHERE email = :email', {
      email: outsider.body.email,
    });
    expect(
      problems(
        await post(ws.admin, '/teams', {
          name: 'Mixed',
          members: [
            { userId: ws.agent.userId },
            { userId: ws.agent.userId },
            { userId: row?.id ?? UNKNOWN_ID },
          ],
        }),
      ),
    ).toEqual({
      'members.1': 'This person is listed twice.',
      'members.2': 'This person is not a member of this workspace.',
    });
  });

  it('changes name, description, members and leads, and records what changed', async () => {
    const ws = await named(await teamWorkspace());
    const billing = await team(ws.admin, {
      name: 'Billing',
      description: 'Old',
      members: [{ userId: ws.agent.userId }],
    });
    const response = await patch(ws.admin, `/teams/${billing.id}`, {
      name: 'Accounts',
      description: '',
      members: [{ userId: ws.agent.userId, isLead: true }, { userId: ws.supervisor.userId }],
      updatedAt: billing.updatedAt,
    });
    expect(response.statusCode, response.body).toBe(200);
    const changed = response.json<Team>();
    expect(changed).toMatchObject({
      name: 'Accounts',
      description: null,
      members: [
        { name: 'Ana Agent', isLead: true },
        { name: 'Sam Supervisor', isLead: false },
      ],
    });
    expect(changed.updatedAt).not.toBe(billing.updatedAt);
    expect(await auditSummaries(ws.admin)).toEqual([
      'Ravi Shankar changed the team "Accounts": renamed it from "Billing"; changed the description; added Sam Supervisor; made Ana Agent team lead.',
    ]);

    await patch(ws.admin, `/teams/${billing.id}`, {
      members: [{ userId: ws.supervisor.userId }],
    });
    expect(await auditSummaries(ws.admin)).toEqual([
      'Ravi Shankar changed the team "Accounts": removed Ana Agent.',
    ]);

    // Saving with nothing changed records nothing.
    const before = (await get(ws.admin, '/audit-log')).json<{ entries: unknown[] }>().entries
      .length;
    await patch(ws.admin, `/teams/${billing.id}`, {
      name: 'Accounts',
      members: [{ userId: ws.supervisor.userId }],
    });
    expect((await get(ws.admin, '/audit-log')).json<{ entries: unknown[] }>().entries.length).toBe(
      before,
    );
  });

  it('refuses a save over someone else’s change', async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, { name: 'Billing' });
    await patch(ws.admin, `/teams/${billing.id}`, { members: [{ userId: ws.agent.userId }] });
    const stale = await patch(ws.admin, `/teams/${billing.id}`, {
      name: 'Mine',
      updatedAt: billing.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('TEAM_CHANGED');
    expect((await patch(ws.admin, `/teams/${UNKNOWN_ID}`, { name: 'X' })).statusCode).toBe(404);
  });

  it('keeps deactivated members in their teams but does not let them be added', async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, {
      name: 'Billing',
      members: [{ userId: ws.agent.userId }],
    });
    await query(
      "UPDATE memberships SET status = 'deactivated' WHERE user_id = :id AND workspace_id = (SELECT id FROM workspaces WHERE subdomain = :sub)",
      { id: ws.agent.userId, sub: ws.workspace.body.workspaceAddress },
    );
    const kept = (await get(ws.admin, `/teams/${billing.id}`)).json<Team>();
    expect(kept.members).toMatchObject([{ userId: ws.agent.userId, status: 'deactivated' }]);
    expect(
      (
        await patch(ws.admin, `/teams/${billing.id}`, {
          members: [{ userId: ws.agent.userId, isLead: true }],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      Object.values(
        problems(
          await post(ws.admin, '/teams', {
            name: 'Support',
            members: [{ userId: ws.agent.userId }],
          }),
        ),
      )[0],
    ).toMatch(/is deactivated\.$/);
  });

  it('deletes a team; its people stay in the workspace', async () => {
    const ws = await named(await teamWorkspace());
    const billing = await team(ws.admin, {
      name: 'Billing',
      members: [{ userId: ws.agent.userId }],
    });
    expect((await remove(ws.admin, `/teams/${billing.id}`)).statusCode).toBe(204);
    expect((await get(ws.admin, `/teams/${billing.id}`)).statusCode).toBe(404);
    expect((await remove(ws.admin, `/teams/${billing.id}`)).statusCode).toBe(404);
    const people = (await get(ws.admin, '/members')).json<{ members: { userId: string }[] }>();
    expect(people.members.map((member) => member.userId)).toContain(ws.agent.userId);
    expect(await auditSummaries(ws.admin)).toEqual(['Ravi Shankar deleted the team "Billing".']);
  });

  it('allows at most 100 teams', async () => {
    const ws = await teamWorkspace();
    await query(
      `INSERT INTO teams (id, workspace_id, name, created_at, updated_at)
       SELECT gen_random_uuid(), w.id, 'Team ' || n, now(), now()
       FROM workspaces w, generate_series(1, 100) n WHERE w.subdomain = :sub`,
      { sub: ws.workspace.body.workspaceAddress },
    );
    const refused = await post(ws.admin, '/teams', { name: 'One more' });
    expect(refused.statusCode).toBe(409);
  });

  it('lets only admins add, change and delete teams; every role reads them', async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, { name: 'Billing' });
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'POST',
      url: '/api/v1/teams',
      ...as(member),
      payload: { name: `Team ${member.email}` },
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'PATCH',
      url: `/api/v1/teams/${billing.id}`,
      ...as(member),
      payload: { description: member.email },
    }));
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: '/api/v1/teams',
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin', 'supervisor', 'agent'], (member) => ({
      url: `/api/v1/teams/${billing.id}`,
      ...as(member),
    }));
    await expectOnlyRoles(kit, ws, ['admin'], (member) => ({
      method: 'DELETE',
      url: `/api/v1/teams/${billing.id}`,
      ...as(member),
    }));
  });

  it("never shows or changes another workspace's teams", async () => {
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
        const secret = await team(owner.admin, {
          name: 'Secret escalations',
          members: [{ userId: owner.agent.userId }],
        });
        return {
          secrets: ['Secret escalations'],
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/teams' } },
            { kind: 'item', request: { method: 'GET', url: `/api/v1/teams/${secret.id}` } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/teams/${secret.id}`,
                payload: { description: 'changed' },
              },
            },
            { kind: 'item', request: { method: 'DELETE', url: `/api/v1/teams/${secret.id}` } },
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
    // Someone from another workspace can't be put into a team.
    expect(
      (
        await post(owner.admin, '/teams', {
          name: 'Borrowed',
          members: [{ userId: intruder.agent.userId }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it('answers adds and changes from the writer', async () => {
    const ws = await teamWorkspace();
    await kit.restartApp(LAGGING_READER);
    const added = await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/teams',
        headers: { host: ws.admin.address, 'x-csrf-token': ws.admin.csrf, cookie: ws.admin.cookie },
        payload: { name: 'Lagging team', members: [{ userId: ws.agent.userId }] },
      },
      ['Lagging team', ws.agent.userId],
    );
    const id = added.json<Team>().id;
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: `/api/v1/teams/${id}`,
        headers: { host: ws.admin.address, 'x-csrf-token': ws.admin.csrf, cookie: ws.admin.cookie },
        payload: { name: 'Renamed lagging team' },
      },
      ['Renamed lagging team'],
    );
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'GET',
        url: '/api/v1/teams',
        headers: { host: ws.admin.address, cookie: ws.admin.cookie },
      },
      ['Renamed lagging team'],
    );
  });
});

describe('teams on the members page and in invitations', () => {
  it("shows each member's teams", async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, {
      name: 'Billing',
      members: [{ userId: ws.agent.userId, isLead: true }],
    });
    const accounts = await team(ws.admin, {
      name: 'Accounts',
      members: [{ userId: ws.agent.userId }],
    });
    const list = (await get(ws.admin, '/members')).json<{
      members: { userId: string; teams: { id: string; name: string; isLead: boolean }[] }[];
    }>();
    expect(list.members.find((member) => member.userId === ws.agent.userId)?.teams).toEqual([
      { id: accounts.id, name: 'Accounts', isLead: false },
      { id: billing.id, name: 'Billing', isLead: true },
    ]);
    expect(list.members.find((member) => member.userId === ws.admin.userId)?.teams).toEqual([]);
  });

  it('invites people into teams; they join them on accepting', async () => {
    const ws = await teamWorkspace();
    const billing = await team(ws.admin, { name: 'Billing' });
    const support = await team(ws.admin, { name: 'Support' });
    const email = `teamed.${Math.random().toString(36).slice(2, 10)}@acme.test`;

    expect(
      problems(
        await post(ws.admin, '/invitations', {
          emails: [email],
          role: 'agent',
          teamIds: [billing.id, UNKNOWN_ID],
        }),
      ),
    ).toEqual({ teamIds: 'One of these teams no longer exists. Reload and try again.' });

    const invited = await post(ws.admin, '/invitations', {
      emails: [email],
      role: 'agent',
      teamIds: [support.id, billing.id],
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const pending = (await get(ws.admin, '/members')).json<{
      invitations: { email: string; teams: { name: string }[] }[];
    }>();
    expect(pending.invitations.find((row) => row.email === email)?.teams).toEqual([
      { id: billing.id, name: 'Billing' },
      { id: support.id, name: 'Support' },
    ]);
    // A team deleted before they accept is simply left out.
    await remove(ws.admin, `/teams/${support.id}`);

    const accepted = await send({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      on: ws.admin.address,
      payload: {
        token: tokenFrom(kit.emails.lastTo(email)?.text),
        name: 'Neha Iyer',
        password: 'a-long-enough-new-password-77',
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const joined = (await get(ws.admin, `/teams/${billing.id}`)).json<Team>();
    expect(joined.members.map((member) => member.name)).toEqual(['Neha Iyer']);
    const log = (await get(ws.admin, '/audit-log?category=members')).json<{
      entries: { summary: string }[];
    }>();
    expect(log.entries[0]?.summary).toBe('Neha Iyer joined as Agent, in Billing.');
  });
});
