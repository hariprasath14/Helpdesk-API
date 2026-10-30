import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountsKit, host, ROOT, tokenFrom } from '../../test/accounts.js';
import { LAGGING_READER } from '../../test/helpers.js';
import { PRODUCT_NAME } from '../../product.js';

const kit = accountsKit();
const { send, newSignUp, signUp, signedUpWorkspace, query } = kit;

describe('workspace address check', () => {
  it('says a free address is available', async () => {
    const address = `free-${randomUUID().slice(0, 8)}`;
    const response = await send({ url: `/api/v1/signup/address-availability?address=${address}` });
    expect(response.json()).toEqual({ address, available: true, alternatives: [] });
  });

  it('explains bad formats and reserved names, offering alternatives for reserved ones', async () => {
    const bad = await send({ url: '/api/v1/signup/address-availability?address=-ac' });
    expect(bad.json()).toMatchObject({ available: false, reason: 'format' });

    const reserved = await send({ url: '/api/v1/signup/address-availability?address=support' });
    expect(reserved.json()).toMatchObject({ available: false, reason: 'reserved' });
    expect(reserved.json<{ alternatives: string[] }>().alternatives.length).toBeGreaterThan(0);
  });

  it('reports a taken address with free alternatives only', async () => {
    const first = newSignUp();
    await signUp(first);
    await signUp(newSignUp({ workspaceAddress: `${first.workspaceAddress}-support` }));

    const response = await send({
      url: `/api/v1/signup/address-availability?address=${first.workspaceAddress}`,
    });
    const result = response.json<{ available: boolean; reason: string; alternatives: string[] }>();
    expect(result).toMatchObject({ available: false, reason: 'taken' });
    expect(result.alternatives).not.toContain(`${first.workspaceAddress}-support`);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  it('only works on the main address, not inside a workspace', async () => {
    const response = await send({
      url: '/api/v1/signup/address-availability?address=acme',
      on: host('acme'),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('sign-up', () => {
  it('creates a pending workspace with its owner and emails a link to the workspace address', async () => {
    const body = newSignUp({ email: `Ravi.${randomUUID().slice(0, 8)}@ACME.test` });
    const response = await signUp(body);

    const email = body.email.toLowerCase();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ email });

    const message = kit.emails.lastTo(email);
    expect(message?.subject).toBe('Confirm your email to finish setting up Acme Support');
    expect(message?.text).toContain(`http://${body.workspaceAddress}.${ROOT}/verify-email?token=`);
    expect(message?.html).toContain('Confirm email');

    const [row] = await query<{
      status: string;
      role: string;
      is_owner: boolean;
      verified: Date | null;
      password_hash: string;
    }>(
      `SELECT w.status, m.role, m.is_owner, u.email_verified_at AS verified, u.password_hash
         FROM workspaces w JOIN memberships m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id
        WHERE w.subdomain = :address`,
      { address: body.workspaceAddress },
    );
    expect(row).toMatchObject({ status: 'pending', role: 'admin', is_owner: true, verified: null });
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect(row?.password_hash).not.toContain(body.password);
  });

  it('answers the same way for an email that already has an account, and emails that person instead', async () => {
    const { body } = await signedUpWorkspace();
    const again = newSignUp({ email: body.email });
    const response = await signUp(again);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ email: body.email });
    expect(kit.emails.lastTo(body.email)?.subject).toBe(
      `You already have a ${PRODUCT_NAME} account`,
    );
    expect(
      await query('SELECT 1 FROM workspaces WHERE subdomain = :address', {
        address: again.workspaceAddress,
      }),
    ).toEqual([]);
  });

  it('replaces an earlier unconfirmed sign-up with the same email', async () => {
    const first = newSignUp();
    await signUp(first);
    const second = newSignUp({ email: first.email });
    expect((await signUp(second)).statusCode).toBe(202);

    const rows = await query<{ subdomain: string }>(
      'SELECT subdomain FROM workspaces WHERE subdomain IN (:a, :b)',
      { a: first.workspaceAddress, b: second.workspaceAddress },
    );
    expect(rows.map((r) => r.subdomain)).toEqual([second.workspaceAddress]);
  });

  it('refuses a taken address with suggestions', async () => {
    const first = newSignUp();
    await signUp(first);
    const response = await signUp(newSignUp({ workspaceAddress: first.workspaceAddress }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        details: {
          fields: [{ field: 'workspaceAddress' }],
          alternatives: expect.any(Array) as unknown,
        },
      },
    });
  });

  it('releases the address of a sign-up left unconfirmed for 7 days', async () => {
    const stale = newSignUp();
    await signUp(stale);
    await kit.migrator.query(
      "UPDATE workspaces SET created_at = now() - interval '8 days' WHERE subdomain = :address",
      { replacements: { address: stale.workspaceAddress } },
    );
    await kit.migrator.query(
      "UPDATE users SET created_at = now() - interval '8 days' WHERE email = :email",
      { replacements: { email: stale.email } },
    );

    const response = await signUp(newSignUp({ workspaceAddress: stale.workspaceAddress }));
    expect(response.statusCode).toBe(202);
    expect(await query('SELECT 1 FROM users WHERE email = :email', { email: stale.email })).toEqual(
      [],
    );
  });

  it.each([
    ['a reserved address', { workspaceAddress: 'admin' }, 'workspaceAddress'],
    ['an address with spaces', { workspaceAddress: 'acme support' }, 'workspaceAddress'],
    ['a short password', { password: 'short-pass' }, 'password'],
    ['an invalid email', { email: 'not-an-email' }, 'email'],
    ['an unknown time zone', { timezone: 'Mars/Olympus' }, 'timezone'],
    ['unaccepted terms', { acceptTerms: false }, 'acceptTerms'],
    ['a one-letter name', { name: 'R' }, 'name'],
  ])('rejects %s, naming the field', async (_label, overrides, field) => {
    const response = await signUp(newSignUp(overrides));
    expect(response.statusCode).toBe(400);
    const fields = response.json<{ error: { details: { fields: { field: string }[] } } }>().error
      .details.fields;
    expect(fields.map((f) => f.field)).toContain(field);
  });

  it('rejects a password found in data breaches', async () => {
    kit.breached = true;
    const response = await signUp(newSignUp());
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('appeared in a data breach');
  });

  it('refuses throwaway email services and sends nothing, but accepts free providers like Gmail', async () => {
    const id = randomUUID().slice(0, 8);
    const before = kit.emails.sent.length;
    for (const email of [`asha.${id}@mailinator.com`, `asha.${id}@inbox.mailinator.com`]) {
      const response = await signUp(newSignUp({ email }));
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          details: {
            fields: [
              {
                field: 'email',
                message:
                  "Please use an email address you'll keep using. Temporary email services aren't accepted.",
              },
            ],
          },
        },
      });
    }
    expect(kit.emails.sent.length).toBe(before);
    expect((await signUp(newSignUp({ email: `asha.${id}@gmail.com` }))).statusCode).toBe(202);
  });

  it('accepts browser time zone names, including aliases Node spells differently', async () => {
    for (const timezone of ['Asia/Kolkata', 'America/New_York', 'UTC']) {
      expect((await signUp(newSignUp({ timezone }))).statusCode).toBe(202);
    }
  });

  it('is limited to 5 sign-ups an hour from one network address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await kit.app.inject({
        method: 'POST',
        url: '/api/v1/signup',
        remoteAddress: '192.0.2.77',
        headers: { host: ROOT },
        payload: newSignUp(),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  it('refuses requests sent from another site', async () => {
    const fromEvil = await send({
      method: 'POST',
      url: '/api/v1/signup',
      payload: newSignUp(),
      headers: { origin: 'https://evil.example' },
    });
    const crossSite = await send({
      method: 'POST',
      url: '/api/v1/signup',
      payload: newSignUp(),
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    const sameSite = await send({
      method: 'POST',
      url: '/api/v1/signup',
      payload: newSignUp(),
      headers: { origin: `http://${ROOT}`, 'sec-fetch-site': 'same-origin' },
    });

    expect(fromEvil.statusCode).toBe(403);
    expect(crossSite.statusCode).toBe(403);
    expect(sameSite.statusCode).toBe(202);
  });

  it('only works on the main address', async () => {
    const response = await send({
      method: 'POST',
      url: '/api/v1/signup',
      on: host('acme'),
      payload: newSignUp(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('resend confirmation email', () => {
  it('sends a new link after the cooldown and the old link stops working', async () => {
    const body = newSignUp();
    await signUp(body);
    const oldToken = tokenFrom(kit.emails.lastTo(body.email)?.text);
    await kit.migrator.query(
      "UPDATE email_verifications SET created_at = now() - interval '2 minutes' WHERE user_id = (SELECT id FROM users WHERE email = :email)",
      { replacements: { email: body.email } },
    );

    const response = await send({
      method: 'POST',
      url: '/api/v1/signup/resend',
      payload: { email: body.email },
    });
    const newToken = tokenFrom(kit.emails.lastTo(body.email)?.text);

    expect(response.statusCode).toBe(202);
    expect(newToken).not.toBe(oldToken);
    const withOld = await send({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      on: host(body.workspaceAddress),
      payload: { token: oldToken },
    });
    expect(withOld.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'invalid',
    );
  });

  it('ignores a second request within a minute, and unknown emails, without saying so', async () => {
    const body = newSignUp();
    await signUp(body);
    const before = kit.emails.sent.length;

    const tooSoon = await send({
      method: 'POST',
      url: '/api/v1/signup/resend',
      payload: { email: body.email },
    });
    const unknown = await send({
      method: 'POST',
      url: '/api/v1/signup/resend',
      payload: { email: 'nobody@acme.test' },
    });

    expect(tooSoon.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(kit.emails.sent.length).toBe(before);
  });
});

describe('email confirmation link', () => {
  it('activates the workspace, starts the trial and signs the owner in', async () => {
    const { body, sessionCookie, cookie } = await signedUpWorkspace();

    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const [workspace] = await query<{ status: string; trial_started_at: Date | null }>(
      'SELECT status, trial_started_at FROM workspaces WHERE subdomain = :address',
      { address: body.workspaceAddress },
    );
    expect(workspace?.status).toBe('active');
    expect(workspace?.trial_started_at).not.toBeNull();

    const me = await send({ url: '/api/v1/me', on: host(body.workspaceAddress), cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { name: 'Ravi Shankar', email: body.email },
      workspace: {
        name: 'Acme Support',
        subdomain: body.workspaceAddress,
        timezone: 'Asia/Kolkata',
      },
      role: 'admin',
      isOwner: true,
    });
  });

  it('works only once', async () => {
    const body = newSignUp();
    await signUp(body);
    const token = tokenFrom(kit.emails.lastTo(body.email)?.text);
    const verify = () =>
      send({
        method: 'POST',
        url: '/api/v1/auth/verify-email',
        on: host(body.workspaceAddress),
        payload: { token },
      });

    expect((await verify()).statusCode).toBe(200);
    const again = await verify();
    expect(again.statusCode).toBe(400);
    expect(again.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'used',
    );
  });

  it('expires after 24 hours, and says which email to resend to', async () => {
    const body = newSignUp();
    await signUp(body);
    await kit.migrator.query(
      "UPDATE email_verifications SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = :email)",
      { replacements: { email: body.email } },
    );
    const response = await send({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      on: host(body.workspaceAddress),
      payload: { token: tokenFrom(kit.emails.lastTo(body.email)?.text) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { details: { reason: 'expired', email: body.email } },
    });
  });

  it('does not work on another workspace address or with a made-up token', async () => {
    const body = newSignUp();
    await signUp(body);
    const token = tokenFrom(kit.emails.lastTo(body.email)?.text);

    const elsewhere = await send({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      on: host('someone-else'),
      payload: { token },
    });
    const madeUp = await send({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      on: host(body.workspaceAddress),
      payload: { token: 'x'.repeat(43) },
    });

    for (const response of [elsewhere, madeUp]) {
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
        'invalid',
      );
    }
  });

  it('returns the signed-in member even when the reader database lags (read-after-write)', async () => {
    await kit.restartApp(LAGGING_READER);
    const { body, cookie } = await signedUpWorkspace();

    const me = await send({ url: '/api/v1/me', on: host(body.workspaceAddress), cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(body.email);
  });
});

describe('who am I (/me)', () => {
  it('needs a sign-in', async () => {
    const { body } = await signedUpWorkspace();
    const response = await send({ url: '/api/v1/me', on: host(body.workspaceAddress) });
    expect(response.statusCode).toBe(401);
  });

  it("never shows another workspace's member, even with a valid sign-in elsewhere (tenant isolation)", async () => {
    const owner = await signedUpWorkspace();
    const intruder = await signedUpWorkspace();

    const withIntruderCookie = await send({
      url: '/api/v1/me',
      on: host(owner.body.workspaceAddress),
      cookie: intruder.cookie,
    });
    expect(withIntruderCookie.statusCode).toBe(401);
    expect(withIntruderCookie.body).not.toContain(owner.body.email);
    expect(withIntruderCookie.body).not.toContain(intruder.body.email);
  });

  it('refuses an expired session', async () => {
    const { body, cookie } = await signedUpWorkspace();
    await kit.migrator.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE email = :email)",
      { replacements: { email: body.email } },
    );
    const response = await send({ url: '/api/v1/me', on: host(body.workspaceAddress), cookie });
    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for a workspace that does not exist or is not confirmed yet', async () => {
    const pending = newSignUp();
    await signUp(pending);
    for (const address of ['no-such-workspace', pending.workspaceAddress]) {
      const response = await send({ url: '/api/v1/me', on: host(address) });
      expect(response.statusCode).toBe(404);
    }
  });
});
