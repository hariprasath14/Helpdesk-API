import { describe, expect, it, vi } from 'vitest';
import { normalizeRecoveryCode } from './authenticator.js';
import { isThrowawayEmail } from './email-rules.js';
import {
  alreadyRegisteredEmail,
  invitationEmail,
  newRecoveryCodesEmail,
  passwordChangedEmail,
  passwordResetEmail,
  recoveryCodeUsedEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
  twoFactorResetByAdminEmail,
  verificationEmail,
  yourWorkspacesEmail,
} from './emails.js';
import { permissionsFor, requireRecentPassword } from './permissions.js';
import { csrfTokenFor, csrfTokenMatches } from './sessions.js';
import { createBreachCheck, hashPassword, verifyPassword } from './passwords.js';
import { isTimeZone } from './schemas.js';
import { addressAlternatives, addressProblem, suggestAddress } from './workspace-address.js';
import { PRODUCT_NAME } from '../../product.js';

describe('workspace address rules', () => {
  it.each([
    ['acme', null],
    ['acme-support', null],
    ['a1b', null],
    ['ab', 'format'],
    ['-acme', 'format'],
    ['acme-', 'format'],
    ['Acme', 'format'],
    ['acme_support', 'format'],
    ['a'.repeat(31), 'format'],
    ['admin', 'reserved'],
    [PRODUCT_NAME.toLowerCase(), 'reserved'],
  ])('%s → %s', (address, problem) => {
    expect(addressProblem(address)).toBe(problem);
  });

  it.each([
    ['Acme Support', 'acme-support'],
    ['Acme Support Pvt. Ltd.', 'acme-support-pvt-ltd'],
    ['Café Ñoño', 'cafe-nono'],
    ['AB', 'ab-desk'],
    ['!!!', 'my-desk'],
    ['A very long company name that goes on and on', 'a-very-long-company-name-that'],
  ])('suggests an address for %j', (company, expected) => {
    const suggestion = suggestAddress(company);
    expect(suggestion).toBe(expected);
    expect(addressProblem(suggestion)).toBeNull();
  });

  it('offers only valid alternatives', () => {
    const alternatives = addressAlternatives('a'.repeat(30));
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alternative of alternatives) expect(addressProblem(alternative)).toBeNull();
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password-here')).toBe(false);
  });

  it('sends only the first 5 characters of the SHA-1 hash to the breach service', async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:3303003\nABC:1\n')),
    );
    const check = createBreachCheck(fetchImpl);

    expect(await check('password')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.pwnedpasswords.com/range/5BAA6',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Add-Padding': 'true' }) as unknown,
      }),
    );
  });

  it('treats padding entries (count 0) and unknown passwords as not breached', async () => {
    const fetchImpl = () =>
      Promise.resolve(new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:0\n'));
    expect(await createBreachCheck(fetchImpl as unknown as typeof fetch)('password')).toBe(false);
  });

  it('lets sign-up continue when the breach service is down, and reports it', async () => {
    const onUnavailable = vi.fn();
    const failing = () => Promise.reject(new Error('timeout'));
    const check = createBreachCheck(failing, onUnavailable);
    expect(await check('anything-at-all')).toBe(false);
    expect(onUnavailable).toHaveBeenCalledOnce();

    const notOk = () => Promise.resolve(new Response('', { status: 503 }));
    expect(await createBreachCheck(notOk as unknown as typeof fetch)('anything-at-all')).toBe(
      false,
    );
  });
});

describe('time zones', () => {
  it.each([
    ['Asia/Kolkata', true],
    ['Asia/Calcutta', true],
    ['Europe/London', true],
    ['UTC', true],
    ['Mars/Olympus', false],
    ['', false],
  ])('%j → %s', (zone, valid) => {
    expect(isTimeZone(zone)).toBe(valid);
  });
});

