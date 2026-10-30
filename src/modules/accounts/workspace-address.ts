import { PRODUCT_NAME } from '../../product.js';
/**
 * Workspace address (subdomain) rules: 3 to 30 characters, lowercase letters, numbers and
 * hyphens, not starting or ending with a hyphen, and not a reserved name.
 */
export const ADDRESS_PATTERN = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])$/;

/** Names kept for the product itself, infrastructure, or that could mislead customers. */
export const RESERVED_ADDRESSES = new Set([
  'www',
  'app',
  'api',
  'admin',
  'administrator',
  'mail',
  'email',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'help',
  'support',
  'status',
  'docs',
  'doc',
  'blog',
  'news',
  'dev',
  'staging',
  'stage',
  'test',
  'demo',
  'prod',
  'production',
  'beta',
  'cdn',
  'static',
  'assets',
  'files',
  'media',
  'img',
  'auth',
  'login',
  'signin',
  'signup',
  'register',
  'account',
  'accounts',
  'billing',
  'pay',
  'payments',
  'security',
  'root',
  'system',
  'internal',
  'dashboard',
  'portal',
  'console',
  'helpdesk',
  // The product's own name, whatever it is (src/product.ts).
  PRODUCT_NAME.toLowerCase().replace(/[^a-z0-9-]/g, ''),
  'mailpit',
  'localhost',
]);

export type AddressProblem = 'format' | 'reserved';

/** Why an address cannot be used, before looking at the database; null when the shape is fine. */
export function addressProblem(address: string): AddressProblem | null {
  if (!ADDRESS_PATTERN.test(address)) return 'format';
  if (RESERVED_ADDRESSES.has(address)) return 'reserved';
  return null;
}

/** "Acme Support Pvt. Ltd." → "acme-support-pvt-ltd", trimmed to 30 characters. */
export function suggestAddress(companyName: string): string {
  const slug = companyName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return slug.length >= 3 ? slug : `${slug || 'my'}-desk`.slice(0, 30);
}

/** Alternatives when an address is taken: acme-support, acme-team, acme2, acme3 … */
export function addressAlternatives(address: string): string[] {
  const base = address.slice(0, 24).replace(/-+$/g, '');
  return [`${base}-support`, `${base}-team`, `${base}-help`, `${base}2`, `${base}3`, `${base}-hq`]
    .map((candidate) => candidate.slice(0, 30))
    .filter((candidate) => addressProblem(candidate) === null);
}
