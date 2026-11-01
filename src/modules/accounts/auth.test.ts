import { describe, expect, it } from 'vitest';
import { accountsKit, host, PASSWORD, ROOT, tokenFrom } from '../../test/accounts.js';
import { LAGGING_READER, testDatabase } from '../../test/helpers.js';
import { expectReadAfterWrite } from '../../test/read-after-write.js';
import { PRODUCT_NAME } from '../../product.js';

const kit = accountsKit();
const { send, signedUpWorkspace, query } = kit;

const NEW_PASSWORD = 'quiet-harbour-lantern-41';

function login(address: string, email: string, password: string, cookie?: string) {
  return send({
    method: 'POST',
    url: '/api/v1/auth/login',
    on: address,
    payload: { email, password },
    ...(cookie ? { cookie } : {}),
  });
}

function sessionCookie(response: Awaited<ReturnType<typeof send>>): string {
  const cookie = response.cookies.find((c) => c.name === 'helpdesk_session');
  if (!cookie?.value) throw new Error('no session cookie');
  return `helpdesk_session=${cookie.value}`;
}

const me = (address: string, cookie: string) => send({ url: '/api/v1/me', on: address, cookie });

async function signedIn() {
  const workspace = await signedUpWorkspace();
  return { ...workspace, email: workspace.body.email };
}

async function resetLink(address: string, email: string) {
  const response = await send({
    method: 'POST',
    url: '/api/v1/auth/forgot-password',
    on: address,
    payload: { email },
  });
  expect(response.statusCode).toBe(202);
  return tokenFrom(kit.emails.lastTo(email)?.text);
}

const userId = async (email: string) =>
  (await query<{ id: string }>('SELECT id FROM users WHERE email = :email', { email }))[0]?.id;

describe('login', () => {
  it('signs a member in with a new session and returns who they are with a CSRF token', async () => {
    const owner = await signedIn();
    const response = await login(owner.address, owner.email, PASSWORD);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { email: owner.email },
      workspace: { subdomain: owner.body.workspaceAddress },
      role: 'admin',
      isOwner: true,
      csrfToken: expect.any(String) as unknown,
    });
    const cookie = response.cookies.find((c) => c.name === 'helpdesk_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(cookie?.domain).toBeUndefined();
    expect((await me(owner.address, sessionCookie(response))).statusCode).toBe(200);
  });

  it('accepts the email in any letter case', async () => {
    const owner = await signedIn();
    const response = await login(owner.address, owner.email.toUpperCase(), PASSWORD);
    expect(response.statusCode).toBe(200);
  });

  it('replaces the session the browser already had (the session ID changes on login)', async () => {
    const owner = await signedIn();
    const response = await login(owner.address, owner.email, PASSWORD, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(sessionCookie(response)).not.toBe(owner.cookie);
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(401);
  });

  it('gives the same answer for a wrong password, an unknown email and a member of another workspace', async () => {
    const owner = await signedIn();
    const outsider = await signedIn();
    const answers = await Promise.all([
      login(owner.address, owner.email, 'not-the-password-at-all'),
      login(owner.address, `nobody.${owner.body.workspaceAddress}@acme.test`, PASSWORD),
      login(owner.address, outsider.email, PASSWORD),
    ]);
    for (const answer of answers) {
      expect(answer.statusCode).toBe(401);
      expect(answer.json()).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
      });
      expect(answer.cookies).toHaveLength(0);
    }
  });

  it('only works on a workspace address that exists', async () => {
    const owner = await signedIn();
    expect((await login(ROOT, owner.email, PASSWORD)).statusCode).toBe(404);
    expect((await login(host('no-such-workspace'), owner.email, PASSWORD)).statusCode).toBe(404);
  });

  it('returns the member even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedIn();
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { host: owner.address },
        payload: { email: owner.email, password: PASSWORD },
      },
      [owner.email],
    );
  });

  it('is limited to 20 attempts per 15 minutes from one network address', async () => {
    const owner = await signedIn();
    const attempt = (n: number) =>
      send({
        method: 'POST',
        url: '/api/v1/auth/login',
        on: owner.address,
        remoteAddress: '10.250.250.7',
        payload: { email: `guess.${String(n)}@acme.test`, password: 'wrong-password' },
      });
    for (let n = 0; n < 20; n += 1) expect((await attempt(n)).statusCode).toBe(401);
    const blocked = await attempt(20);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
  });
});

