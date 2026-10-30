import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { withWorkspace } from '../../db/tenant.js';
import {
  accountsKit,
  as,
  expectOnlyRoles,
  PASSWORD,
  tokenFrom,
  type Member,
} from '../../test/accounts.js';
import { testDatabase } from '../../test/helpers.js';
import { expectTenantIsolation } from '../../test/tenant-isolation.js';
import { PRODUCT_NAME } from '../../product.js';

const kit = accountsKit();
const { send, signedUpWorkspace, teamWorkspace, query } = kit;

const CHROME_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

interface Entry {
  id: string;
  action: string;
  category: string;
  summary: string;
  actor: { type: string; name: string; email: string | null; role: string | null };
  target: { label: string } | null;
  details: Record<string, unknown>;
  ip: string | null;
  device: string;
}

async function auditOf(admin: Member, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await send({
    url: `/api/v1/audit-log${query ? `?${query}` : ''}`,
    ...as(admin),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ entries: Entry[]; nextCursor: string | null }>();
}

const actions = async (admin: Member, params: Record<string, string> = {}) =>
  (await auditOf(admin, params)).entries.map((entry) => entry.action);

/** The owner of a fresh workspace as a Member (signed in by confirming the email). */
async function owner(): Promise<Member> {
  const workspace = await signedUpWorkspace();
  const [row] = await query<{ id: string }>('SELECT id FROM users WHERE email = :email', {
    email: workspace.body.email,
  });
  return {
    email: workspace.body.email,
    userId: row?.id ?? '',
    address: workspace.address,
    cookie: workspace.cookie,
    csrf: workspace.csrf,
  };
}

describe('what gets recorded', () => {
  it('records the workspace being created and the first sign-in', async () => {
    const admin = await owner();
    const { entries } = await auditOf(admin);
    expect(entries.map((entry) => entry.summary)).toEqual([
      'Ravi Shankar signed in by confirming their email.',
      'Ravi Shankar created the workspace.',
    ]);
    expect(entries[1]).toMatchObject({
      category: 'settings',
      actor: { type: 'member', name: 'Ravi Shankar', email: admin.email, role: 'admin' },
    });
  });

  it('records each sign-in with where it came from', async () => {
    const admin = await owner();
    await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: admin.address,
      remoteAddress: '203.0.113.9',
      headers: { 'user-agent': CHROME_ON_WINDOWS },
      payload: { email: admin.email, password: PASSWORD },
    });
    const [latest] = (await auditOf(admin)).entries;
    expect(latest).toMatchObject({
      action: 'sign_in.succeeded',
      category: 'sign_in',
      summary: 'Ravi Shankar signed in.',
      ip: '203.0.113.9',
      device: 'Chrome on Windows',
    });
  });

  it(`records a lock after too many attempts on a member, by ${PRODUCT_NAME} itself`, async () => {
    const admin = await owner();
    for (let n = 0; n < 5; n += 1) {
      await send({
        method: 'POST',
        url: '/api/v1/auth/login',
        on: admin.address,
        payload: { email: admin.email, password: 'not-my-password' },
      });
    }
    const [latest] = (await auditOf(admin)).entries;
    expect(latest).toMatchObject({
      action: 'sign_in.locked',
      actor: { type: 'system', name: PRODUCT_NAME },
      summary: 'Sign-in for Ravi Shankar was locked after too many attempts.',
    });
  });

  it('records member changes with before and after, and nothing for a change that fails or changes nothing', async () => {
    const team = await teamWorkspace();
    const patch = (userId: string, role: string) =>
      send({
        method: 'PATCH',
        url: `/api/v1/members/${userId}`,
        ...as(team.admin),
        payload: { role },
      });

    await patch(team.agent.userId, 'supervisor');
    await patch(team.agent.userId, 'supervisor');
    await patch(team.admin.userId, 'agent');
    await send({
      method: 'POST',
      url: `/api/v1/members/${team.agent.userId}/deactivate`,
      ...as(team.admin),
    });
    await send({
      method: 'POST',
      url: `/api/v1/members/${team.agent.userId}/reactivate`,
      ...as(team.admin),
    });

    const { entries } = await auditOf(team.admin, { category: 'members' });
    expect(entries.map((entry) => entry.summary)).toEqual([
      'Ravi Shankar reactivated Ravi Shankar.',
      'Ravi Shankar deactivated Ravi Shankar.',
      "Ravi Shankar changed Ravi Shankar's role from Agent to Supervisor.",
    ]);
    expect(entries[2]?.details).toEqual({
      from: 'agent',
      to: 'supervisor',
      email: team.agent.email,
    });
  });

  it('records invitations from sending to joining', async () => {
    const admin = await owner();
    const email = `invitee.${Math.random().toString(36).slice(2, 8)}@acme.test`;
    await send({
      method: 'POST',
      url: '/api/v1/invitations',
      ...as(admin),
      payload: { emails: [email], role: 'supervisor' },
    });
    const list = await send({ url: '/api/v1/members', ...as(admin) });
    const invitationId = list.json<{ invitations: { id: string }[] }>().invitations[0]?.id ?? '';
    await send({ method: 'POST', url: `/api/v1/invitations/${invitationId}/resend`, ...as(admin) });
    await send({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      on: admin.address,
      payload: {
        token: tokenFrom(kit.emails.lastTo(email)?.text),
        name: 'Neha Iyer',
        password: 'quiet-harbour-lantern-41',
      },
    });

    const summaries = (await auditOf(admin)).entries.map((entry) => entry.summary);
    expect(summaries.slice(0, 4)).toEqual([
      'Neha Iyer signed in after accepting an invitation.',
      'Neha Iyer joined as Supervisor.',
      `Ravi Shankar sent a new invitation link to ${email}.`,
      `Ravi Shankar invited ${email} as Supervisor.`,
    ]);
  });

  it('records revoking an invitation', async () => {
    const admin = await owner();
    await send({
      method: 'POST',
      url: '/api/v1/invitations',
      ...as(admin),
      payload: { emails: ['revoked@acme.test'], role: 'agent' },
    });
    const list = await send({ url: '/api/v1/members', ...as(admin) });
    const invitationId = list.json<{ invitations: { id: string }[] }>().invitations[0]?.id ?? '';
    await send({ method: 'DELETE', url: `/api/v1/invitations/${invitationId}`, ...as(admin) });
    expect((await auditOf(admin)).entries[0]?.summary).toBe(
      'Ravi Shankar revoked the invitation for revoked@acme.test.',
    );
  });

  it("records a person's own security changes in every workspace they belong to", async () => {
    const team = await teamWorkspace();
    const [own] = await query<{ subdomain: string }>(
      `SELECT w.subdomain FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = :id AND m.is_owner`,
      { id: team.agent.userId },
    );
    const ownAddress = `${own?.subdomain ?? ''}.helpdesk.test`;

    const wrong = await send({
      method: 'POST',
      url: '/api/v1/me/password',
      ...as(team.agent),
      payload: { currentPassword: 'not-my-password', newPassword: 'quiet-harbour-lantern-41' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(await actions(team.admin)).not.toContain('password.changed');

    await send({
      method: 'POST',
      url: '/api/v1/me/password',
      ...as(team.agent),
      payload: { currentPassword: PASSWORD, newPassword: 'quiet-harbour-lantern-41' },
    });
    const inTeam = (await auditOf(team.admin, { category: 'security' })).entries[0];
    expect(inTeam).toMatchObject({
      action: 'password.changed',
      actor: { email: team.agent.email, role: 'agent' },
    });
    // The change signed them out everywhere: sign in to their own workspace with the new password.
    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: ownAddress,
      payload: { email: team.agent.email, password: 'quiet-harbour-lantern-41' },
    });
    const ownAdmin: Member = {
      ...team.agent,
      address: ownAddress,
      cookie: `helpdesk_session=${login.cookies.find((c) => c.name === 'helpdesk_session')?.value ?? ''}`,
      csrf: login.json<{ csrfToken: string }>().csrfToken,
    };
    const inOwn = (await auditOf(ownAdmin, { category: 'security' })).entries[0];
    expect(inOwn).toMatchObject({ action: 'password.changed', actor: { role: 'admin' } });
  });

  it('records two-step verification being turned on, new codes, turned off, and other devices signed out', async () => {
    const admin = await owner();
    const setup = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...as(admin),
      payload: { password: PASSWORD },
    });
    const totp = new TOTP({ secret: Secret.fromBase32(setup.json<{ secret: string }>().secret) });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      ...as(admin),
      payload: { code: totp.generate() },
    });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/recovery-codes',
      ...as(admin),
      payload: { password: PASSWORD },
    });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/disable',
      ...as(admin),
      payload: { password: PASSWORD, code: totp.generate({ timestamp: Date.now() + 30_000 }) },
    });
    await send({ method: 'POST', url: '/api/v1/me/sessions/sign-out-others', ...as(admin) });

    expect((await auditOf(admin, { category: 'security' })).entries.map((e) => e.summary)).toEqual([
      'Ravi Shankar signed out of all other devices.',
      'Ravi Shankar turned off two-step verification.',
      'Ravi Shankar created new recovery codes.',
      'Ravi Shankar turned on two-step verification.',
    ]);
  });

  it("records the workspace's two-step rule and an admin's reset of a member's two-step verification", async () => {
    const admin = await owner();
    const setup = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...as(admin),
      payload: { password: PASSWORD },
    });
    await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      ...as(admin),
      payload: {
        code: new TOTP({
          secret: Secret.fromBase32(setup.json<{ secret: string }>().secret),
        }).generate(),
      },
    });
    const rule = (requireTwoFactor: boolean) =>
      send({
        method: 'PATCH',
        url: '/api/v1/workspace/security',
        ...as(admin),
        payload: { requireTwoFactor },
      });
    await rule(true);
    await rule(true);
    await rule(false);
    const settings = (await auditOf(admin, { category: 'settings' })).entries.map((e) => e.summary);
    expect(settings.slice(0, 2)).toEqual([
      'Ravi Shankar stopped requiring two-step verification.',
      'Ravi Shankar required two-step verification for everyone.',
    ]);
  });

  it('records a password reset from an email link', async () => {
    const admin = await owner();
    await send({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      on: admin.address,
      payload: { email: admin.email },
    });
    await send({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      on: admin.address,
      payload: {
        token: tokenFrom(kit.emails.lastTo(admin.email)?.text),
        password: 'quiet-harbour-lantern-41',
      },
    });
    const fresh = await kit.signIn(admin.address, admin.email).catch(() => null);
    expect(fresh).toBeNull();
    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: admin.address,
      payload: { email: admin.email, password: 'quiet-harbour-lantern-41' },
    });
    const session = login.cookies.find((c) => c.name === 'helpdesk_session');
    const reader = {
      ...admin,
      cookie: `helpdesk_session=${session?.value ?? ''}`,
      csrf: login.json<{ csrfToken: string }>().csrfToken,
    };
    expect(await actions(reader, { category: 'security' })).toContain('password.reset');
  });
});

