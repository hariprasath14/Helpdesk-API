import type { FastifyBaseLogger } from 'fastify';
import { Op, type Transaction } from 'sequelize';
import type { EmailSender } from '../../adapters/email/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import { hashToken, newId, newSecretToken } from '../../lib/tokens.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { isThrowawayEmail } from './email-rules.js';
import { alreadyRegisteredEmail, verificationEmail } from './emails.js';
import { accountModels, type UserRecord, type WorkspaceRecord } from './models.js';
import { hashDecoy, hashPassword, type BreachCheck } from './passwords.js';
import { createSession } from './sessions.js';
import { addressAlternatives, addressProblem } from './workspace-address.js';

/** An unverified sign-up holds its workspace address for this long, then releases it. */
export const PENDING_SIGNUP_DAYS = 7;
const VERIFICATION_LINK_HOURS = 24;
/** The "Resend email" button is ignored for this long after the last email. */
const RESEND_COOLDOWN_SECONDS = 60;

export interface AccountDeps {
  config: Config;
  db: Database;
  email: EmailSender;
  breachCheck: BreachCheck;
  log: FastifyBaseLogger;
}

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
  companyName: string;
  workspaceAddress: string;
  timezone: string;
}

export interface RequestMeta {
  ip: string;
  userAgent: string | undefined;
}

/** https://acme.helpdesk.example.com from APP_PUBLIC_URL https://helpdesk.example.com (keeps any port). */
export function workspaceUrl(config: Config, subdomain: string): URL {
  const url = new URL(config.APP_PUBLIC_URL.href);
  url.hostname = `${subdomain}.${url.hostname}`;
  return url;
}

const pendingCutoff = () => new Date(Date.now() - PENDING_SIGNUP_DAYS * 24 * 60 * 60 * 1000);

/**
 * Removes unverified sign-ups older than 7 days, which frees their workspace addresses. Runs as part
 * of every sign-up, so an expired address is free the moment someone asks for it.
 */
async function releaseExpiredSignups(deps: AccountDeps, transaction: Transaction) {
  const { User, Workspace } = accountModels(deps.db.writer);
  const cutoff = pendingCutoff();
  await Workspace.destroy({
    where: { status: 'pending', createdAt: { [Op.lt]: cutoff } },
    transaction,
  });
  await User.destroy({
    where: { emailVerifiedAt: null, createdAt: { [Op.lt]: cutoff } },
    transaction,
  });
}

async function takenAddresses(
  deps: AccountDeps,
  candidates: string[],
  transaction?: Transaction,
): Promise<Set<string>> {
  const { Workspace } = accountModels(deps.db.writer);
  const rows = await Workspace.findAll({
    attributes: ['subdomain'],
    where: {
      subdomain: candidates,
      [Op.or]: [{ status: 'active' }, { createdAt: { [Op.gte]: pendingCutoff() } }],
    },
    ...(transaction ? { transaction } : {}),
  });
  return new Set(rows.map((row) => row.subdomain));
}

export interface AddressCheck {
  address: string;
  available: boolean;
  reason?: 'format' | 'reserved' | 'taken';
  alternatives: string[];
}

/** Live check for the sign-up form: is this workspace address free, and if not, what is? */
export async function checkAddress(deps: AccountDeps, raw: string): Promise<AddressCheck> {
  const address = raw.trim().toLowerCase();
  const problem = addressProblem(address);
  if (problem === 'format')
    return { address, available: false, reason: 'format', alternatives: [] };

  const alternatives = addressAlternatives(address);
  const taken = await takenAddresses(deps, [address, ...alternatives]);
  const free = alternatives.filter((candidate) => !taken.has(candidate)).slice(0, 3);
  if (problem === 'reserved')
    return { address, available: false, reason: 'reserved', alternatives: free };
  if (taken.has(address)) return { address, available: false, reason: 'taken', alternatives: free };
  return { address, available: true, alternatives: [] };
}

