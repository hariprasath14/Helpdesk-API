import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption for secrets the server must read back (authenticator secrets): AES-256-GCM, a fresh
 * random nonce each time, and an authentication tag, so tampering is detected. The key ID (a short
 * fingerprint of the key) is stored next to the ciphertext, so a future key change can tell which
 * key each value needs.
 */
export interface Encrypted {
  ciphertext: string;
  keyId: string;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function encrypt(plaintext: string, key: Buffer): Encrypted {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64'),
    keyId: keyId(key),
  };
}

export function decrypt(value: Encrypted, key: Buffer): string {
  if (value.keyId !== keyId(key)) throw new Error('Encrypted with a different key.');
  const raw = Buffer.from(value.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE_BYTES));
  decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}
