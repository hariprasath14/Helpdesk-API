/**
 * Free email services: many unrelated people share them, so they can't be a company's domain and
 * never link a contact to a company. Exact names and whole families (yahoo.*, hotmail.*, …).
 */
const FREE_PROVIDERS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'zoho.com',
  'zohomail.com',
  'zohomail.in',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'rediffmail.com',
  'tutanota.com',
  'fastmail.com',
  'hey.com',
]);
const FREE_FAMILIES = ['yahoo.', 'ymail.', 'hotmail.', 'yandex.', 'gmx.', 'web.de', 'qq.com'];

export function isFreeEmailDomain(domain: string): boolean {
  const name = domain.toLowerCase();
  return FREE_PROVIDERS.has(name) || FREE_FAMILIES.some((family) => name.startsWith(family));
}

/** The domain of an email address ("neha@Acme.com" → "acme.com"). */
export const domainOf = (email: string): string =>
  email.slice(email.lastIndexOf('@') + 1).toLowerCase();

const LABEL = /^[a-z0-9-]{1,63}$/;
const TOP_LEVEL = /^[a-z]{2,63}$/;

/** acme.com, mail.acme.co.in: dot-separated labels ending in letters, at most 253 characters. */
function isDomain(domain: string): boolean {
  const labels = domain.split('.');
  return (
    domain.length <= 253 &&
    labels.length >= 2 &&
    TOP_LEVEL.test(labels.at(-1) ?? '') &&
    labels.every((label) => LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'))
  );
}

/** A typed domain, tidied ("@Acme.com", "https://www.acme.com/" → "acme.com"), or null if invalid. */
export function cleanDomain(text: string): string | null {
  const domain = text
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^@/, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return isDomain(domain) ? domain : null;
}
