import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, keyId } from './encryption.js';

const key = randomBytes(32);

describe('encryption', () => {
  it('round-trips, with a fresh nonce every time', () => {
    const first = encrypt('JBSWY3DPEHPK3PXP', key);
    const second = encrypt('JBSWY3DPEHPK3PXP', key);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.ciphertext).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decrypt(first, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(first.keyId).toBe(keyId(key));
  });

  it('refuses a value encrypted with another key', () => {
    const value = encrypt('secret', key);
    expect(() => decrypt(value, randomBytes(32))).toThrow(/different key/);
  });

  it('detects tampering', () => {
    const value = encrypt('secret', key);
    const raw = Buffer.from(value.ciphertext, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decrypt({ ...value, ciphertext: raw.toString('base64') }, key)).toThrow();
  });
});
