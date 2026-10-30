import { Op, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { contactModels } from '../contacts/models.js';
import { ticketModels } from '../tickets/models.js';
import {
  cannedResponseModels,
  type CannedResponseModels,
  type CannedResponseRecord,
} from './models.js';
import { fillPlaceholders, unknownPlaceholders } from './placeholders.js';

/** Personal canned responses one person can have. */
export const MAX_PERSONAL = 100;
/** Shared canned responses one workspace can have. */
export const MAX_SHARED = 300;

interface Deps {
  db: Database;
}

export interface CannedResponse {
  id: string;
  title: string;
  body: string;
  shared: boolean;
  /** The signed-in person's own (personal) one. */
  mine: boolean;
  authorName: string;
  /** The signed-in person can change and delete it (their own, or shared when they manage those). */
  canEdit: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CannedResponseInput {
  title?: string | undefined;
  body?: string | undefined;
  shared?: boolean | undefined;
}

const managesShared = (signedIn: SignedIn) =>
  signedIn.permissions.includes('canned_responses.manage_shared');

async function viewsOf(
  db: Database,
  signedIn: SignedIn,
  rows: CannedResponseRecord[],
): Promise<CannedResponse[]> {
  const authorIds = [...new Set(rows.flatMap((row) => row.createdByUserId ?? []))];
  const authors =
    authorIds.length > 0
      ? await accountModels(db.writer).User.findAll({
          attributes: ['id', 'name'],
          where: { id: authorIds },
        })
      : [];
  const nameOf = new Map(authors.map((author) => [author.id, author.name]));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    shared: row.ownerUserId === null,
    mine: row.ownerUserId === signedIn.user.id,
    authorName:
      (row.createdByUserId ? nameOf.get(row.createdByUserId) : undefined) ?? 'A former member',
    canEdit:
      row.ownerUserId === signedIn.user.id || (row.ownerUserId === null && managesShared(signedIn)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

async function viewOf(db: Database, signedIn: SignedIn, row: CannedResponseRecord) {
  const [view] = await viewsOf(db, signedIn, [row]);
  if (!view) throw new NotFoundError();
  return view;
}

/** 400 naming the placeholders the body uses that do not exist. */
function checkBody(body: string) {
  const unknown = unknownPlaceholders(body);
  if (unknown.length === 0) return;
  const names = unknown.map((key) => `{{${key}}}`).join(', ');
  throw new ValidationError('Check the highlighted fields.', {
    fields: [
      {
        field: 'body',
        message: `${names} ${unknown.length === 1 ? 'is not a placeholder' : 'are not placeholders'} you can use. Pick one from the list.`,
      },
    ],
  });
}

/**
 * The signed-in person's own canned responses and every shared one, A to Z (every member). Reads
 * the writer: the list reloads right after a save.
 */
export async function listCannedResponses(
  deps: Deps,
  signedIn: SignedIn,
): Promise<CannedResponse[]> {
  requirePermission(signedIn, 'tickets.work');
  const rows = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    cannedResponseModels(deps.db.writer).CannedResponse.findAll({
      where: { [Op.or]: [{ ownerUserId: signedIn.user.id }, { ownerUserId: null }] },
      order: [['title', 'ASC']],
      transaction,
    }),
  );
  return viewsOf(deps.db, signedIn, rows);
}

/** Saves a canned response, the person's own or (canned_responses.manage_shared) shared. */
export async function createCannedResponse(
  deps: Deps,
  signedIn: SignedIn,
  input: { title: string; body: string; shared?: boolean | undefined },
): Promise<CannedResponse> {
  requirePermission(signedIn, 'tickets.work');
  if (input.shared) requirePermission(signedIn, 'canned_responses.manage_shared');
  checkBody(input.body);
  const models = cannedResponseModels(deps.db.writer);
  const ownerUserId = input.shared ? null : signedIn.user.id;
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const count = await models.CannedResponse.count({ where: { ownerUserId }, transaction });
    const max = input.shared ? MAX_SHARED : MAX_PERSONAL;
    if (count >= max) {
      throw new ConflictError(
        input.shared
          ? `The workspace can have at most ${String(MAX_SHARED)} shared canned responses. Delete one first.`
          : `You can have at most ${String(MAX_PERSONAL)} canned responses. Delete one first.`,
      );
    }
    return models.CannedResponse.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        ownerUserId,
        title: input.title,
        body: input.body,
        createdByUserId: signedIn.user.id,
      },
      { transaction },
    );
  });
  return viewOf(deps.db, signedIn, row);
}

