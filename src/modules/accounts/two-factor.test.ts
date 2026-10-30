import { Secret, TOTP } from 'otpauth';
import { describe, expect, it } from 'vitest';
import { accountsKit, host, PASSWORD } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { PRODUCT_NAME } from '../../product.js';

const kit = accountsKit();
const { send, signedUpWorkspace, query } = kit;

type Owner = Awaited<ReturnType<typeof signedUpWorkspace>>;
type Response = Awaited<ReturnType<typeof send>>;

/** The code an authenticator app would show, `stepsAhead` 30-second steps from now. */
function codeAt(secret: string, stepsAhead = 0): string {
  const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
  return totp.generate({ timestamp: Date.now() + stepsAhead * 30_000 });
}

function cookieFrom(response: Response, name: string): string {
  const cookie = response.cookies.find((c) => c.name === name);
  if (!cookie?.value) throw new Error(`no ${name} cookie`);
  return `${name}=${cookie.value}`;
}

const asMember = (owner: Owner, cookie = owner.cookie, csrf = owner.csrf) => ({
  on: owner.address,
  cookie,
  csrf,
});

async function setUp(owner: Owner) {
  const setup = await send({
    method: 'POST',
    url: '/api/v1/me/two-factor/setup',
    ...asMember(owner),
    payload: { password: PASSWORD },
  });
  expect(setup.statusCode).toBe(200);
  return setup.json<{ secret: string; otpauthUri: string; qrSvg: string }>();
}

/** Turns two-step verification on for the owner; returns the secret and recovery codes. */
async function enable(owner: Owner) {
  const { secret } = await setUp(owner);
  const confirm = await send({
    method: 'POST',
    url: '/api/v1/me/two-factor/confirm',
    ...asMember(owner),
    payload: { code: codeAt(secret) },
  });
  expect(confirm.statusCode).toBe(200);
  return { secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
}

/** Lets the next code be the current one again (each time step works once). */
const allowCodeReuse = (email: string) =>
  query(
    'UPDATE user_two_factor SET last_used_step = NULL WHERE user_id = (SELECT id FROM users WHERE email = :email)',
    { email },
  );

const passwordStep = (owner: Owner, cookie?: string) =>
  send({
    method: 'POST',
    url: '/api/v1/auth/login',
    on: owner.address,
    payload: { email: owner.body.email, password: PASSWORD },
    ...(cookie ? { cookie } : {}),
  });

const codeStep = (address: string, challenge: string, code: string, trustDevice = false) =>
  send({
    method: 'POST',
    url: '/api/v1/auth/login/two-factor',
    on: address,
    cookie: challenge,
    payload: { code, trustDevice },
  });

const me = (owner: Owner, cookie: string) => send({ url: '/api/v1/me', on: owner.address, cookie });

/** Adds an existing person to a workspace (invites arrive with F4). */
async function addMember(email: string, workspaceAddress: string, role = 'agent') {
  await query(
    `INSERT INTO memberships (id, workspace_id, user_id, role, is_owner, created_at, updated_at)
     SELECT gen_random_uuid(), w.id, u.id, :role, false, now(), now()
     FROM workspaces w, users u WHERE w.subdomain = :address AND u.email = :email`,
    { address: workspaceAddress, email, role },
  );
}

describe('turning two-step verification on', () => {
  it('needs the password, then gives a setup key and QR code for the app', async () => {
    const owner = await signedUpWorkspace();
    const wrong = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...asMember(owner),
      payload: { password: 'not-my-password' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: { details: { fields: [{ field: 'password' }] } } });

    const setup = await setUp(owner);
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`otpauth://totp/${encodeURIComponent(PRODUCT_NAME)}:`);
    expect(setup.otpauthUri).toContain(encodeURIComponent(owner.body.email));
    expect(setup.qrSvg.startsWith('<svg')).toBe(true);
    expect((await me(owner, owner.cookie)).json()).toMatchObject({
      twoFactor: { enabled: false },
    });
  });

  it('turns on with the first code: 10 recovery codes, other devices signed out, a notice email', async () => {
    const owner = await signedUpWorkspace();
    const elsewhere = cookieFrom(await passwordStep(owner), 'helpdesk_session');
    const { secret, recoveryCodes } = await enable(owner);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect((await me(owner, owner.cookie)).json()).toMatchObject({
      twoFactor: { enabled: true, recoveryCodesLeft: 10, required: false, setupRequired: false },
    });
    expect((await me(owner, elsewhere)).statusCode).toBe(401);
    expect(kit.emails.lastTo(owner.body.email)?.subject).toBe(
      `Two-step verification is on for your ${PRODUCT_NAME} account`,
    );

    // The secret is stored encrypted, and the recovery codes only as hashes.
    const [row] = await query<{ secret_encrypted: string; key_id: string }>(
      'SELECT secret_encrypted, key_id FROM user_two_factor t JOIN users u ON u.id = t.user_id WHERE u.email = :email',
      { email: owner.body.email },
    );
    expect(row?.secret_encrypted).not.toContain(secret);
    expect(row?.key_id).toMatch(/^[0-9a-f]{8}$/);
    const stored = await query<{ code_hash: string }>(
      'SELECT code_hash FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE u.email = :email',
      { email: owner.body.email },
    );
    expect(stored.map((r) => r.code_hash)).not.toContain(recoveryCodes[0]);
  });

  it('refuses a wrong first code and stays off', async () => {
    const owner = await signedUpWorkspace();
    await setUp(owner);
    const response = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/confirm',
      ...asMember(owner),
      payload: { code: '000000' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { details: { fields: [{ field: 'code' }] } } });
    expect((await me(owner, owner.cookie)).json()).toMatchObject({
      twoFactor: { enabled: false },
    });
  });

  it('says so when it is already on, and needs the CSRF token like every change', async () => {
    const owner = await signedUpWorkspace();
    await enable(owner);
    const again = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      ...asMember(owner),
      payload: { password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
    const noToken = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/setup',
      on: owner.address,
      cookie: owner.cookie,
      payload: { password: PASSWORD },
    });
    expect(noToken.statusCode).toBe(403);
  });

  it('returns the recovery codes even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedUpWorkspace();
    const { secret } = await setUp(owner);
    const response = await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/me/two-factor/confirm',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { code: codeAt(secret) },
      },
      ['recoveryCodes'],
    );
    expect(response.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
  });
});