describe('login lockout', () => {
  it('locks an email for 15 minutes after 5 failed attempts, even with the right password', async () => {
    const owner = await signedIn();
    for (let n = 1; n <= 4; n += 1) {
      expect((await login(owner.address, owner.email, 'wrong-password')).statusCode).toBe(401);
    }
    const fifth = await login(owner.address, owner.email, 'wrong-password');
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({
      error: {
        code: 'LOGIN_LOCKED',
        message: 'Too many attempts. Try again in 15 minutes, or reset your password.',
      },
    });

    const right = await login(owner.address, owner.email, PASSWORD);
    expect(right.statusCode).toBe(429);
    expect(
      right.json<{ error: { details: { retryAfterSeconds: number } } }>().error.details,
    ).toMatchObject({ retryAfterSeconds: expect.any(Number) as unknown });
  });

  it('locks an email with no account the same way, so the lock reveals nothing', async () => {
    const owner = await signedIn();
    const unknown = `ghost.${owner.body.workspaceAddress}@acme.test`;
    for (let n = 1; n <= 4; n += 1) await login(owner.address, unknown, 'wrong-password');
    const fifth = await login(owner.address, unknown, 'wrong-password');
    expect(fifth.json<{ error: { code: string } }>().error.code).toBe('LOGIN_LOCKED');
  });

  it('unlocks after 15 minutes, and a successful login clears the count', async () => {
    const owner = await signedIn();
    for (let n = 1; n <= 5; n += 1) await login(owner.address, owner.email, 'wrong-password');
    await query(
      "UPDATE login_failures SET created_at = created_at - interval '16 minutes' WHERE email = :email",
      { email: owner.email },
    );
    expect((await login(owner.address, owner.email, PASSWORD)).statusCode).toBe(200);
    const left = await query<{ count: string }>(
      'SELECT count(*) FROM login_failures WHERE email = :email',
      { email: owner.email },
    );
    expect(Number(left[0]?.count)).toBe(0);
  });

  it('does not lock for failures spread over more than 15 minutes', async () => {
    const owner = await signedIn();
    for (let n = 1; n <= 4; n += 1) await login(owner.address, owner.email, 'wrong-password');
    await query(
      "UPDATE login_failures SET created_at = created_at - interval '20 minutes' WHERE email = :email",
      { email: owner.email },
    );
    const fifth = await login(owner.address, owner.email, 'wrong-password');
    expect(fifth.statusCode).toBe(401);
  });

  it('is lifted by resetting the password', async () => {
    const owner = await signedIn();
    for (let n = 1; n <= 5; n += 1) await login(owner.address, owner.email, 'wrong-password');
    const token = await resetLink(owner.address, owner.email);
    await send({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      on: owner.address,
      payload: { token, password: NEW_PASSWORD },
    });
    expect((await login(owner.address, owner.email, NEW_PASSWORD)).statusCode).toBe(200);
  });
});

