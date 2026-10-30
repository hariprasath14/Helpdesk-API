import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import {
  accountsKit,
  as,
  expectOnlyRoles,
  host,
  PASSWORD,
  tokenFrom,
  type Member,
} from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { PRODUCT_NAME } from '../../product.js';

const kit = accountsKit();
const { send, signedUpWorkspace, teamWorkspace, signIn, query } = kit;

const NEW_PASSWORD = 'quiet-harbour-lantern-41';
// Tests never rely on empty tables: every email in this run is unique to it.
const run = Math.random().toString(36).slice(2, 8);
const mail = (name: string) => `${name}.${run}@acme.test`;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

type Response = Awaited<ReturnType<typeof send>>;
const errorCode = (response: Response) => response.json<{ error: { code: string } }>().error.code;

/** Makes the password confirmation on a session older than 10 minutes. */
const staleReauth = (member: Member) =>
  query(
    "UPDATE sessions SET reauthenticated_at = now() - interval '11 minutes' WHERE user_id = :id",
    { id: member.userId },
  );

const invite = (admin: Member, emails: string[], role = 'agent') =>
  send({ method: 'POST', url: '/api/v1/invitations', ...as(admin), payload: { emails, role } });

const members = async (member: Member) => {
  const response = await send({ url: '/api/v1/members', ...as(member) });
  expect(response.statusCode).toBe(200);
  return response.json<{
    members: { userId: string; email: string; role: string; status: string; isOwner: boolean }[];
    invitations: { id: string; email: string; role: string; invitedByName: string | null }[];
  }>();
};

const me = (member: Member) =>
  send({ url: '/api/v1/me', on: member.address, cookie: member.cookie });

