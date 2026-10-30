import { Op } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { businessHoursModels } from '../business-hours/models.js';
import { filterConditions, UNRESOLVED, type TicketFilters } from '../tickets/ticket-list.js';
import { ticketModels } from '../tickets/models.js';

interface Deps {
  db: Database;
}

/**
 * The home page's counts. Each uses the ticket list's own filters, so a count always matches the
 * list its card opens.
 */
export const HOME_COUNTS = {
  mine: { status: [...UNRESOLVED], assignee: ['me'] },
  overdue: { overdue: true },
  unassigned: { status: [...UNRESOLVED], assignee: ['none'] },
  waitingOnCustomer: { status: ['waiting_on_customer'], assignee: ['me'] },
} as const satisfies Record<string, TicketFilters>;

export type HomeCount = keyof typeof HOME_COUNTS;

export interface HomeView {
  counts: Record<HomeCount, number>;
  /** What is left to set up the workspace; null for people who cannot (only admins can). */
  setup: {
    /** Someone besides the owner joined or was invited. */
    teamInvited: boolean;
    /** A ticket came in by email. */
    emailConnected: boolean;
    /** The business hours were saved once. */
    businessHoursSet: boolean;
  } | null;
}

/** The signed-in person's home page (F29): their work and, for admins, the setup checklist. */
export async function getHome(deps: Deps, signedIn: SignedIn): Promise<HomeView> {
  requirePermission(signedIn, 'tickets.work');
  const sequelize = deps.db.reader;
  const { Ticket } = ticketModels(sequelize);
  const { Membership, Invitation } = accountModels(sequelize);
  const { BusinessHours } = businessHoursModels(sequelize);

  return withWorkspace(sequelize, signedIn.workspace.id, async (transaction) => {
    const count = (filters: TicketFilters) =>
      Ticket.count({
        where: { [Op.and]: filterConditions(sequelize, filters, signedIn.user.id) },
        transaction,
      });
    const counts = {
      mine: await count(HOME_COUNTS.mine),
      overdue: await count(HOME_COUNTS.overdue),
      unassigned: await count(HOME_COUNTS.unassigned),
      waitingOnCustomer: await count(HOME_COUNTS.waitingOnCustomer),
    };
    if (!signedIn.permissions.includes('settings.manage')) return { counts, setup: null };

    const exists = async (found: Promise<unknown>) => (await found) !== null;
    return {
      counts,
      setup: {
        teamInvited:
          (await Membership.count({ transaction })) > 1 ||
          (await exists(Invitation.findOne({ attributes: ['id'], transaction }))),
        emailConnected: await exists(
          Ticket.findOne({ attributes: ['id'], where: { source: 'email' }, transaction }),
        ),
        businessHoursSet: await exists(
          BusinessHours.findOne({ attributes: ['workspaceId'], transaction }),
        ),
      },
    };
  });
}