describe('session timeouts', () => {
  it('ends a session after 8 hours without activity', async () => {
    const owner = await signedIn();
    await query(
      "UPDATE sessions SET last_seen_at = now() - interval '8 hours 1 minute' WHERE user_id = :id",
      { id: await userId(owner.email) },
    );
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(401);
  });

  it('keeps an active session alive, refreshing its last activity at most every few minutes', async () => {
    const owner = await signedIn();
    const id = await userId(owner.email);
    await query(
      "UPDATE sessions SET last_seen_at = now() - interval '6 minutes' WHERE user_id = :id",
      {
        id,
      },
    );
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(200);
    const [row] = await query<{ fresh: boolean }>(
      "SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM sessions WHERE user_id = :id",
      { id },
    );
    expect(row?.fresh).toBe(true);
  });

  it('ends a session 7 days after sign-in however active it is, and the cookie expires then too', async () => {
    const owner = await signedIn();
    const expires = owner.sessionCookie.expires;
    if (!(expires instanceof Date)) throw new Error('the session cookie has no expiry');
    const days = (expires.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });
});

describe('CSRF protection', () => {
  it('refuses a change without the CSRF token, or with a wrong one', async () => {
    const owner = await signedIn();
    const patch = (csrf?: string) =>
      send({
        method: 'PATCH',
        url: '/api/v1/me',
        on: owner.address,
        cookie: owner.cookie,
        payload: { name: 'Ravi S' },
        ...(csrf ? { csrf } : {}),
      });
    for (const response of [await patch(), await patch('made-up-token')]) {
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('CSRF_FAILED');
    }
    expect((await patch(owner.csrf)).statusCode).toBe(200);
  });

  it("does not accept one session's token with another session's cookie", async () => {
    const owner = await signedIn();
    const second = await login(owner.address, owner.email, PASSWORD);
    const response = await send({
      method: 'PATCH',
      url: '/api/v1/me',
      on: owner.address,
      cookie: sessionCookie(second),
      csrf: owner.csrf,
      payload: { name: 'Ravi S' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('your colour theme (Step 5b)', () => {
  it('is kept per person, follows them to a new session, and goes back to the default', async () => {
    const owner = await signedIn();
    const update = (payload: Record<string, unknown>) =>
      send({
        method: 'PATCH',
        url: '/api/v1/me',
        on: owner.address,
        cookie: owner.cookie,
        csrf: owner.csrf,
        payload,
      });
    expect(
      (await me(owner.address, owner.cookie)).json<{ user: { theme: unknown } }>().user.theme,
    ).toBeNull();

    const chosen = await update({ theme: 'indigo' });
    expect(chosen.statusCode).toBe(200);
    // Only the theme changes; the name stays.
    expect(chosen.json<{ user: { theme: string; name: string } }>().user).toMatchObject({
      theme: 'indigo',
      name: 'Ravi Shankar',
    });
    // Another sign-in (another device) gets it too.
    const second = await login(owner.address, owner.email, PASSWORD);
    expect(second.json<{ user: { theme: string } }>().user.theme).toBe('indigo');

    expect((await update({ theme: 'purple' })).statusCode).toBe(400);
    expect((await update({})).statusCode).toBe(400);
    const reset = await update({ theme: null });
    expect(reset.json<{ user: { theme: unknown } }>().user.theme).toBeNull();
  });
});

describe('sign-out', () => {
  it('ends the session on the server and clears the cookie', async () => {
    const owner = await signedIn();
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/logout',
      on: owner.address,
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((c) => c.name === 'helpdesk_session');
    expect(cleared?.value).toBe('');
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(401);
  });

  it('needs the CSRF token while the session is live, so another site cannot sign people out', async () => {
    const owner = await signedIn();
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/logout',
      on: owner.address,
      cookie: owner.cookie,
    });
    expect(response.statusCode).toBe(403);
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(200);
  });

  it('just clears the cookie when the session has already ended', async () => {
    const owner = await signedIn();
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/logout',
      on: owner.address,
      cookie: 'helpdesk_session=already-gone',
    });
    expect(response.statusCode).toBe(204);
  });
});

describe('forgot password', () => {
  it('emails a one-hour link to this workspace address', async () => {
    const owner = await signedIn();
    await resetLink(owner.address, owner.email);
    const message = kit.emails.lastTo(owner.email);
    expect(message?.subject).toBe(`Reset your ${PRODUCT_NAME} password`);
    expect(message?.text).toContain(`http://${owner.address}/reset-password?token=`);
    expect(message?.text).toContain('expires in 1 hour');
  });

  it('answers the same way for an unknown email or a member of another workspace, sending nothing', async () => {
    const owner = await signedIn();
    const outsider = await signedIn();
    const before = kit.emails.sent.length;
    for (const email of [`nobody.${owner.body.workspaceAddress}@acme.test`, outsider.email]) {
      const response = await send({
        method: 'POST',
        url: '/api/v1/auth/forgot-password',
        on: owner.address,
        payload: { email },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ email });
    }
    expect(kit.emails.sent.length).toBe(before);
  });

  it('sends at most 3 links an hour to one person, and only the latest link works', async () => {
    const owner = await signedIn();
    const first = await resetLink(owner.address, owner.email);
    await resetLink(owner.address, owner.email);
    const third = await resetLink(owner.address, owner.email);
    const before = kit.emails.sent.length;
    await send({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      on: owner.address,
      payload: { email: owner.email },
    });
    expect(kit.emails.sent.length).toBe(before);

    const check = (token: string) =>
      send({
        method: 'POST',
        url: '/api/v1/auth/reset-password/check',
        on: owner.address,
        payload: { token },
      });
    expect((await check(first)).json()).toMatchObject({
      error: { details: { reason: 'expired' } },
    });
    expect((await check(third)).json()).toEqual({ email: owner.email });
  });
});

describe('reset password', () => {
  const reset = (address: string, token: string, password = NEW_PASSWORD) =>
    send({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      on: address,
      payload: { token, password },
    });

  it('sets the new password, signs the person out everywhere and emails a notice', async () => {
    const owner = await signedIn();
    const token = await resetLink(owner.address, owner.email);

    expect((await reset(owner.address, token)).statusCode).toBe(204);
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(401);
    expect((await login(owner.address, owner.email, PASSWORD)).statusCode).toBe(401);
    expect((await login(owner.address, owner.email, NEW_PASSWORD)).statusCode).toBe(200);

    const notice = kit.emails.lastTo(owner.email);
    expect(notice?.subject).toBe(`Your ${PRODUCT_NAME} password was changed`);
    expect(notice?.text).toContain(`http://${owner.address}/forgot-password`);
  });

  it('works once', async () => {
    const owner = await signedIn();
    const token = await resetLink(owner.address, owner.email);
    await reset(owner.address, token);
    const again = await reset(owner.address, token, 'another-fresh-password-77');
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { details: { reason: 'used' } } });
  });

  it('expires after an hour', async () => {
    const owner = await signedIn();
    const token = await resetLink(owner.address, owner.email);
    await query(
      "UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE user_id = :id",
      { id: await userId(owner.email) },
    );
    const response = await reset(owner.address, token);
    expect(response.json()).toMatchObject({ error: { details: { reason: 'expired' } } });
  });

  it('only works on its own workspace address, and not with a made-up token', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const token = await resetLink(owner.address, owner.email);
    for (const [address, value] of [
      [other.address, token],
      [owner.address, 'x'.repeat(43)],
    ] as const) {
      const response = await send({
        method: 'POST',
        url: '/api/v1/auth/reset-password/check',
        on: address,
        payload: { token: value },
      });
      expect(response.json()).toMatchObject({ error: { details: { reason: 'invalid' } } });
    }
  });

  it('refuses breached passwords and the last 5 passwords', async () => {
    const owner = await signedIn();
    const token = await resetLink(owner.address, owner.email);

    const current = await reset(owner.address, token, PASSWORD);
    expect(current.statusCode).toBe(400);
    expect(current.json()).toMatchObject({
      error: {
        details: {
          fields: [
            {
              field: 'password',
              message: 'You used this password recently. Choose a different one.',
            },
          ],
        },
      },
    });

    kit.breached = true;
    const breached = await reset(owner.address, token);
    expect(breached.json()).toMatchObject({
      error: { details: { fields: [{ field: 'password' }] } },
    });
  });
});

describe('change password', () => {
  const change = (
    owner: { address: string; cookie: string; csrf: string },
    currentPassword: string,
    newPassword: string,
  ) =>
    send({
      method: 'POST',
      url: '/api/v1/me/password',
      on: owner.address,
      cookie: owner.cookie,
      csrf: owner.csrf,
      payload: { currentPassword, newPassword },
    });

  it('checks the current password', async () => {
    const owner = await signedIn();
    const response = await change(owner, 'not-my-password', NEW_PASSWORD);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { fields: [{ field: 'currentPassword' }] } },
    });
  });

  it('signs out every other session, keeps this browser signed in with a fresh session, and emails a notice', async () => {
    const owner = await signedIn();
    const elsewhere = sessionCookie(await login(owner.address, owner.email, PASSWORD));

    const response = await change(owner, PASSWORD, NEW_PASSWORD);
    expect(response.statusCode).toBe(200);
    const fresh = sessionCookie(response);
    expect(response.json<{ csrfToken: string }>().csrfToken).not.toBe(owner.csrf);

    expect((await me(owner.address, owner.cookie)).statusCode).toBe(401);
    expect((await me(owner.address, elsewhere)).statusCode).toBe(401);
    expect((await me(owner.address, fresh)).statusCode).toBe(200);
    expect(kit.emails.lastTo(owner.email)?.subject).toBe(
      `Your ${PRODUCT_NAME} password was changed`,
    );
  });

  it('refuses any of the last 5 passwords, and allows an older one again', async () => {
    let owner = await signedIn();
    const passwords = [1, 2, 3, 4, 5].map((n) => `rotating-password-${String(n)}-zz`);
    let current = PASSWORD;
    for (const next of passwords) {
      const response = await change(owner, current, next);
      expect(response.statusCode).toBe(200);
      owner = {
        ...owner,
        cookie: sessionCookie(response),
        csrf: response.json<{ csrfToken: string }>().csrfToken,
      };
      current = next;
    }
    // Current is #5; #1 to #4 are the history. The sign-up password has dropped out.
    const recent = await change(owner, current, passwords[0] ?? '');
    expect(recent.json()).toMatchObject({
      error: { details: { fields: [{ field: 'newPassword' }] } },
    });
    expect((await change(owner, current, PASSWORD)).statusCode).toBe(200);
  }, 30_000);

  it('keeps this browser signed in even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedIn();
    await expectReadAfterWrite(
      kit.app,
      {
        method: 'POST',
        url: '/api/v1/me/password',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      },
      [owner.email],
    );
  });
});

