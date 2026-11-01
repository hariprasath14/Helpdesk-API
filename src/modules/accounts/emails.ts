import type { EmailMessage } from '../../adapters/email/index.js';
import { PRODUCT_NAME } from '../../product.js';

// Plain, readable emails until branded templates arrive with outgoing email (F13). Every value
// placed into HTML is escaped.

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const SIGN_UP_REASON = `You received this email because someone used this address to sign up for ${PRODUCT_NAME}.`;
const ACCOUNT_REASON = `You received this email because of activity on your ${PRODUCT_NAME} account.`;

function layout(
  heading: string,
  paragraphs: string[],
  button?: { label: string; url: string },
  reason = SIGN_UP_REASON,
) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${p}</p>`).join('');
  const action = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="background:#2b7343;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">${escapeHtml(button.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#212529">
<div style="max-width:520px;margin:32px auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-weight:bold;color:#12301d">${escapeHtml(PRODUCT_NAME)}</p>
<h1 style="font-size:20px;margin:0 0 16px;color:#1d2026">${escapeHtml(heading)}</h1>${body}${action}
<p style="margin:24px 0 0;font-size:12px;color:#676d7b">${reason}</p>
</div></body></html>`;
}

export function verificationEmail(input: {
  to: string;
  name: string;
  workspaceName: string;
  link: string;
}): EmailMessage {
  const { to, name, workspaceName, link } = input;
  return {
    to,
    subject: `Confirm your email to finish setting up ${workspaceName}`,
    text: [
      `Hi ${name},`,
      '',
      `Click this link to confirm your email and open ${workspaceName} on ${PRODUCT_NAME}:`,
      link,
      '',
      'The link works once and expires in 24 hours. If you did not sign up, ignore this email.',
    ].join('\n'),
    html: layout(
      'Confirm your email',
      [
        `Hi ${escapeHtml(name)},`,
        `Confirm your email to finish setting up <strong>${escapeHtml(workspaceName)}</strong> on ${PRODUCT_NAME}.`,
        'The link works once and expires in 24 hours. If you did not sign up, you can ignore this email.',
      ],
      { label: 'Confirm email', url: link },
    ),
  };
}

/** Sent instead of a new sign-up when the email already has an account (no one learns that from the screen). */
export function alreadyRegisteredEmail(input: { to: string; signInUrl: string }): EmailMessage {
  return {
    to: input.to,
    subject: `You already have a ${PRODUCT_NAME} account`,
    text: [
      `Someone tried to sign up for ${PRODUCT_NAME} with this email, but it already has an account.`,
      '',
      `Sign in here: ${input.signInUrl}`,
      'Forgot your password? Use "Forgot password" on the sign-in page.',
      '',
      'If this was not you, you can ignore this email; nothing has changed.',
    ].join('\n'),
    html: layout(
      'You already have an account',
      [
        `Someone tried to sign up for ${PRODUCT_NAME} with this email, but it already has an account.`,
        'Forgot your password? Use "Forgot password" on the sign-in page.',
        'If this was not you, you can ignore this email; nothing has changed.',
      ],
      { label: 'Sign in', url: input.signInUrl },
    ),
  };
}

export function passwordResetEmail(input: {
  to: string;
  name: string;
  workspaceName: string;
  link: string;
}): EmailMessage {
  const { to, name, workspaceName, link } = input;
  return {
    to,
    subject: `Reset your ${PRODUCT_NAME} password`,
    text: [
      `Hi ${name},`,
      '',
      `Someone asked to reset your password on ${workspaceName}. Click this link to choose a new one:`,
      link,
      '',
      'The link works once and expires in 1 hour. If you did not ask for this, ignore this email; your password has not changed.',
    ].join('\n'),
    html: layout(
      'Reset your password',
      [
        `Hi ${escapeHtml(name)},`,
        `Someone asked to reset your password on <strong>${escapeHtml(workspaceName)}</strong>.`,
        'The link works once and expires in 1 hour. If you did not ask for this, you can ignore this email; your password has not changed.',
      ],
      { label: 'Choose a new password', url: link },
      ACCOUNT_REASON,
    ),
  };
}

/** Sent after every password change or reset, so a change the person did not make is noticed. */
export function passwordChangedEmail(input: {
  to: string;
  name: string;
  forgotUrl: string;
}): EmailMessage {
  const { to, name, forgotUrl } = input;
  return {
    to,
    subject: `Your ${PRODUCT_NAME} password was changed`,
    text: [
      `Hi ${name},`,
      '',
      `Your ${PRODUCT_NAME} password was just changed, and you were signed out on your other devices.`,
      `This password is used for every ${PRODUCT_NAME} workspace you belong to.`,
      '',
      `If you did not do this, reset your password now: ${forgotUrl}`,
    ].join('\n'),
    html: layout(
      'Your password was changed',
      [
        `Hi ${escapeHtml(name)},`,
        `Your ${PRODUCT_NAME} password was just changed, and you were signed out on your other devices.`,
        `This password is used for every ${PRODUCT_NAME} workspace you belong to.`,
        'If you did not do this, reset your password now.',
      ],
      { label: 'Reset password', url: forgotUrl },
      ACCOUNT_REASON,
    ),
  };
}