describe('signing in with two-step verification', () => {
  it('asks for a code after the password, with no session until the code is right', async () => {
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);

    const first = await passwordStep(owner);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ twoFactorRequired: true });
    expect(first.cookies.find((c) => c.name === 'helpdesk_session')).toBeUndefined();
    const challengeCookie = first.cookies.find((c) => c.name === 'helpdesk_2fa');
    expect(challengeCookie).toMatchObject({
      httpOnly: true,
      path: '/api/v1/auth',
      sameSite: 'Strict',
    });

    const second = await codeStep(
      owner.address,
      cookieFrom(first, 'helpdesk_2fa'),
      codeAt(secret, 1),
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ user: { email: owner.body.email } });
    expect((await me(owner, cookieFrom(second, 'helpdesk_session'))).statusCode).toBe(200);
  });

  it('accepts each code once', async () => {
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const code = codeAt(secret, 1);
    const used = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      code,
    );
    expect(used.statusCode).toBe(200);

    const replay = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      code,
    );
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('INVALID_CODE');
  });

  it('counts wrong codes toward the login lock', async () => {
    const owner = await signedUpWorkspace();
    await enable(owner);
    const challenge = cookieFrom(await passwordStep(owner), 'helpdesk_2fa');
    for (let n = 1; n <= 4; n += 1) {
      const wrong = await codeStep(owner.address, challenge, '123456');
      expect(wrong.json<{ error: { code: string } }>().error.code).toBe('INVALID_CODE');
    }
    const fifth = await codeStep(owner.address, challenge, '123456');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json<{ error: { code: string } }>().error.code).toBe('LOGIN_LOCKED');
    expect((await passwordStep(owner)).statusCode).toBe(429);
  });

  it('sends the person back to the password when the challenge is missing, expired or for another workspace', async () => {
    const owner = await signedUpWorkspace();
    const other = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const expectStartAgain = (response: Response) => {
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('TWO_FACTOR_EXPIRED');
    };

    expectStartAgain(await codeStep(owner.address, 'helpdesk_2fa=made-up', codeAt(secret, 1)));
    const challenge = cookieFrom(await passwordStep(owner), 'helpdesk_2fa');
    expectStartAgain(await codeStep(other.address, challenge, codeAt(secret, 1)));
    await query(
      "UPDATE login_challenges SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE email = :email)",
      { email: owner.body.email },
    );
    expectStartAgain(await codeStep(owner.address, challenge, codeAt(secret, 1)));
  });

  it('accepts a recovery code once, and emails how many are left', async () => {
    const owner = await signedUpWorkspace();
    const { recoveryCodes } = await enable(owner);
    const code = recoveryCodes[3] ?? '';

    const used = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      code.toUpperCase().replace('-', ' '),
    );
    expect(used.statusCode).toBe(200);
    expect(used.json()).toMatchObject({ twoFactor: { recoveryCodesLeft: 9 } });
    const notice = kit.emails.lastTo(owner.body.email);
    expect(notice?.subject).toBe(`A recovery code was used to sign in to ${PRODUCT_NAME}`);
    expect(notice?.text).toContain('You have 9 recovery codes left.');

    const again = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      code,
    );
    expect(again.statusCode).toBe(401);
  });

  it('skips the code on a trusted device for 30 days, until the password changes', async () => {
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const trusted = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      codeAt(secret, 1),
      true,
    );
    const device = trusted.cookies.find((c) => c.name === 'helpdesk_trusted');
    expect(device).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    if (!(device?.expires instanceof Date))
      throw new Error('the trusted-device cookie has no expiry');
    const days = (device.expires.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    const deviceCookie = cookieFrom(trusted, 'helpdesk_trusted');

    expect((await passwordStep(owner, deviceCookie)).statusCode).toBe(200);

    const session = cookieFrom(trusted, 'helpdesk_session');
    const csrf = trusted.json<{ csrfToken: string }>().csrfToken;
    await send({
      method: 'POST',
      url: '/api/v1/me/password',
      on: owner.address,
      cookie: session,
      csrf,
      payload: { currentPassword: PASSWORD, newPassword: 'quiet-harbour-lantern-41' },
    });
    const afterChange = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: owner.address,
      cookie: deviceCookie,
      payload: { email: owner.body.email, password: 'quiet-harbour-lantern-41' },
    });
    expect(afterChange.statusCode).toBe(202);
  });

  it('forgets trusted devices on "sign out of all other devices"', async () => {
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const trusted = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      codeAt(secret, 1),
      true,
    );
    await send({
      method: 'POST',
      url: '/api/v1/me/sessions/sign-out-others',
      ...asMember(owner),
    });
    expect((await passwordStep(owner, cookieFrom(trusted, 'helpdesk_trusted'))).statusCode).toBe(
      202,
    );
  });

  it('returns the member even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const challenge = cookieFrom(await passwordStep(owner), 'helpdesk_2fa');
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/auth/login/two-factor',
        headers: { host: owner.address, cookie: challenge },
        payload: { code: codeAt(secret, 1) },
      },
      [owner.body.email],
    );
  });
});