describe('sign-up emails', () => {
  it('escapes names in HTML so an email can never carry injected markup', () => {
    const message = verificationEmail({
      to: 'x@acme.test',
      name: '<script>alert(1)</script>',
      workspaceName: 'Acme & "Co"',
      link: 'https://acme.helpdesk.example.com/verify-email?token=abc',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Acme &amp; &quot;Co&quot;');
    expect(message.text).toContain('https://acme.helpdesk.example.com/verify-email?token=abc');
  });

  it('points an existing account to sign-in', () => {
    const message = alreadyRegisteredEmail({
      to: 'x@acme.test',
      signInUrl: 'https://helpdesk.example.com/login',
    });
    expect(message.subject).toBe(`You already have a ${PRODUCT_NAME} account`);
    expect(message.text).toContain('https://helpdesk.example.com/login');
  });
});

describe('account emails', () => {
  const evil = '<img src=x onerror=alert(1)>';

  it('sends a reset link that says when it expires, with names escaped', () => {
    const message = passwordResetEmail({
      to: 'x@acme.test',
      name: evil,
      workspaceName: evil,
      link: 'https://acme.helpdesk.example.com/reset-password?token=abc',
    });
    expect(message.text).toContain('https://acme.helpdesk.example.com/reset-password?token=abc');
    expect(message.text).toContain('expires in 1 hour');
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain(`activity on your ${PRODUCT_NAME} account`);
  });

  it('tells the person their password changed and how to undo it', () => {
    const message = passwordChangedEmail({
      to: 'x@acme.test',
      name: evil,
      forgotUrl: 'https://acme.helpdesk.example.com/forgot-password',
    });
    expect(message.text).toContain(`every ${PRODUCT_NAME} workspace you belong to`);
    expect(message.text).toContain('https://acme.helpdesk.example.com/forgot-password');
    expect(message.html).not.toContain('<img');
  });

  it('lists every workspace with its sign-in link, escaped', () => {
    const message = yourWorkspacesEmail({
      to: 'x@acme.test',
      name: 'Ravi',
      workspaces: [
        { name: evil, loginUrl: 'https://a.helpdesk.example.com/login' },
        { name: 'Beta', loginUrl: 'https://b.helpdesk.example.com/login' },
      ],
    });
    expect(message.text).toContain('- Beta: https://b.helpdesk.example.com/login');
    expect(message.html).toContain('https://a.helpdesk.example.com/login');
    expect(message.html).not.toContain('<img');
  });
});

describe('CSRF token', () => {
  it('is derived from the session and only matches that session', () => {
    const token = csrfTokenFor('session-a');
    expect(token).toBe(csrfTokenFor('session-a'));
    expect(csrfTokenMatches('session-a', token)).toBe(true);
    expect(csrfTokenMatches('session-b', token)).toBe(false);
    expect(csrfTokenMatches('session-a', undefined)).toBe(false);
    expect(csrfTokenMatches('session-a', 'short')).toBe(false);
  });
});

describe('two-step verification emails', () => {
  const base = {
    to: 'x@acme.test',
    name: '<b>Ravi</b>',
    forgotUrl: 'https://a.helpdesk.example.com/forgot-password',
  };

  it.each([
    [twoFactorEnabledEmail(base), `Two-step verification is on for your ${PRODUCT_NAME} account`],
    [twoFactorDisabledEmail(base), 'Two-step verification was turned off'],
    [newRecoveryCodesEmail(base), `New ${PRODUCT_NAME} recovery codes were created`],
  ])('%# has its subject, a way out, and escaped names', (message, subject) => {
    expect(message.subject).toBe(subject);
    expect(message.text).toContain('https://a.helpdesk.example.com/forgot-password');
    expect(message.html).not.toContain('<b>Ravi</b>');
  });

  it('says how many recovery codes are left, in words that fit the number', () => {
    expect(recoveryCodeUsedEmail({ ...base, remaining: 1 }).text).toContain('1 recovery code left');
    expect(recoveryCodeUsedEmail({ ...base, remaining: 4 }).text).toContain(
      '4 recovery codes left',
    );
  });
});

describe('recovery code input', () => {
  it('ignores case, spaces and hyphens', () => {
    expect(normalizeRecoveryCode(' AB3D-EF7H ')).toBe('ab3def7h');
    expect(normalizeRecoveryCode('ab3d ef7h')).toBe('ab3def7h');
  });
});

describe('member emails', () => {
  it('invites with the role and a 7-day link, escaping names', () => {
    const message = invitationEmail({
      to: 'x@acme.test',
      inviterName: '<i>Asha</i>',
      workspaceName: 'Acme & Co',
      role: 'supervisor',
      link: 'https://acme.helpdesk.example.com/invite?token=abc',
    });
    expect(message.text).toContain('as a Supervisor');
    expect(message.text).toContain('https://acme.helpdesk.example.com/invite?token=abc');
    expect(message.html).not.toContain('<i>Asha</i>');
    expect(message.html).toContain('Acme &amp; Co');
  });

  it('says which admin reset two-step verification', () => {
    const message = twoFactorResetByAdminEmail({
      to: 'x@acme.test',
      name: 'Neha',
      adminName: 'Asha',
      workspaceName: 'Acme Support',
      forgotUrl: 'https://acme.helpdesk.example.com/forgot-password',
    });
    expect(message.text).toContain(
      'Asha, an admin of Acme Support, reset your two-step verification',
    );
  });
});

describe('roles', () => {
  it('gives admins everything, supervisors the floor, agents their tickets', () => {
    expect(permissionsFor('admin')).toContain('settings.manage');
    expect(permissionsFor('supervisor')).not.toContain('settings.manage');
    expect(permissionsFor('agent')).toEqual(['tickets.work', 'contacts.edit']);
  });

  it('accepts a password confirmed within 10 minutes only', () => {
    const at = (minutesAgo: number) => ({
      session: { reauthenticatedAt: new Date(Date.now() - minutesAgo * 60_000) },
    });
    expect(() => {
      requireRecentPassword(at(9));
    }).not.toThrow();
    expect(() => {
      requireRecentPassword(at(11));
    }).toThrow('Confirm your password to continue.');
    expect(() => {
      requireRecentPassword({ session: { reauthenticatedAt: null } });
    }).toThrow();
  });
});

describe('throwaway email services', () => {
  it.each([
    ['someone@mailinator.com', true],
    ['someone@Inbox.Mailinator.com', true],
    ['someone@10minutemail.com', true],
    ['someone@gmail.com', false],
    ['someone@outlook.com', false],
    ['someone@yahoo.co.in', false],
    ['someone@acme.co.in', false],
  ])('%s → %s', (email, throwaway) => {
    expect(isThrowawayEmail(email)).toBe(throwaway);
  });
});