async function sendVerification(
  deps: AccountDeps,
  user: { id: string; email: string; name: string },
  workspace: { id: string; name: string; subdomain: string },
  transaction: Transaction,
) {
  const { EmailVerification } = accountModels(deps.db.writer);
  // A new link replaces any earlier one, so only the latest email works.
  await EmailVerification.destroy({ where: { userId: user.id, usedAt: null }, transaction });
  const { token, hash } = newSecretToken();
  await EmailVerification.create(
    {
      id: newId(),
      userId: user.id,
      workspaceId: workspace.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + VERIFICATION_LINK_HOURS * 60 * 60 * 1000),
      usedAt: null,
    },
    { transaction },
  );
  const link = workspaceUrl(deps.config, workspace.subdomain);
  link.pathname = '/verify-email';
  link.searchParams.set('token', token);
  return verificationEmail({
    to: user.email,
    name: user.name,
    workspaceName: workspace.name,
    link: link.href,
  });
}

export async function deliver(deps: AccountDeps, message: Parameters<EmailSender['send']>[0]) {
  try {
    await deps.email.send(message);
  } catch (error) {
    // The change is saved either way; the person can ask for the email again.
    deps.log.error({ err: error, subject: message.subject }, 'could not send email');
  }
}

/**
 * Creates a pending workspace and its owner, and emails a confirmation link. When the email already
 * has an account, it sends a "you already have an account" email instead and returns the same
 * answer, so the screen never reveals who has an account.
 */
export async function signUp(deps: AccountDeps, input: SignUpInput): Promise<{ email: string }> {
  const email = input.email.trim().toLowerCase();
  const address = input.workspaceAddress.trim().toLowerCase();
  const problem = addressProblem(address);
  if (problem) {
    throw new ValidationError('The workspace address is not allowed.', {
      fields: [
        {
          field: 'workspaceAddress',
          message:
            problem === 'reserved'
              ? 'This address is reserved.'
              : 'Use 3 to 30 lowercase letters, numbers or hyphens.',
        },
      ],
    });
  }
  if (isThrowawayEmail(email)) {
    throw new ValidationError('Use an email address you will keep.', {
      fields: [
        {
          field: 'email',
          message:
            "Please use an email address you'll keep using. Temporary email services aren't accepted.",
        },
      ],
    });
  }
  if (await deps.breachCheck(input.password)) {
    throw new ValidationError('Choose a different password.', {
      fields: [
        {
          field: 'password',
          message: 'This password has appeared in a data breach. Choose a different one.',
        },
      ],
    });
  }

  const { writer } = deps.db;
  const { User, Workspace, Membership, EmailVerification } = accountModels(writer);

  const outcome = await writer.transaction(async (transaction) => {
    await releaseExpiredSignups(deps, transaction);

    const existing = await User.findOne({ where: { email }, transaction });
    if (existing?.emailVerifiedAt) {
      await hashDecoy();
      return { kind: 'existing' as const };
    }
    if (existing) {
      // An earlier, unverified sign-up with this email (perhaps not even by its owner): replace it.
      const pending = await EmailVerification.findAll({
        attributes: ['workspaceId'],
        where: { userId: existing.id },
        transaction,
      });
      await Workspace.destroy({
        where: { id: pending.map((row) => row.workspaceId), status: 'pending' },
        transaction,
      });
      await existing.destroy({ transaction });
    }

    if ((await takenAddresses(deps, [address], transaction)).has(address)) {
      throw new ConflictError('That workspace address is taken.', {
        fields: [{ field: 'workspaceAddress', message: 'This address is already taken.' }],
        alternatives: addressAlternatives(address).slice(0, 3),
      });
    }

    const user = await User.create(
      {
        id: newId(),
        email,
        name: input.name.trim(),
        passwordHash: await hashPassword(input.password),
        emailVerifiedAt: null,
      },
      { transaction },
    );
    const workspace = await Workspace.create(
      {
        id: newId(),
        name: input.companyName.trim(),
        subdomain: address,
        timezone: input.timezone,
        status: 'pending',
        trialStartedAt: null,
      },
      { transaction },
    );
    // memberships has row-level security: write it inside the new workspace's context.
    await writer.query("SELECT set_config('app.workspace_id', :id, true)", {
      replacements: { id: workspace.id },
      transaction,
    });
    await Membership.create(
      { id: newId(), workspaceId: workspace.id, userId: user.id, role: 'admin', isOwner: true },
      { transaction },
    );
    const message = await sendVerification(deps, user, workspace, transaction);
    return { kind: 'created' as const, message };
  });

  if (outcome.kind === 'existing') {
    const signInUrl = new URL('/login', deps.config.APP_PUBLIC_URL).href;
    await deliver(deps, alreadyRegisteredEmail({ to: email, signInUrl }));
  } else {
    await deliver(deps, outcome.message);
  }
  return { email };
}