/** One the signed-in person can see: their own or a shared one. Others' are "not found". */
async function visible(
  signedIn: SignedIn,
  models: CannedResponseModels,
  id: string,
  transaction: Transaction,
  lock = false,
) {
  const row = await models.CannedResponse.findByPk(id, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!row || (row.ownerUserId !== null && row.ownerUserId !== signedIn.user.id)) {
    throw new NotFoundError('This canned response does not exist.');
  }
  return row;
}

/** One the signed-in person may change: their own, or shared when they manage shared ones. */
async function editable(
  signedIn: SignedIn,
  models: CannedResponseModels,
  id: string,
  transaction: Transaction,
) {
  const row = await visible(signedIn, models, id, transaction, true);
  if (row.ownerUserId === null) requirePermission(signedIn, 'canned_responses.manage_shared');
  return row;
}

/**
 * Changes the title, text or sharing. Sharing your own, or making a shared one your own again,
 * needs canned_responses.manage_shared.
 */
export async function updateCannedResponse(
  deps: Deps,
  signedIn: SignedIn,
  id: string,
  changes: CannedResponseInput,
): Promise<CannedResponse> {
  requirePermission(signedIn, 'tickets.work');
  if (changes.body !== undefined) checkBody(changes.body);
  const models = cannedResponseModels(deps.db.writer);
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const response = await editable(signedIn, models, id, transaction);
    const shared = response.ownerUserId === null;
    const sharing = changes.shared !== undefined && changes.shared !== shared;
    if (sharing) requirePermission(signedIn, 'canned_responses.manage_shared');
    await response.update(
      {
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.body !== undefined ? { body: changes.body } : {}),
        ...(sharing ? { ownerUserId: changes.shared ? null : signedIn.user.id } : {}),
      },
      { transaction },
    );
    return response;
  });
  return viewOf(deps.db, signedIn, row);
}

/** Deletes one (the owner's own, or a shared one for those who manage shared ones). */
export async function deleteCannedResponse(
  deps: Deps,
  signedIn: SignedIn,
  id: string,
): Promise<void> {
  requirePermission(signedIn, 'tickets.work');
  const models = cannedResponseModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const response = await editable(signedIn, models, id, transaction);
    await response.destroy({ transaction });
  });
}

/** The text with its placeholders filled in for one ticket, ready for the composer. */
export async function fillCannedResponse(
  deps: Deps,
  signedIn: SignedIn,
  id: string,
  ticketNumber: number,
): Promise<{ body: string }> {
  requirePermission(signedIn, 'tickets.work');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const row = await visible(signedIn, cannedResponseModels(deps.db.writer), id, transaction);
    const ticket = await ticketModels(deps.db.writer).Ticket.findOne({
      where: { number: ticketNumber },
      transaction,
    });
    if (!ticket) throw new NotFoundError('This ticket does not exist.');
    const contact = await contactModels(deps.db.writer).Contact.findByPk(ticket.contactId, {
      transaction,
    });
    return {
      body: fillPlaceholders(row.body, {
        contact: { name: contact?.name ?? '', email: contact?.email ?? null },
        ticket: { number: ticket.number, subject: ticket.subject },
        agent: { name: signedIn.user.name },
        workspace: { name: signedIn.workspace.name },
      }),
    };
  });
}