/** Invites a brand-new person and accepts as them; they belong to this workspace only. */
async function newMemberByInvitation(admin: Member, role = 'agent'): Promise<Member> {
  const email = `new.${Math.random().toString(36).slice(2, 10)}@acme.test`;
  expect((await invite(admin, [email], role)).statusCode).toBe(200);
  const accepted = await send({
    method: 'POST',
    url: '/api/v1/invitations/accept',
    on: admin.address,
    payload: {
      token: tokenFrom(kit.emails.lastTo(email)?.text),
      name: 'Neha Iyer',
      password: NEW_PASSWORD,
    },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const cookie = accepted.cookies.find((c) => c.name === 'helpdesk_session');
  const body = accepted.json<{ user: { id: string }; csrfToken: string }>();
  return {
    email,
    userId: body.user.id,
    address: admin.address,
    cookie: `helpdesk_session=${cookie?.value ?? ''}`,
    csrf: body.csrfToken,
  };
}

describe('permissions', () => {
  it('gives each role its permissions in /me', async () => {
    const team = await teamWorkspace();
    const permissions = async (member: Member) =>
      (await me(member)).json<{ permissions: string[] }>().permissions;
    expect(await permissions(team.admin)).toContain('members.manage');
    expect(await permissions(team.admin)).toContain('settings.manage');
    expect(await permissions(team.supervisor)).toEqual(
      expect.arrayContaining(['members.view', 'tickets.assign_any']),
    );
    expect(await permissions(team.supervisor)).not.toContain('members.manage');
    expect(await permissions(team.agent)).toEqual(['tickets.work', 'contacts.edit']);
  });

  it('lets admins and supervisors see the members list', async () => {
    const team = await teamWorkspace();
    await expectOnlyRoles(kit, team, ['admin', 'supervisor'], (member) => ({
      url: '/api/v1/members',
      ...as(member),
    }));
  });

  it('lets only admins manage members, invitations and security settings', async () => {
    const team = await teamWorkspace();
    // Nobody real: admins get past the permission check (404), the others must not.
    const target = UNKNOWN_ID;
    const requests = [
      { method: 'PATCH', url: `/api/v1/members/${target}`, payload: { role: 'agent' } },
      { method: 'POST', url: `/api/v1/members/${target}/deactivate` },
      { method: 'POST', url: `/api/v1/members/${target}/reactivate` },
      { method: 'POST', url: `/api/v1/members/${target}/reset-two-factor` },
      {
        method: 'POST',
        url: '/api/v1/invitations',
        payload: { emails: [mail('x')], role: 'agent' },
      },
      { method: 'POST', url: `/api/v1/invitations/${UNKNOWN_ID}/resend` },
      { method: 'DELETE', url: `/api/v1/invitations/${UNKNOWN_ID}` },
      { method: 'GET', url: '/api/v1/workspace/security' },
      { method: 'PATCH', url: '/api/v1/workspace/security', payload: { requireTwoFactor: false } },
    ] as const;
    for (const request of requests) {
      await expectOnlyRoles(kit, team, ['admin'], (member) => ({ ...request, ...as(member) }));
    }
  });
});

describe('members list', () => {
  it('lists every member with role, status and two-step verification, and open invitations', async () => {
    const team = await teamWorkspace();
    await invite(team.admin, [mail('pending')], 'supervisor');
    const list = await members(team.admin);

    expect(list.members).toHaveLength(3);
    expect(list.members.find((m) => m.userId === team.admin.userId)).toMatchObject({
      role: 'admin',
      isOwner: true,
      status: 'active',
    });
    expect(list.members.find((m) => m.userId === team.agent.userId)).toMatchObject({
      role: 'agent',
      isOwner: false,
      twoFactorEnabled: false,
      lastActiveAt: expect.any(String) as unknown,
    });
    expect(list.invitations).toEqual([
      expect.objectContaining({
        email: mail('pending'),
        role: 'supervisor',
        invitedByName: 'Ravi Shankar',
        expired: false,
      }),
    ]);
  });

  it("never shows or changes another workspace's members (tenant isolation)", async () => {
    const owner = await teamWorkspace();
    const intruder = await teamWorkspace();
    const byWorkspace = new Map([
      [owner.workspace.address, owner.admin],
      [intruder.workspace.address, intruder.admin],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: owner.workspace.address, intruder: intruder.workspace.address },
      setup: () =>
        Promise.resolve({
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/members' } },
            {
              kind: 'item',
              request: {
                method: 'PATCH',
                url: `/api/v1/members/${owner.agent.userId}`,
                payload: { role: 'agent' },
              },
            },
            {
              kind: 'item',
              request: { method: 'POST', url: `/api/v1/members/${owner.agent.userId}/reactivate` },
            },
          ],
          secrets: [owner.agent.email],
        }),
      actAs: (address) => {
        const admin = byWorkspace.get(address);
        if (!admin) throw new Error('unknown workspace');
        return Promise.resolve({
          headers: { host: admin.address, cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        });
      },
    });
  });
});

describe('inviting people', () => {
  it('emails each person a 7-day link to this workspace, and skips members with a reason', async () => {
    const team = await teamWorkspace();
    const response = await invite(team.admin, [
      mail('one'),
      mail('TWO'),
      team.agent.email,
      mail('one'),
    ]);
    expect(response.json()).toEqual({
      invited: [mail('one'), mail('two')],
      skipped: [{ email: team.agent.email, reason: 'Already a member.' }],
    });
    const message = kit.emails.lastTo(mail('two'));
    expect(message?.subject).toBe(
      `Ravi Shankar invited you to join Acme Support on ${PRODUCT_NAME}`,
    );
    expect(message?.text).toContain(`http://${team.admin.address}/invite?token=`);
    expect(message?.text).toContain('as an Agent');
    expect(message?.text).toContain('expires in 7 days');
  });

  it('replaces an open invitation when inviting the same person again', async () => {
    const team = await teamWorkspace();
    await invite(team.admin, [mail('again')]);
    const first = tokenFrom(kit.emails.lastTo(mail('again'))?.text);
    await invite(team.admin, [mail('again')], 'supervisor');
    const check = await send({
      method: 'POST',
      url: '/api/v1/invitations/check',
      on: team.admin.address,
      payload: { token: first },
    });
    expect(check.json()).toMatchObject({ error: { details: { reason: 'invalid' } } });
    expect((await members(team.admin)).invitations).toHaveLength(1);
  });

  it('needs the password confirmed recently to invite an admin', async () => {
    const team = await teamWorkspace();
    await staleReauth(team.admin);
    const refused = await invite(team.admin, [mail('boss')], 'admin');
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('REAUTH_REQUIRED');
    expect((await invite(team.admin, [mail('agent')], 'agent')).statusCode).toBe(200);

    await send({
      method: 'POST',
      url: '/api/v1/me/reauthenticate',
      ...as(team.admin),
      payload: { password: PASSWORD },
    });
    expect((await invite(team.admin, [mail('boss')], 'admin')).statusCode).toBe(200);
  });

  it('refuses more than 20 at once, and bad emails', async () => {
    const team = await teamWorkspace();
    const many = Array.from({ length: 21 }, (_, i) => `p${String(i)}@acme.test`);
    expect((await invite(team.admin, many)).statusCode).toBe(400);
    expect((await invite(team.admin, ['not-an-email'])).statusCode).toBe(400);
  });

  it('resends a fresh link (the old one stops working) and revokes', async () => {
    const team = await teamWorkspace();
    await invite(team.admin, [mail('later')]);
    const old = tokenFrom(kit.emails.lastTo(mail('later'))?.text);
    const [invitation] = (await members(team.admin)).invitations;
    const id = invitation?.id ?? '';

    const resent = await send({
      method: 'POST',
      url: `/api/v1/invitations/${id}/resend`,
      ...as(team.admin),
    });
    expect(resent.statusCode).toBe(204);
    const fresh = tokenFrom(kit.emails.lastTo(mail('later'))?.text);
    expect(fresh).not.toBe(old);
    const check = (token: string) =>
      send({
        method: 'POST',
        url: '/api/v1/invitations/check',
        on: team.admin.address,
        payload: { token },
      });
    expect((await check(old)).statusCode).toBe(400);
    expect((await check(fresh)).statusCode).toBe(200);

    await send({ method: 'DELETE', url: `/api/v1/invitations/${id}`, ...as(team.admin) });
    expect((await check(fresh)).json()).toMatchObject({
      error: { details: { reason: 'invalid' } },
    });
    const again = await send({
      method: 'DELETE',
      url: `/api/v1/invitations/${id}`,
      ...as(team.admin),
    });
    expect(again.statusCode).toBe(404);
  });

  it('shows a new invitation in the list even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const team = await teamWorkspace();
    await invite(team.admin, [mail('fresh')]);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'GET',
        url: '/api/v1/members',
        headers: { host: team.admin.address, cookie: team.admin.cookie },
      },
      [mail('fresh')],
    );
  });
});

