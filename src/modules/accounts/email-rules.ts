import { isDisposableEmailDomain } from 'disposable-email-domains-js';

/**
 * Throwaway (temporary) email services such as Mailinator: inboxes anyone can open that vanish in
 * minutes. A workspace owner needs an inbox they keep for password resets and security notices,
 * so sign-up refuses them. Free providers (Gmail, Outlook.com, Yahoo) are fine. The list is the
 * community-maintained one (disposable-email-domains-js); subdomains such as x.mailinator.com
 * count too.
 */
export function isThrowawayEmail(email: string): boolean {
  const domain = email
    .slice(email.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase();
  const labels = domain.split('.');
  for (let start = 0; start <= labels.length - 2; start += 1) {
    if (isDisposableEmailDomain(labels.slice(start).join('.'))) return true;
  }
  return false;
}
