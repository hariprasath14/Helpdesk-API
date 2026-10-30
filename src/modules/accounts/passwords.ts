import { createHash } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { PRODUCT_NAME } from '../../product.js';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 passes). */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

/**
 * Spends the same time as hashing a real password. Used on paths that would otherwise answer
 * faster (for example "this email already has an account"), so timing reveals nothing.
 */
export async function hashDecoy(): Promise<void> {
  await hash('decoy-password-for-equal-timing', ARGON2_OPTIONS);
}

export type BreachCheck = (password: string) => Promise<boolean>;

/**
 * Asks Have I Been Pwned whether a password appears in known breaches. Only the first five
 * characters of its SHA-1 hash leave the server (k-anonymity), never the password. If the service
 * is slow or down, the check passes rather than blocking sign-up; the length rule still applies.
 */
export function createBreachCheck(
  fetchImpl: typeof fetch = fetch,
  onUnavailable: (error: unknown) => void = () => undefined,
): BreachCheck {
  return async (password) => {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': PRODUCT_NAME },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`HIBP answered ${String(response.status)}`);
      const body = await response.text();
      return body.split('\n').some((line) => {
        const [lineSuffix, count] = line.trim().split(':');
        return lineSuffix === suffix && Number(count) > 0;
      });
    } catch (error) {
      onUnavailable(error);
      return false;
    }
  };
}

/** Used when PASSWORD_BREACH_CHECK=false (tests, offline development). */
export const noBreachCheck: BreachCheck = () => Promise.resolve(false);