describe('accepting an invitation', () => {
  const check = (address: string, token: string) =>
    send({ method: 'POST', url: '/api/v1/invitations/check', on: address, payload: { token } });
  const accept = (address: string, payload: Record<string, unknown>) =>
    send({ method: 'POST', url: '/api/v1/invitations/accept', on: address, payload });

  it('lets someone new choose a name and password, then signs them in with the invited role', async () => {
    const team = await teamWorkspace();
    await invite(team.admin, [mail('newbie')], 'supervisor');
    const token = tokenFrom(kit.emails.lastTo(mail('newbie'))?.text);

    expect((await check(team.admin.address, token)).json()).toEqual({
      email: mail('newbie'),
      workspaceName: 'Acme Support',
      role: 'supervisor',
      invitedByName: 'Ravi Shankar',
      existingAccount: false,
      twoFactorRequired: false,
    });
    const short = await accept(team.admin.address, { token, name: 'Neha', password: 'short' });
    expect(short.json()).toMatchObject({ error: { details: { fields: [{ field: 'password' }] } } });
    const noName = await accept(team.admin.address, { token, password: NEW_PASSWORD });
    expect(noName.json()).toMatchObject({ error: { details: { fields: [{ field: 'name' }] } } });
    kit.breached = true;
    const breached = await accept(team.admin.address, {
      token,
      name: 'Neha Iyer',
      password: NEW_PASSWORD,
    });
    expect(breached.json()).toMatchObject({
      error: { details: { fields: [{ field: 'password' }] } },
    });
    kit.breached = false;

    const joined = await accept(team.admin.address, {
      token,
      name: 'Neha Iyer',
      password: NEW_PASSWORD,
    });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({
      user: { name: 'Neha Iyer', email: mail('newbie') },
      role: 'supervisor',
      isOwner: false,
    });
    const [row] = await query<{ verified: boolean }>(
      'SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE email = :email',
      { email: mail('newbie') },
    );
    expect(row?.verified).toBe(true);
    expect((await check(team.admin.address, token)).json()).toMatchObject({
      error: { details: { reason: 'used' } },
    });
    expect((await members(team.admin)).invitations).toHaveLength(0);
  });

  it(`lets someone with a ${PRODUCT_NAME} account join with their password, then one login covers both`, async () => {
    const team = await teamWorkspace();
    const elsewhere = await signedUpWorkspace();
    await invite(team.admin, [elsewhere.body.email]);
    const token = tokenFrom(kit.emails.lastTo(elsewhere.body.email)?.text);
    expect((await check(team.admin.address, token)).json()).toMatchObject({
      existingAccount: true,
      twoFactorRequired: false,
    });

    const wrong = await accept(team.admin.address, { token, password: 'not-my-password' });
    expect(wrong.json()).toMatchObject({ error: { details: { fields: [{ field: 'password' }] } } });
    const joined = await accept(team.admin.address, { token, password: PASSWORD });
    expect(joined.json()).toMatchObject({ role: 'agent', user: { name: 'Ravi Shankar' } });
    await signIn(team.admin.address, elsewhere.body.email);
    await signIn(elsewhere.address, elsewhere.body.email);
  });

  it('asks an account with two-step verification for a code too', async () => {
    const team = await teamWorkspace();
    const elsewhere = await signedUpWorkspace();
    const setup = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      on: elsewhere.address,
      cookie: elsewhere.cookie,
      csrf: elsewhere.csrf,
      payload: { password: PASSWORD },
    });
    const totp = new TOTP({ secret: Secret.fromBase32(setup.json<{ secret: string }>().secret) });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      on: elsewhere.address,
      cookie: elsewhere.cookie,
      csrf: elsewhere.csrf,
      payload: { code: totp.generate() },
    });

    await invite(team.admin, [elsewhere.body.email]);
    const token = tokenFrom(kit.emails.lastTo(elsewhere.body.email)?.text);
    expect((await check(team.admin.address, token)).json()).toMatchObject({
      twoFactorRequired: true,
    });
    const noCode = await accept(team.admin.address, { token, password: PASSWORD });
    expect(noCode.json()).toMatchObject({
      error: { details: { codeRequired: true, fields: [{ field: 'code' }] } },
    });
    const wrongCode = await accept(team.admin.address, {
      token,
      password: PASSWORD,
      code: '000000',
    });
    expect(wrongCode.statusCode).toBe(400);
    const joined = await accept(team.admin.address, {
      token,
      password: PASSWORD,
      code: totp.generate({ timestamp: Date.now() + 30_000 }),
    });
    expect(joined.statusCode).toBe(200);
  });

  it('refuses expired links, and links on another workspace address', async () => {
    const team = await teamWorkspace();
    const other = await signedUpWorkspace();
    await invite(team.admin, [mail('late')]);
    const token = tokenFrom(kit.emails.lastTo(mail('late'))?.text);
    expect((await check(other.address, token)).json()).toMatchObject({
      error: { details: { reason: 'invalid' } },
    });
    await query(
      "UPDATE invitations SET expires_at = now() - interval '1 second' WHERE email = :email",
      { email: mail('late') },
    );
    expect((await check(team.admin.address, token)).json()).toMatchObject({
      error: { details: { reason: 'expired' } },
    });
  });

  it('sends someone new to two-step setup when the workspace requires it', async () => {
    const team = await teamWorkspace();
    await invite(team.admin, [mail('strict')]);
    await query('UPDATE workspaces SET require_two_factor = true WHERE subdomain = :address', {
      address: team.workspace.body.workspaceAddress,
    });
    const joined = await accept(team.admin.address, {
      token: tokenFrom(kit.emails.lastTo(mail('strict'))?.text),
      name: 'Strict Person',
      password: NEW_PASSWORD,
    });
    expect(joined.json()).toMatchObject({ twoFactor: { required: true, setupRequired: true } });
  });

  it('signs the new member in even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const team = await teamWorkspace();
    await invite(team.admin, [mail('lag')]);
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        headers: { host: team.admin.address },
        payload: {
          token: tokenFrom(kit.emails.lastTo(mail('lag'))?.text),
          name: 'Lag Test',
          password: NEW_PASSWORD,
        },
      },
      [mail('lag')],
    );
  });
});

