import { randomInt } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/encryption.js';
import { hashToken, newId, newSecretToken } from '../../lib/tokens.js';
import { accountModels } from './models.js';
import { PRODUCT_NAME } from '../../product.js';

/**
 * Two-step verification building blocks: authenticator secrets (encrypted), 6-digit codes (TOTP,
 * RFC 6238: SHA-1, 30-second steps, one step of clock drift either way), one-time recovery codes
 * (hashed), and the short "half signed in" challenge between password and code.
 */

const ISSUER = PRODUCT_NAME;
const PERIOD_SECONDS = 30;
export const RECOVERY_CODE_COUNT = 10;
// No 0/o, 1/l/i: easy to read back from paper.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CHALLENGE_MINUTES = 5;
/** Wrong codes allowed on one challenge before the person must enter their password again. */
export const CHALLENGE_MAX_FAILURES = 5;

interface Deps {
  config: Config;
  db: Database;
}

export interface TwoFactorSummary {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** This workspace requires two-step verification for everyone. */
  required: boolean;
  /** Required here but not set up yet: only setup and sign-out are allowed. */
  setupRequired: boolean;
}

export async function twoFactorSummary(
  deps: Deps,
  userId: string,
  workspace: { requireTwoFactor: boolean },
): Promise<TwoFactorSummary> {
  const { UserTwoFactor, RecoveryCode } = accountModels(deps.db.writer);
  const row = await UserTwoFactor.findByPk(userId, { attributes: ['enabledAt'] });
  const enabled = Boolean(row?.enabledAt);
  const recoveryCodesLeft = enabled
    ? await RecoveryCode.count({ where: { userId, usedAt: null } })
    : 0;
  const required = workspace.requireTwoFactor;
  return { enabled, recoveryCodesLeft, required, setupRequired: required && !enabled };
}

function totpFor(secretBase32: string, label: string) {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

/**
 * Starts (or restarts) setup: a new secret, stored encrypted and not yet enabled. Returns what the
 * person needs to add it to their app: the setup key, the otpauth:// address and its QR code.
 */
export async function newAuthenticatorSecret(
  deps: Deps,
  user: { id: string; email: string },
  transaction: Transaction,
) {
  const { UserTwoFactor } = accountModels(deps.db.writer);
  const secret = new Secret({ size: 20 });
  const { ciphertext, keyId } = encrypt(secret.base32, deps.config.TWO_FACTOR_ENCRYPTION_KEY);
  await UserTwoFactor.upsert(
    { userId: user.id, secretEncrypted: ciphertext, keyId, enabledAt: null, lastUsedStep: null },
    { transaction },
  );
  const otpauthUri = totpFor(secret.base32, user.email).toString();
  const qrSvg = await QRCode.toString(otpauthUri, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  return { secret: secret.base32, otpauthUri, qrSvg };
}

/** The person's authenticator row, locked for this transaction (codes are checked one at a time). */
export function lockedAuthenticator(deps: Deps, userId: string, transaction: Transaction) {
  const { UserTwoFactor } = accountModels(deps.db.writer);
  return UserTwoFactor.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
}

/**
 * Checks a 6-digit code against the person's secret. A code is accepted once: its time step must
 * be newer than the last one used. Records the step on success.
 */
export async function acceptAuthenticatorCode(
  deps: Deps,
  row: NonNullable<Awaited<ReturnType<typeof lockedAuthenticator>>>,
  code: string,
  transaction: Transaction,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = decrypt(
    { ciphertext: row.secretEncrypted, keyId: row.keyId },
    deps.config.TWO_FACTOR_ENCRYPTION_KEY,
  );
  const delta = totpFor(secret, ISSUER).validate({ token: code, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta;
  if (row.lastUsedStep !== null && step <= row.lastUsedStep) return false;
  await row.update({ lastUsedStep: step }, { transaction });
  return true;
}

export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
const recoveryHash = (userId: string, code: string) =>
  hashToken(`${userId}:${normalizeRecoveryCode(code)}`);

function newRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length));
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Replaces the person's recovery codes with RECOVERY_CODE_COUNT new ones, shown once. */
export async function replaceRecoveryCodes(
  deps: Deps,
  userId: string,
  transaction: Transaction,
): Promise<string[]> {
  const { RecoveryCode } = accountModels(deps.db.writer);
  await RecoveryCode.destroy({ where: { userId }, transaction });
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(newRecoveryCode());
  await RecoveryCode.bulkCreate(
    [...codes].map((code) => ({
      id: newId(),
      userId,
      codeHash: recoveryHash(userId, code),
      usedAt: null,
    })),
    { transaction },
  );
  return [...codes];
}

/** Uses up a recovery code. Returns how many are left, or null if the code is wrong or used. */
export async function useRecoveryCode(
  deps: Deps,
  userId: string,
  code: string,
  transaction: Transaction,
): Promise<number | null> {
  const { RecoveryCode } = accountModels(deps.db.writer);
  const row = await RecoveryCode.findOne({
    where: { userId, codeHash: recoveryHash(userId, code), usedAt: null },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!row) return null;
  await row.update({ usedAt: new Date() }, { transaction });
  return RecoveryCode.count({ where: { userId, usedAt: null }, transaction });
}

/** The "half signed in" step after a correct password: lasts CHALLENGE_MINUTES, hash only. */
export async function createLoginChallenge(
  deps: Deps,
  owner: { userId: string; workspaceId: string },
): Promise<{ token: string; expiresAt: Date }> {
  const { LoginChallenge } = accountModels(deps.db.writer);
  await LoginChallenge.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
  const { token, hash } = newSecretToken();
  const expiresAt = new Date(Date.now() + CHALLENGE_MINUTES * 60 * 1000);
  await LoginChallenge.create({
    id: newId(),
    tokenHash: hash,
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    expiresAt,
  });
  return { token, expiresAt };
}