describe('your account', () => {
  it('updates your name and returns it at once (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const owner = await signedIn();
    const response = await expectReadAfterWrite(
      kit.app,
      {
        method: 'PATCH',
        url: '/api/v1/me',
        headers: { host: owner.address, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        payload: { name: 'Ravi S. Kumar' },
      },
      ['Ravi S. Kumar'],
    );
    expect(response.statusCode).toBe(200);
    expect((await me(owner.address, owner.cookie)).json()).toMatchObject({
      user: { name: 'Ravi S. Kumar' },
    });
  });

  it('signs out every other device and keeps this one', async () => {
    const owner = await signedIn();
    const phone = sessionCookie(await login(owner.address, owner.email, PASSWORD));
    const laptop = sessionCookie(await login(owner.address, owner.email, PASSWORD));

    const response = await send({
      method: 'POST',
      url: '/api/v1/me/sessions/sign-out-others',
      on: owner.address,
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(response.json()).toEqual({ signedOut: 2 });
    expect((await me(owner.address, phone)).statusCode).toBe(401);
    expect((await me(owner.address, laptop)).statusCode).toBe(401);
    expect((await me(owner.address, owner.cookie)).statusCode).toBe(200);
  });
});

describe('find your workspace', () => {
  /** Adds an existing person to another workspace as an agent (invites arrive with F4). */
  async function addMember(email: string, workspaceAddress: string) {
    await query(
      `INSERT INTO memberships (id, workspace_id, user_id, role, is_owner, created_at, updated_at)
       SELECT gen_random_uuid(), w.id, u.id, 'agent', false, now(), now()
       FROM workspaces w, users u WHERE w.subdomain = :address AND u.email = :email`,
      { address: workspaceAddress, email },
    );
  }

  it('emails links to every workspace the person can sign in to', async () => {
    const person = await signedUpWorkspace({ companyName: 'Alpha Desk' });
    const other = await signedUpWorkspace({ companyName: 'Beta Desk' });
    await addMember(person.body.email, other.body.workspaceAddress);

    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/find-workspaces',
      payload: { email: person.body.email },
    });
    expect(response.statusCode).toBe(202);
    const message = kit.emails.lastTo(person.body.email);
    expect(message?.subject).toBe(`Your ${PRODUCT_NAME} workspaces`);
    expect(message?.text).toContain(`Alpha Desk: http://${person.address}/login`);
    expect(message?.text).toContain(`Beta Desk: http://${other.address}/login`);

    // One login for every workspace: the same password works on the second one, as an agent.
    const second = await login(other.address, person.body.email, PASSWORD);
    expect(second.json()).toMatchObject({ role: 'agent', isOwner: false });
  });

  it('answers the same way for an unknown email, sending nothing', async () => {
    const before = kit.emails.sent.length;
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/find-workspaces',
      payload: { email: 'nobody.anywhere@acme.test' },
    });
    expect(response.statusCode).toBe(202);
    expect(kit.emails.sent.length).toBe(before);
  });

  it('only works on the main address', async () => {
    const owner = await signedIn();
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/find-workspaces',
      on: owner.address,
      payload: { email: owner.email },
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets a person see only their own memberships across workspaces, never anyone else's (RLS)", async () => {
    const person = await signedIn();
    const other = await signedIn();
    const [personId, otherId] = await Promise.all([userId(person.email), userId(other.email)]);
    const db = testDatabase();
    try {
      const rows = await db.writer.transaction(async (transaction) => {
        await db.writer.query("SELECT set_config('app.user_id', :id, true)", {
          replacements: { id: personId },
          transaction,
        });
        const [found] = await db.writer.query('SELECT user_id FROM memberships', { transaction });
        return found as { user_id: string }[];
      });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.user_id === personId)).toBe(true);
      expect(rows.some((row) => row.user_id === otherId)).toBe(false);

      const [none] = await db.writer.query('SELECT user_id FROM memberships');
      expect(none).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