describe('changing roles', () => {
  const changeRole = (admin: Member, target: string, role: string) =>
    send({ method: 'PATCH', url: `/api/v1/members/${target}`, ...as(admin), payload: { role } });

  it('takes effect on the member’s next request', async () => {
    const team = await teamWorkspace();
    expect((await changeRole(team.admin, team.agent.userId, 'supervisor')).statusCode).toBe(204);
    expect((await me(team.agent)).json()).toMatchObject({ role: 'supervisor' });
    expect((await send({ url: '/api/v1/members', ...as(team.agent) })).statusCode).toBe(200);
  });

  it('needs the password confirmed recently to make someone an admin', async () => {
    const team = await teamWorkspace();
    await staleReauth(team.admin);
    const refused = await changeRole(team.admin, team.agent.userId, 'admin');
    expect(errorCode(refused)).toBe('REAUTH_REQUIRED');
    const wrong = await send({
      method: 'POST',
      url: '/api/v1/me/reauthenticate',
      ...as(team.admin),
      payload: { password: 'not-my-password' },
    });
    expect(wrong.json()).toMatchObject({ error: { details: { fields: [{ field: 'password' }] } } });
    await send({
      method: 'POST',
      url: '/api/v1/me/reauthenticate',
      ...as(team.admin),
      payload: { password: PASSWORD },
    });
    expect((await changeRole(team.admin, team.agent.userId, 'admin')).statusCode).toBe(204);
  });

  it("protects the owner's role and keeps at least one admin", async () => {
    const team = await teamWorkspace();
    const owner = await changeRole(team.admin, team.admin.userId, 'agent');
    expect(owner.statusCode).toBe(409);

    await query('UPDATE memberships SET is_owner = false WHERE user_id = :id', {
      id: team.admin.userId,
    });
    const last = await changeRole(team.admin, team.admin.userId, 'agent');
    expect(last.json<{ error: { message: string } }>().error.message).toBe(
      'A workspace needs at least one admin.',
    );
    expect((await changeRole(team.admin, UNKNOWN_ID, 'agent')).statusCode).toBe(404);
  });
});

