import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

/** New primary key: UUID v7, time-ordered so indexes stay compact (ENGINEERING_STANDARDS.md 1). */
export const newId = (): string => uuidv7();

/**
 * A secret for links and sessions: 32 random bytes, URL-safe. Only its hash is stored, so a
 * database leak cannot be used to verify an email or take over a session.
 */
export function newSecretToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
