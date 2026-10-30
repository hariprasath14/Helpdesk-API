import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config/index.js';

/**
 * A workspace's own email address: "<workspace address>@TICKET_EMAIL_DOMAIN". Ticket email goes
 * out from it, and email sent to it becomes a ticket (F14).
 */
export const workspaceEmail = (config: Pick<Config, 'TICKET_EMAIL_DOMAIN'>, subdomain: string) =>
  `${subdomain}@${config.TICKET_EMAIL_DOMAIN}`;

/** "Acme Support <acme@mail.helpdesk.example.com>", with the name quoted so commas and dots are safe. */
export function workspaceFrom(
  config: Pick<Config, 'TICKET_EMAIL_DOMAIN'>,
  workspace: { name: string; subdomain: string; emailSenderName: string | null },
): string {
  const name = (workspace.emailSenderName ?? workspace.name).replaceAll(/["\\\r\n]/g, '');
  return `"${name}" <${workspaceEmail(config, workspace.subdomain)}>`;
}

// The reply address carries a short signature so a reply lands on its own ticket even when the
// customer's email program drops the threading headers, and nobody can aim email at another
// ticket by changing the number. The key is derived from an existing secret, so no new one is
// needed in every environment.
function signingKey(config: Pick<Config, 'TWO_FACTOR_ENCRYPTION_KEY'>): Buffer {
  return Buffer.from(
    hkdfSync('sha256', config.TWO_FACTOR_ENCRYPTION_KEY, '', 'helpdesk-email-reply-address', 32),
  );
}

const signatureOf = (key: Buffer, workspaceId: string, ticketNumber: number) =>
  createHmac('sha256', key)
    .update(`${workspaceId}:${String(ticketNumber)}`)
    .digest('hex')
    .slice(0, 12);

/** "acme+42-3f9a0c1d2e4b@mail.helpdesk.example.com": replies to it go to ticket #42 (F14). */
export function ticketReplyAddress(
  config: Pick<Config, 'TICKET_EMAIL_DOMAIN' | 'TWO_FACTOR_ENCRYPTION_KEY'>,
  workspace: { id: string; subdomain: string },
  ticketNumber: number,
): string {
  const signature = signatureOf(signingKey(config), workspace.id, ticketNumber);
  return `${workspace.subdomain}+${String(ticketNumber)}-${signature}@${config.TICKET_EMAIL_DOMAIN}`;
}

/**
 * Reads an address on TICKET_EMAIL_DOMAIN: the workspace it belongs to and, for a reply address
 * with a valid signature, the ticket number. Null for any other domain.
 */
export function readTicketAddress(
  config: Pick<Config, 'TICKET_EMAIL_DOMAIN' | 'TWO_FACTOR_ENCRYPTION_KEY'>,
  address: string,
  workspaceIdOf: (subdomain: string) => string | null,
): { subdomain: string; ticketNumber: number | null } | null {
  const email = address.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1 || email.slice(at + 1) !== config.TICKET_EMAIL_DOMAIN) return null;
  const local = email.slice(0, at);
  const plus = local.indexOf('+');
  const subdomain = plus === -1 ? local : local.slice(0, plus);
  if (!/^[a-z0-9-]+$/.test(subdomain)) return null;
  // Anything after "+" that is not a valid ticket tag still reaches the workspace.
  const tag = plus === -1 ? null : /^(\d{1,9})-([0-9a-f]{12})$/.exec(local.slice(plus + 1));
  if (!tag?.[1] || !tag[2]) return { subdomain, ticketNumber: null };
  const workspaceId = workspaceIdOf(subdomain);
  const number = Number(tag[1]);
  if (!workspaceId) return { subdomain, ticketNumber: null };
  const expected = Buffer.from(signatureOf(signingKey(config), workspaceId, number));
  const given = Buffer.from(tag[2]);
  return {
    subdomain,
    ticketNumber:
      expected.length === given.length && timingSafeEqual(expected, given) ? number : null,
  };
}

/** A Message-ID for an email we send, on our own domain. */
export const messageIdFor = (config: Pick<Config, 'TICKET_EMAIL_DOMAIN'>, messageId: string) =>
  `<${messageId}@${config.TICKET_EMAIL_DOMAIN}>`;