describe('deactivating', () => {
  const deactivate = (admin: Member, target: string) =>
    send({ method: 'POST', url: `/api/v1/members/${target}/deactivate`, ...as(admin) });

  it('signs the member out of this workspace at once and keeps them out until reactivated', async () => {
    const team = await teamWorkspace();
    expect((await deactivate(team.admin, team.agent.userId)).statusCode).toBe(204);

    expect((await me(team.agent)).statusCode).toBe(401);
    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: team.admin.address,
      payload: { email: team.agent.email, password: PASSWORD },
    });
    expect(errorCode(login)).toBe('INVALID_CREDENTIALS');
    const list = await members(team.admin);
    expect(list.members.find((m) => m.userId === team.agent.userId)?.status).toBe('deactivated');
    expect((await invite(team.admin, [team.agent.email])).json()).toMatchObject({
      skipped: [{ reason: 'Deactivated. Reactivate them instead.' }],
    });

    const reactivated = await send({
      method: 'POST',
      url: `/api/v1/members/${team.agent.userId}/reactivate`,
      ...as(team.admin),
    });
    expect(reactivated.statusCode).toBe(204);
    await signIn(team.admin.address, team.agent.email);
  });

  it('leaves their other workspaces alone', async () => {
    const team = await teamWorkspace();
    await deactivate(team.admin, team.agent.userId);
    const [own] = await query<{ subdomain: string }>(
      `SELECT w.subdomain FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = :id AND m.is_owner`,
      { id: team.agent.userId },
    );
    await signIn(host(own?.subdomain), team.agent.email);
  });

  it('never deactivates the owner or yourself, and needs the password confirmed recently', async () => {
    const team = await teamWorkspace();
    expect((await deactivate(team.admin, team.admin.userId)).statusCode).toBe(409);
    await query('UPDATE memberships SET role = :role WHERE user_id = :id', {
      role: 'admin',
      id: team.supervisor.userId,
    });
    const owner = await deactivate(team.supervisor, team.admin.userId);
    expect(owner.json<{ error: { message: string } }>().error.message).toBe(
      "The workspace owner can't be deactivated.",
    );
    await staleReauth(team.admin);
    expect(errorCode(await deactivate(team.admin, team.agent.userId))).toBe('REAUTH_REQUIRED');
  });
});

