import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { NotFoundError } from '../../lib/errors.js';
import type { JobQueue } from '../../jobs/queue.js';
import { accountModels, type WebFormSettings } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { workspaceUrl } from '../accounts/signup.service.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { findOrAddContact } from '../contacts/contacts.service.js';
import { tooMany } from '../email/incoming.service.js';
import { createCustomerTicket } from '../tickets/tickets.service.js';

interface Deps {
  config: Config;
  db: Database;
  jobs: Pick<JobQueue, 'enqueue'>;
  log: { info: (data: object, message: string) => void };
}

/** The page customers use, on the workspace address. */
export const WEB_FORM_PATH = '/support';

export interface PublicWebForm {
  enabled: boolean;
  workspaceName: string;
  title: string;
  intro: string;
}

export interface WebFormAdminView extends WebFormSettings {
  /** The page's address, to link to or embed. */
  url: string;
}

/** The form as the public page shows it. A workspace with the form off says only that. */
export function publicWebForm(workspace: {
  name: string;
  webForm: WebFormSettings;
}): PublicWebForm {
  const { enabled, title, intro } = workspace.webForm;
  return enabled
    ? { enabled, workspaceName: workspace.name, title, intro }
    : { enabled, workspaceName: workspace.name, title: '', intro: '' };
}

export interface WebFormSubmission {
  name: string;
  email: string;
  subject: string;
  description: string;
}

/**
 * A request sent through the public form (F16): a ticket from the person with this email (the
 * contact found or added, as for email), source "web_form", and the "request received" email
 * (F15). Refused when the form is off; dropped quietly when the same person sends too much.
 * Returns whether a ticket was made.
 */
export async function submitWebForm(
  deps: Deps,
  workspace: { id: string; name: string; webForm: WebFormSettings },
  input: WebFormSubmission,
): Promise<boolean> {
  if (!workspace.webForm.enabled) throw new NotFoundError('This form is not available.');
  const email = input.email.trim().toLowerCase();
  const made = await withWorkspace(deps.db.writer, workspace.id, async (transaction) => {
    if (await tooMany(deps, email, transaction)) return null;
    const name = input.name.trim();
    const contact = await findOrAddContact(deps, workspace.id, { name, email }, transaction, {
      skipRequired: true,
    });
    return createCustomerTicket(
      deps,
      workspace.id,
      {
        contact: { id: contact.id, companyId: contact.companyId, name },
        subject: input.subject.trim(),
        description: input.description.trim(),
        source: 'web_form',
        emailMessageId: null,
      },
      transaction,
    );
  });
  deps.log.info(
    { workspaceId: workspace.id, ticketNumber: made?.number ?? null },
    made ? 'web form ticket created' : 'web form request dropped (too many from this sender)',
  );
  return made !== null;
}

const adminView = (config: Config, workspace: { subdomain: string; webForm: WebFormSettings }) => {
  const url = workspaceUrl(config, workspace.subdomain);
  url.pathname = WEB_FORM_PATH;
  return { ...workspace.webForm, url: url.href };
};

/** Settings → Web form (admins). */
export async function webFormSettings(deps: Deps, signedIn: SignedIn): Promise<WebFormAdminView> {
  requirePermission(signedIn, 'settings.manage');
  const workspace = await accountModels(deps.db.reader).Workspace.findByPk(signedIn.workspace.id);
  if (!workspace) throw new NotFoundError('This workspace does not exist.');
  return adminView(deps.config, workspace);
}

/** Turns the form on or off, or changes its title and intro; only what is given. Audited. */
export async function updateWebFormSettings(
  deps: Deps,
  signedIn: SignedIn,
  input: Partial<WebFormSettings>,
): Promise<WebFormAdminView> {
  requirePermission(signedIn, 'settings.manage');
  const { Workspace } = accountModels(deps.db.writer);
  const saved = await deps.db.writer.transaction(async (transaction) => {
    const workspace = await Workspace.findByPk(signedIn.workspace.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!workspace) throw new NotFoundError('This workspace does not exist.');
    const current = workspace.webForm;
    const next: WebFormSettings = {
      enabled: input.enabled ?? current.enabled,
      title: input.title?.trim() ?? current.title,
      intro: input.intro?.trim() ?? current.intro,
    };
    const changed = [
      ...(next.enabled !== current.enabled ? ['enabled'] : []),
      ...(next.title !== current.title ? ['title'] : []),
      ...(next.intro !== current.intro ? ['intro'] : []),
    ];
    if (changed.length === 0) return workspace;
    await workspace.update({ webForm: next }, { transaction });
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'workspace.web_form_changed',
        target: { type: 'workspace', id: signedIn.workspace.id, label: workspace.name },
        details: {
          changed,
          ...(changed.includes('enabled') ? { enabled: next.enabled } : {}),
        },
        meta: signedIn.meta,
      },
      transaction,
    );
    return workspace;
  });
  return adminView(deps.config, saved);
}