/**
 * "Resend email": sends a fresh link for a pending sign-up. Always answers the same way, so it
 * cannot be used to find out which emails have signed up.
 */
export async function resendVerification(deps: AccountDeps, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const { writer } = deps.db;
  const { User, Workspace, EmailVerification } = accountModels(writer);

  const message = await writer.transaction(async (transaction) => {
    const user = await User.findOne({ where: { email, emailVerifiedAt: null }, transaction });
    if (!user) return null;
    const latest = await EmailVerification.findOne({
      where: { userId: user.id },
      order: [['createdAt', 'DESC']],
      transaction,
    });
    if (!latest) return null;
    if (Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) return null;
    const workspace = await Workspace.findOne({
      where: { id: latest.workspaceId, status: 'pending' },
      transaction,
    });
    if (!workspace) return null;
    return sendVerification(deps, user, workspace, transaction);
  });
  if (message) await deliver(deps, message);
}

export type LinkFailure = 'invalid' | 'used' | 'expired';

/** A one-time email link (confirm email, reset password) that cannot be used, and why. */
export class LinkError extends ValidationError {
  constructor(
    public readonly failure: LinkFailure,
    public readonly email?: string,
  ) {
    super(
      failure === 'expired'
        ? 'This link has expired.'
        : failure === 'used'
          ? 'This link has already been used.'
          : 'This link is not valid.',
      email ? { reason: failure, email } : { reason: failure },
    );
  }
}

export interface VerifiedSignIn {
  user: UserRecord;
  workspace: WorkspaceRecord;
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Confirms the email from the link, activates the workspace, starts the trial and signs the owner
 * in. The link only works on its own workspace's address.
 */
export async function verifyEmail(
  deps: AccountDeps,
  token: string,
  workspaceSubdomain: string,
  meta: RequestMeta,
): Promise<VerifiedSignIn> {
  const { writer } = deps.db;
  const { User, Workspace, EmailVerification } = accountModels(writer);

  return writer.transaction(async (transaction) => {
    const verification = await EmailVerification.findOne({
      where: { tokenHash: hashToken(token) },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!verification) throw new LinkError('invalid');
    // One after another: queries in one transaction share its connection.
    const user = await User.findByPk(verification.userId, { transaction });
    const workspace = await Workspace.findByPk(verification.workspaceId, { transaction });
    if (!user || workspace?.subdomain !== workspaceSubdomain) {
      throw new LinkError('invalid');
    }
    if (verification.usedAt) throw new LinkError('used');
    if (verification.expiresAt.getTime() < Date.now()) throw new LinkError('expired', user.email);

    const now = new Date();
    await verification.update({ usedAt: now }, { transaction });
    await user.update({ emailVerifiedAt: now }, { transaction });
    await workspace.update({ status: 'active', trialStartedAt: now }, { transaction });
    const session = await createSession(
      deps,
      { userId: user.id, workspaceId: workspace.id },
      meta,
      transaction,
    );
    const owner = memberActor(user, 'admin');
    await recordAudit(
      deps.db,
      {
        workspaceId: workspace.id,
        actor: owner,
        action: 'workspace.created',
        target: { type: 'workspace', id: workspace.id, label: workspace.name },
        details: { address: workspace.subdomain },
        meta,
      },
      transaction,
    );
    await recordAudit(
      deps.db,
      {
        workspaceId: workspace.id,
        actor: owner,
        action: 'sign_in.succeeded',
        details: { method: 'email_confirmation' },
        meta,
      },
      transaction,
    );
    // Read back from the writer inside the transaction: the reader may not have these rows yet.
    return { user, workspace, sessionToken: session.token, sessionExpiresAt: session.expiresAt };
  });
}