describe('recovery codes and turning off', () => {
  it('creates new recovery codes with the password; the old ones stop working', async () => {
    const owner = await signedUpWorkspace();
    const { recoveryCodes: old } = await enable(owner);
    const wrong = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/recovery-codes',
      ...asMember(owner),
      payload: { password: 'not-my-password' },
    });
    expect(wrong.statusCode).toBe(400);

    const fresh = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/recovery-codes',
      ...asMember(owner),
      payload: { password: PASSWORD },
    });
    expect(fresh.json<{ recoveryCodes: string[] }>().recoveryCodes).toHaveLength(10);
    expect(kit.emails.lastTo(owner.body.email)?.subject).toBe(
      `New ${PRODUCT_NAME} recovery codes were created`,
    );
    const withOld = await codeStep(
      owner.address,
      cookieFrom(await passwordStep(owner), 'helpdesk_2fa'),
      old[0] ?? '',
    );
    expect(withOld.statusCode).toBe(401);
  });

  it('turns off with the password and a code, and sign-in needs only the password again', async () => {
    const owner = await signedUpWorkspace();
    const { secret } = await enable(owner);
    const disable = (code: string) =>
      send({
        method: 'POST',
        url: '/api/v1/me/two-factor/disable',
        ...asMember(owner),
        payload: { password: PASSWORD, code },
      });

    expect((await disable('000000')).statusCode).toBe(400);
    expect((await disable(codeAt(secret, 1))).statusCode).toBe(204);
    expect(kit.emails.lastTo(owner.body.email)?.subject).toBe(
      'Two-step verification was turned off',
    );
    expect((await passwordStep(owner)).statusCode).toBe(200);
    expect((await me(owner, owner.cookie)).json()).toMatchObject({
      twoFactor: { enabled: false, recoveryCodesLeft: 0 },
    });
  });

  it('accepts a recovery code to turn off', async () => {
    const owner = await signedUpWorkspace();
    const { recoveryCodes } = await enable(owner);
    const response = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/disable',
      ...asMember(owner),
      payload: { password: PASSWORD, code: recoveryCodes[0] ?? '' },
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('requiring two-step verification for a workspace', () => {
  const security = (
    owner: Owner,
    requireTwoFactor?: boolean,
    cookie = owner.cookie,
    csrf = owner.csrf,
  ) =>
    send({
      method: requireTwoFactor === undefined ? 'GET' : 'PATCH',
      url: '/api/v1/workspace/security',
      ...asMember(owner, cookie, csrf),
      ...(requireTwoFactor === undefined ? {} : { payload: { requireTwoFactor } }),
    });

  it('needs the admin to have it on first', async () => {
    const owner = await signedUpWorkspace();
    const refused = await security(owner, true);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { message: string } }>().error.message).toBe(
      'Turn on two-step verification for yourself first.',
    );

    await enable(owner);
    const on = await security(owner, true);
    expect(on.json()).toEqual({ requireTwoFactor: true, members: 1, membersWithTwoFactor: 1 });
    expect((await security(owner)).json()).toMatchObject({ requireTwoFactor: true });
  });

  it('is for admins only', async () => {
    const owner = await signedUpWorkspace();
    const agent = await signedUpWorkspace();
    await addMember(agent.body.email, owner.body.workspaceAddress);
    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: owner.address,
      payload: { email: agent.body.email, password: PASSWORD },
    });
    const cookie = cookieFrom(login, 'helpdesk_session');
    const csrf = login.json<{ csrfToken: string }>().csrfToken;

    expect((await security(owner, undefined, cookie, csrf)).statusCode).toBe(403);
    expect((await security(owner, false, cookie, csrf)).statusCode).toBe(403);
  });

  it("never shows or changes another workspace's settings (tenant isolation)", async () => {
    const owner = await signedUpWorkspace();
    const intruder = await signedUpWorkspace();
    await enable(intruder);
    const read = await send({
      url: '/api/v1/workspace/security',
      on: owner.address,
      cookie: intruder.cookie,
    });
    expect(read.statusCode).toBe(401);
    const change = await send({
      method: 'PATCH',
      url: '/api/v1/workspace/security',
      on: owner.address,
      cookie: intruder.cookie,
      csrf: intruder.csrf,
      payload: { requireTwoFactor: true },
    });
    expect(change.statusCode).toBe(401);
  });

  it('allows a member without it only to set it up, then everything again', async () => {
    const owner = await signedUpWorkspace();
    const member = await signedUpWorkspace();
    await addMember(member.body.email, owner.body.workspaceAddress);
    await enable(owner);
    await security(owner, true);

    const login = await send({
      method: 'POST',
      url: '/api/v1/auth/login',
      on: owner.address,
      payload: { email: member.body.email, password: PASSWORD },
    });
    const asNewMember = {
      ...owner,
      cookie: cookieFrom(login, 'helpdesk_session'),
      csrf: login.json<{ csrfToken: string }>().csrfToken,
    };
    expect((await me(owner, asNewMember.cookie)).json()).toMatchObject({
      twoFactor: { enabled: false, required: true, setupRequired: true },
    });
    const blocked = await send({
      method: 'PATCH',
      url: '/api/v1/me',
      ...asMember(asNewMember, asNewMember.cookie, asNewMember.csrf),
      payload: { name: 'New Name' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe(
      'TWO_FACTOR_SETUP_REQUIRED',
    );

    await enable(asNewMember);
    const allowed = await send({
      method: 'PATCH',
      url: '/api/v1/me',
      ...asMember(asNewMember, asNewMember.cookie, asNewMember.csrf),
      payload: { name: 'New Name' },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('stops a member turning it off while a workspace they belong to requires it', async () => {
    const owner = await signedUpWorkspace({ companyName: 'Strict Desk' });
    const { secret } = await enable(owner);
    await security(owner, true);
    await allowCodeReuse(owner.body.email);
    const response = await send({
      method: 'POST',
      url: '/api/v1/me/two-factor/disable',
      ...asMember(owner),
      payload: { password: PASSWORD, code: codeAt(secret) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'TWO_FACTOR_REQUIRED', details: { workspaces: ['Strict Desk'] } },
    });
  });

  it('returns the new setting even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedUpWorkspace();
    await enable(owner);
    const response = await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/workspace/security',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { requireTwoFactor: true },
      },
      ['"requireTwoFactor":true'],
    );
    expect(response.statusCode).toBe(200);
  });
});

describe('the workspace address', () => {
  it('rejects the code step on an address that is not a workspace', async () => {
    const response = await codeStep(host('no-such-workspace'), 'helpdesk_2fa=x', '123456');
    expect(response.statusCode).toBe(404);
  });
});