describe('reading the audit log', () => {
  it('is for admins only', async () => {
    const team = await teamWorkspace();
    for (const url of ['/api/v1/audit-log', '/api/v1/audit-log/export']) {
      await expectOnlyRoles(kit, team, ['admin'], (member) => ({ url, ...as(member) }));
    }
  });

  it("never shows another workspace's entries (tenant isolation)", async () => {
    const first = await owner();
    const second = await owner();
    const byAddress = new Map([
      [first.address, first],
      [second.address, second],
    ]);
    await expectTenantIsolation({
      app: kit.app,
      workspaces: { owner: first.address, intruder: second.address },
      setup: () =>
        Promise.resolve({
          checks: [
            { kind: 'list', request: { method: 'GET', url: '/api/v1/audit-log' } },
            { kind: 'list', request: { method: 'GET', url: '/api/v1/audit-log/export' } },
          ],
          secrets: [first.email],
        }),
      actAs: (address) => {
        const admin = byAddress.get(address);
        if (!admin) throw new Error('unknown workspace');
        return Promise.resolve({ headers: { host: admin.address, cookie: admin.cookie } });
      },
    });
  });

  it('pages newest first with a cursor, without repeating or skipping entries', async () => {
    const admin = await owner();
    for (let n = 0; n < 3; n += 1) await kit.signIn(admin.address, admin.email);
    const all = (await auditOf(admin, { limit: '100' })).entries.map((entry) => entry.id);
    expect(all).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { entries: Entry[]; nextCursor: string | null } = await auditOf(admin, {
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);

    const broken = await send({ url: '/api/v1/audit-log?cursor=not-a-cursor', ...as(admin) });
    expect(broken.statusCode).toBe(400);
  });

  it('filters by category, person, time and search', async () => {
    const team = await teamWorkspace();
    await send({
      method: 'PATCH',
      url: `/api/v1/members/${team.agent.userId}`,
      ...as(team.admin),
      payload: { role: 'supervisor' },
    });
    expect(await actions(team.admin, { category: 'members' })).toEqual(['member.role_changed']);
    expect(await actions(team.admin, { actorId: team.agent.userId })).toEqual([
      'sign_in.succeeded',
    ]);
    expect(await actions(team.admin, { q: team.agent.email.slice(0, 12) })).toEqual(
      expect.arrayContaining(['member.role_changed']),
    );
    expect(await actions(team.admin, { q: '%' })).toEqual([]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await actions(team.admin, { from: future })).toEqual([]);
    expect((await actions(team.admin, { to: future })).length).toBeGreaterThan(0);
  });

  it('exports the filtered log as CSV with spreadsheet formulas made safe', async () => {
    const admin = await owner();
    await send({
      method: 'PATCH',
      url: '/api/v1/me',
      ...as(admin),
      payload: { name: '=SUM(1+1)' },
    });
    await send({ method: 'POST', url: '/api/v1/me/sessions/sign-out-others', ...as(admin) });

    const response = await send({ url: '/api/v1/audit-log/export', ...as(admin) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="audit-log-.+\.csv"$/,
    );
    const [header, first] = response.body.split('\r\n');
    expect(header).toBe(
      'Time (Asia/Kolkata),Time (UTC),Who,Email,Role,Category,What happened,Affected,IP address,Device',
    );
    expect(first).toContain(",'=SUM(1+1),");
    expect(first).toContain('Security');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},/);

    const filtered = await send({ url: '/api/v1/audit-log/export?category=members', ...as(admin) });
    expect(filtered.body.trim().split('\r\n')).toHaveLength(1);
  });
});

describe('the audit log cannot be changed', () => {
  it('lets the app add and read entries, but never edit or delete them', async () => {
    const admin = await owner();
    const [row] = await query<{ workspace_id: string }>(
      'SELECT workspace_id FROM audit_events WHERE actor_email = :email LIMIT 1',
      { email: admin.email },
    );
    const workspaceId = row?.workspace_id ?? '';
    const db = testDatabase();
    try {
      const read = await withWorkspace(db.writer, workspaceId, (transaction) =>
        db.writer.query('SELECT count(*) AS n FROM audit_events', { transaction }),
      );
      expect(Number((read[0] as { n: string }[])[0]?.n)).toBeGreaterThan(0);
      for (const sql of [
        "UPDATE audit_events SET actor_name = 'Someone else'",
        'DELETE FROM audit_events',
        'TRUNCATE audit_events',
      ]) {
        await expect(
          withWorkspace(db.writer, workspaceId, (transaction) =>
            db.writer.query(sql, { transaction }),
          ),
        ).rejects.toThrow(/permission denied/);
      }
    } finally {
      await db.close();
    }
  });
});