describe("resetting a member's two-step verification", () => {
  const reset = (admin: Member, target: string) =>
    send({ method: 'POST', url: `/api/v1/members/${target}/reset-two-factor`, ...as(admin) });

  async function turnOn(member: Member) {
    const setup = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...as(member),
      payload: { password: NEW_PASSWORD },
    });
    const secret = setup.json<{ secret: string }>().secret;
    const confirm = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      ...as(member),
      payload: { code: new TOTP({ secret: Secret.fromBase32(secret) }).generate() },
    });
    expect(confirm.statusCode).toBe(200);
  }

  it('removes it, signs them out everywhere and emails them', async () => {
    const team = await teamWorkspace();
    const member = await newMemberByInvitation(team.admin);
    await turnOn(member);

    expect((await reset(team.admin, member.userId)).statusCode).toBe(204);
    expect((await me(member)).statusCode).toBe(401);
    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: member.address,
      payload: { email: member.email, password: NEW_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ twoFactor: { enabled: false } });
    expect(kit.emails.lastTo(member.email)?.subject).toBe(
      `Your ${PRODUCT_NAME} two-step verification was reset`,
    );
  });

  it('is refused for someone who also belongs to another workspace, for yourself, or when it is off', async () => {
    const team = await teamWorkspace();
    const other = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...as(team.agent),
      payload: { password: PASSWORD },
    });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      ...as(team.agent),
      payload: {
        code: new TOTP({
          secret: Secret.fromBase32(other.json<{ secret: string }>().secret),
        }).generate(),
      },
    });
    expect(errorCode(await reset(team.admin, team.agent.userId))).toBe(
      'MEMBER_IN_OTHER_WORKSPACES',
    );
    expect((await reset(team.admin, team.admin.userId)).statusCode).toBe(409);
    const member = await newMemberByInvitation(team.admin);
    expect((await reset(team.admin, member.userId)).statusCode).toBe(409);
    expect((await reset(team.admin, UNKNOWN_ID)).statusCode).toBe(404);
  });
});

describe('confirming the password', () => {
  it('counts wrong passwords toward the login lock', async () => {
    const team = await teamWorkspace();
    const attempt = () =>
      send({
        method: 'POST',
        url: '/api/v1/me/reauthenticate',
        ...as(team.admin),
        payload: { password: 'not-my-password' },
      });
    for (let n = 1; n <= 4; n += 1) expect((await attempt()).statusCode).toBe(400);
    expect(errorCode(await attempt())).toBe('LOGIN_LOCKED');
    expect(errorCode(await attempt())).toBe('LOGIN_LOCKED');
  });
});
