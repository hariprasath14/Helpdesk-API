import { Op, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { ticketModels, type SavedViewRecord, type ViewFilters } from './models.js';
import type { TicketSort } from './ticket-list.js';

/** Saved views one person can have (their own, shared ones not counted). */
export const MAX_VIEWS_PER_PERSON = 50;

interface Deps {
  db: Database;
}

export interface SavedView {
  id: string;
  name: string;
  filters: ViewFilters;
  sort: TicketSort;
  shared: boolean;
  /** The signed-in person saved it (they can change and delete it). */
  mine: boolean;
  ownerName: string;
  /** The signed-in person can change and delete it (theirs, or shared and they manage shared views). */
  canEdit: boolean;
}

/** Drops empty lists and blank search, so stored filters stay small and comparable. */
function cleanFilters(filters: ViewFilters): ViewFilters {
  const kept: [string, unknown][] = [];
  for (const [key, value] of Object.entries(filters) as [string, unknown][]) {
    if (Array.isArray(value) && value.length > 0) kept.push([key, value]);
    if (typeof value === 'string' && value.trim()) kept.push([key, value.trim()]);
    if (value === true) kept.push([key, true]);
  }
  return Object.fromEntries(kept);
}

async function viewsOf(db: Database, signedIn: SignedIn, rows: SavedViewRecord[]) {
  const owners = await accountModels(db.writer).User.findAll({
    attributes: ['id', 'name'],
    where: { id: [...new Set(rows.map((row) => row.ownerUserId))] },
  });
  const nameOf = new Map(owners.map((owner) => [owner.id, owner.name]));
  const managesShared = signedIn.permissions.includes('views.manage_shared');
  return rows.map((row): SavedView => ({
    id: row.id,
    name: row.name,
    filters: row.filters,
    sort: row.sort,
    shared: row.shared,
    mine: row.ownerUserId === signedIn.user.id,
    ownerName: nameOf.get(row.ownerUserId) ?? 'A former member',
    canEdit: row.ownerUserId === signedIn.user.id || (row.shared && managesShared),
  }));
}

/**
 * The signed-in person's own views and every shared view, A to Z (every member). Reads the
 * writer: the list reloads right after a save.
 */
export async function listViews(deps: Deps, signedIn: SignedIn): Promise<SavedView[]> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  const rows = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    models.SavedView.findAll({
      where: { [Op.or]: [{ ownerUserId: signedIn.user.id }, { shared: true }] },
      order: [['name', 'ASC']],
      transaction,
    }),
  );
  return viewsOf(deps.db, signedIn, rows);
}

export interface ViewInput {
  name?: string | undefined;
  filters?: ViewFilters | undefined;
  sort?: TicketSort | undefined;
  shared?: boolean | undefined;
}

/** Saves a view for the signed-in person; sharing it needs views.manage_shared. */
export async function createView(
  deps: Deps,
  signedIn: SignedIn,
  input: ViewInput & { name: string },
): Promise<SavedView> {
  requirePermission(signedIn, 'tickets.work');
  if (input.shared) requirePermission(signedIn, 'views.manage_shared');
  const models = ticketModels(deps.db.writer);
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const count = await models.SavedView.count({
      where: { ownerUserId: signedIn.user.id },
      transaction,
    });
    if (count >= MAX_VIEWS_PER_PERSON) {
      throw new ConflictError(
        `You can save at most ${String(MAX_VIEWS_PER_PERSON)} views. Delete one first.`,
      );
    }
    return models.SavedView.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        ownerUserId: signedIn.user.id,
        name: input.name.trim(),
        filters: cleanFilters(input.filters ?? {}),
        sort: input.sort ?? 'updated',
        shared: input.shared ?? false,
      },
      { transaction },
    );
  });
  const [view] = await viewsOf(deps.db, signedIn, [row]);
  if (!view) throw new NotFoundError();
  return view;
}

/** A view the signed-in person may change: theirs, or a shared one when they manage shared views. */
async function editableView(
  signedIn: SignedIn,
  models: ReturnType<typeof ticketModels>,
  id: string,
  transaction: Transaction,
) {
  const row = await models.SavedView.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  // Someone else's private view is invisible, so it is "not found", not "forbidden".
  if (!row || (row.ownerUserId !== signedIn.user.id && !row.shared)) {
    throw new NotFoundError('This view does not exist.');
  }
  if (row.ownerUserId !== signedIn.user.id) requirePermission(signedIn, 'views.manage_shared');
  return row;
}

/** Changes a view: name, filters, sort, or sharing (sharing needs views.manage_shared). */
export async function updateView(
  deps: Deps,
  signedIn: SignedIn,
  id: string,
  changes: ViewInput,
): Promise<SavedView> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const view = await editableView(signedIn, models, id, transaction);
    if (changes.shared !== undefined && changes.shared !== view.shared) {
      if (!signedIn.permissions.includes('views.manage_shared')) throw new ForbiddenError();
    }
    await view.update(
      {
        ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
        ...(changes.filters !== undefined ? { filters: cleanFilters(changes.filters) } : {}),
        ...(changes.sort !== undefined ? { sort: changes.sort } : {}),
        ...(changes.shared !== undefined ? { shared: changes.shared } : {}),
      },
      { transaction },
    );
    return view;
  });
  const [view] = await viewsOf(deps.db, signedIn, [row]);
  if (!view) throw new NotFoundError();
  return view;
}

/** Deletes a view (the owner, or anyone who manages shared views for a shared one). */
export async function deleteView(deps: Deps, signedIn: SignedIn, id: string): Promise<void> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const view = await editableView(signedIn, models, id, transaction);
    await view.destroy({ transaction });
  });
}