/** "Find your workspace": links to every workspace the person can sign in to. */
export function yourWorkspacesEmail(input: {
  to: string;
  name: string;
  workspaces: { name: string; loginUrl: string }[];
}): EmailMessage {
  const { to, name, workspaces } = input;
  return {
    to,
    subject: `Your ${PRODUCT_NAME} workspaces`,
    text: [
      `Hi ${name},`,
      '',
      `You can sign in to these ${PRODUCT_NAME} workspaces:`,
      ...workspaces.map((workspace) => `- ${workspace.name}: ${workspace.loginUrl}`),
      '',
      'If you did not ask for this list, you can ignore this email.',
    ].join('\n'),
    html: layout(
      'Your workspaces',
      [
        `Hi ${escapeHtml(name)},`,
        `You can sign in to these ${PRODUCT_NAME} workspaces:`,
        ...workspaces.map(
          (workspace) =>
            `<a href="${escapeHtml(workspace.loginUrl)}" style="color:#2b7343;font-weight:bold">${escapeHtml(workspace.name)}</a><br><span style="color:#676d7b">${escapeHtml(workspace.loginUrl)}</span>`,
        ),
        'If you did not ask for this list, you can ignore this email.',
      ],
      undefined,
      ACCOUNT_REASON,
    ),
  };
}

/** A security notice: a heading, what happened, and what to do if it was not the person. */
function securityNotice(input: {
  to: string;
  name: string;
  subject: string;
  heading: string;
  lines: string[];
  forgotUrl: string;
}): EmailMessage {
  const { to, name, subject, heading, lines, forgotUrl } = input;
  const notYou = 'If this was not you, reset your password now.';
  return {
    to,
    subject,
    text: [`Hi ${name},`, '', ...lines, '', `${notYou} ${forgotUrl}`].join('\n'),
    html: layout(
      heading,
      [`Hi ${escapeHtml(name)},`, ...lines.map(escapeHtml), notYou],
      { label: 'Reset password', url: forgotUrl },
      ACCOUNT_REASON,
    ),
  };
}

export function twoFactorEnabledEmail(input: {
  to: string;
  name: string;
  forgotUrl: string;
}): EmailMessage {
  return securityNotice({
    ...input,
    subject: `Two-step verification is on for your ${PRODUCT_NAME} account`,
    heading: 'Two-step verification is on',
    lines: [
      `Signing in to ${PRODUCT_NAME} now needs a code from your authenticator app as well as your password, in every workspace you belong to.`,
      'Keep your recovery codes somewhere safe: they let you in if you lose your phone.',
    ],
  });
}

export function twoFactorDisabledEmail(input: {
  to: string;
  name: string;
  forgotUrl: string;
}): EmailMessage {
  return securityNotice({
    ...input,
    subject: 'Two-step verification was turned off',
    heading: 'Two-step verification was turned off',
    lines: [`Signing in to ${PRODUCT_NAME} now needs only your password.`],
  });
}

export function recoveryCodeUsedEmail(input: {
  to: string;
  name: string;
  remaining: number;
  forgotUrl: string;
}): EmailMessage {
  const left =
    input.remaining === 1
      ? '1 recovery code left'
      : `${String(input.remaining)} recovery codes left`;
  return securityNotice({
    ...input,
    subject: `A recovery code was used to sign in to ${PRODUCT_NAME}`,
    heading: 'A recovery code was used',
    lines: [
      `Someone signed in to your ${PRODUCT_NAME} account with a recovery code. You have ${left}.`,
      'Create new ones from Your account when you are signed in.',
    ],
  });
}

export function newRecoveryCodesEmail(input: {
  to: string;
  name: string;
  forgotUrl: string;
}): EmailMessage {
  return securityNotice({
    ...input,
    subject: `New ${PRODUCT_NAME} recovery codes were created`,
    heading: 'New recovery codes were created',
    lines: ['Your old recovery codes no longer work.'],
  });
}

const ROLE_NAMES = { admin: 'an Admin', supervisor: 'a Supervisor', agent: 'an Agent' } as const;

export function invitationEmail(input: {
  to: string;
  inviterName: string;
  workspaceName: string;
  role: keyof typeof ROLE_NAMES;
  link: string;
}): EmailMessage {
  const { to, inviterName, workspaceName, role, link } = input;
  // A fixed table keyed by the Role type.
  // eslint-disable-next-line security/detect-object-injection
  const asRole = ROLE_NAMES[role];
  return {
    to,
    subject: `${inviterName} invited you to join ${workspaceName} on ${PRODUCT_NAME}`,
    text: [
      `${inviterName} invited you to join ${workspaceName} on ${PRODUCT_NAME} as ${asRole}.`,
      '',
      `Accept the invitation: ${link}`,
      '',
      'The link works once and expires in 7 days. If you were not expecting this, you can ignore this email.',
    ].join('\n'),
    html: layout(
      `Join ${workspaceName} on ${PRODUCT_NAME}`,
      [
        `${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(workspaceName)}</strong> on ${PRODUCT_NAME} as ${asRole}.`,
        'The link works once and expires in 7 days. If you were not expecting this, you can ignore this email.',
      ],
      { label: 'Accept invitation', url: link },
      `You received this email because someone invited this address to ${PRODUCT_NAME}.`,
    ),
  };
}

export function twoFactorResetByAdminEmail(input: {
  to: string;
  name: string;
  adminName: string;
  workspaceName: string;
  forgotUrl: string;
}): EmailMessage {
  return securityNotice({
    ...input,
    subject: `Your ${PRODUCT_NAME} two-step verification was reset`,
    heading: 'Your two-step verification was reset',
    lines: [
      `${input.adminName}, an admin of ${input.workspaceName}, reset your two-step verification and signed you out.`,
      'Sign in with your password. If the workspace requires two-step verification, you will set it up again.',
    ],
  });
}
