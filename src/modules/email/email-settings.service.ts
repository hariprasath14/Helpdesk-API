import type { EmailSender } from '../../adapters/email/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import { accountModels, type CustomerNotificationSettings } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { workspaceEmail, workspaceFrom } from './addresses.js';
import { escapeHtml } from './templates.js';
import { PRODUCT_NAME } from '../../product.js';

interface Deps {
  config: Config;
  db: Database;
  email: EmailSender;
  log: {
    info: (data: object, message: string) => void;
    warn: (data: object, message: string) => void;
  };
}

export interface EmailSettings {
  /** The name customers see; null means the workspace name. */
  senderName: string | null;
  workspaceName: string;
  /** Ticket email goes out from it, and email sent to it becomes a ticket (F14). */
  address: string;
  /** How the From line looks, for example "Acme Support" <acme@mail.helpdesk.example.com>. */
  from: string;
  /** Which emails customers get about their tickets (F15). */
  customerNotifications: CustomerNotificationSettings;
}

const toSettings = (
  config: Config,
  workspace: {
    name: string;
    subdomain: string;
    emailSenderName: string | null;
    customerNotifications: CustomerNotificationSettings;
  },
): EmailSettings => ({
  senderName: workspace.emailSenderName,
  workspaceName: workspace.name,
  address: workspaceEmail(config, workspace.subdomain),
  from: workspaceFrom(config, workspace),
  customerNotifications: workspace.customerNotifications,
});

async function loadWorkspace(deps: Pick<Deps, 'db'>, workspaceId: string) {
  const workspace = await accountModels(deps.db.reader).Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('This workspace does not exist.');
  return workspace;
}

/** Settings → Email (admins): the name and address customers see on ticket email. */
export async function emailSettings(deps: Deps, signedIn: SignedIn): Promise<EmailSettings> {
  requirePermission(signedIn, 'settings.manage');
  return toSettings(deps.config, await loadWorkspace(deps, signedIn.workspace.id));
}

/**
 * Changes the sender name (empty or null goes back to the workspace name) and which customer
 * notifications are on; only what is given changes. Each change is audited.
 */
export async function updateEmailSettings(
  deps: Deps,
  signedIn: SignedIn,
  input: {
    senderName?: string | null | undefined;
    customerNotifications?: Partial<CustomerNotificationSettings> | undefined;
  },
): Promise<EmailSettings> {
  requirePermission(signedIn, 'settings.manage');
  const { Workspace } = accountModels(deps.db.writer);
  const saved = await deps.db.writer.transaction(async (transaction) => {
    const workspace = await Workspace.findByPk(signedIn.workspace.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!workspace) throw new NotFoundError('This workspace does not exist.');
    const audit = (action: Parameters<typeof recordAudit>[1]['action'], details: object) =>
      recordAudit(
        deps.db,
        {
          workspaceId: signedIn.workspace.id,
          actor: memberActor(signedIn.user, signedIn.role),
          action,
          target: { type: 'workspace', id: signedIn.workspace.id, label: workspace.name },
          details: { ...details },
          meta: signedIn.meta,
        },
        transaction,
      );
    if (input.senderName !== undefined) {
      const senderName = input.senderName?.trim() ? input.senderName.trim() : null;
      if (workspace.emailSenderName !== senderName) {
        const from = workspace.emailSenderName;
        await workspace.update({ emailSenderName: senderName }, { transaction });
        await audit('workspace.email_sender_changed', { from, to: senderName });
      }
    }
    if (input.customerNotifications) {
      const current = workspace.customerNotifications;
      const next = { ...current, ...input.customerNotifications };
      const changed = Object.fromEntries(
        Object.entries(next).filter(
          ([key, value]) => current[key as keyof CustomerNotificationSettings] !== value,
        ),
      );
      if (Object.keys(changed).length > 0) {
        await workspace.update({ customerNotifications: next }, { transaction });
        await audit('workspace.customer_notifications_changed', changed);
      }
    }
    return workspace;
  });
  deps.log.info({ workspaceId: signedIn.workspace.id }, 'workspace email settings saved');
  // Answer from the row just written, so a lagging reader cannot show the old name.
  return toSettings(deps.config, saved);
}

/**
 * Sends a test email to the admin, from the workspace address, so they can see how customers
 * receive it. Sent straight away (not queued) so the screen can say whether it worked.
 */
export async function sendTestEmail(deps: Deps, signedIn: SignedIn): Promise<{ to: string }> {
  requirePermission(signedIn, 'settings.manage');
  const workspace = await loadWorkspace(deps, signedIn.workspace.id);
  const settings = toSettings(deps.config, workspace);
  const lines = [
    `Hi ${signedIn.user.name},`,
    '',
    `This is a test email from ${workspace.name} on ${PRODUCT_NAME}. Customers receive ticket email from ${settings.from}.`,
    '',
    `Email sent to ${settings.address} becomes a ticket.`,
  ];
  const message = {
    to: signedIn.user.email,
    from: settings.from,
    subject: `Test email from ${workspace.emailSenderName ?? workspace.name}`,
    text: lines.join('\n'),
    html: `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif;color:#212529;font-size:14px;line-height:1.5">${lines
      .filter(Boolean)
      .map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`)
      .join('')}</body></html>`,
  };
  try {
    await deps.email.send(message);
  } catch (error) {
    deps.log.warn({ err: error, workspaceId: signedIn.workspace.id }, 'test email not sent');
    throw new AppError(
      503,
      'EMAIL_NOT_SENT',
      'The test email could not be sent. Try again in a few minutes.',
    );
  }
  return { to: signedIn.user.email };
}
