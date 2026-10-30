import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { Op, QueryTypes, type Transaction } from 'sequelize';
import {
  FileTooLargeError,
  type FileStorage,
  type StoredFile,
} from '../../adapters/storage/index.js';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { conversationModels, type AttachmentRecord } from './models.js';

/** Files on one message. */
export const MAX_ATTACHMENTS = 10;
/**
 * Uploads not sent within this long are removed: the next time the same person uploads, and by the
 * worker's daily clean-up.
 */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * File types that run code when opened, refused outright. Everything else is stored and only ever
 * downloaded (never shown inside the app), and virus scanning comes before prod.
 */
export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.pif',
  '.cpl',
  '.dll',
  '.sys',
  '.ps1',
  '.psm1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.jar',
  '.sh',
  '.app',
  '.lnk',
  '.reg',
  '.msp',
  '.gadget',
  '.inf',
  '.iso',
  '.img',
]);

export interface StorageDeps {
  db: Database;
  storage: FileStorage;
  maxBytes: number;
}

export interface AttachmentView {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
}

export const attachmentView = (row: AttachmentRecord): AttachmentView => ({
  id: row.id,
  fileName: row.fileName,
  contentType: row.contentType,
  size: row.sizeBytes,
});

const storageKey = (row: { workspaceId: string; id: string }) => `${row.workspaceId}/${row.id}`;

/** A file name safe to store and show: no folders, no control characters, at most 255 long. */
export function cleanFileName(name: string): string {
  // The last segment of a path ("C:\\fakepath\\a.pdf" from some browsers).
  const base = name.split(/[\\/]/).at(-1) ?? '';
  // eslint-disable-next-line no-control-regex -- removing control characters on purpose
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  if (!clean) return 'file';
  if (clean.length <= 255) return clean;
  const ext = extname(clean).slice(0, 20);
  return clean.slice(0, 255 - ext.length) + ext;
}

/** The file is too big for ATTACHMENT_MAX_MB. */
export class AttachmentTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(
      413,
      'FILE_TOO_LARGE',
      `Files can be up to ${String(Math.round(maxBytes / 1024 / 1024))} MB.`,
    );
  }
}

/** Removes this person's uploads that were never sent (older than a day), files included. */
async function removeAbandoned(deps: StorageDeps, signedIn: SignedIn, transaction: Transaction) {
  const { TicketAttachment } = conversationModels(deps.db.writer);
  const old = await TicketAttachment.findAll({
    where: {
      uploadedByUserId: signedIn.user.id,
      ticketId: null,
      createdAt: { [Op.lt]: new Date(Date.now() - ABANDONED_AFTER_MS) },
    },
    limit: 50,
    transaction,
  });
  for (const row of old) {
    await deps.storage.remove(storageKey(row));
    await row.destroy({ transaction });
  }
}

/**
 * Stores an uploaded file for a message the person is writing (every member). It is attached
 * when the message is sent. Files that run code are refused; larger than the limit gets 413.
 */
export async function uploadAttachment(
  deps: StorageDeps,
  signedIn: SignedIn,
  file: { fileName: string; contentType: string; content: Readable },
): Promise<AttachmentView> {
  requirePermission(signedIn, 'tickets.work');
  const fileName = cleanFileName(file.fileName);
  if (BLOCKED_EXTENSIONS.has(extname(fileName).toLowerCase())) {
    file.content.resume();
    throw new ValidationError('Check the highlighted fields.', {
      fields: [
        {
          field: 'file',
          message: `${extname(fileName)} files can run programs, so they can't be attached.`,
        },
      ],
    });
  }
  const id = newId();
  const workspaceId = signedIn.workspace.id;
  let size: number;
  try {
    ({ size } = await deps.storage.put(
      storageKey({ workspaceId, id }),
      file.content,
      deps.maxBytes,
    ));
  } catch (error) {
    if (error instanceof FileTooLargeError) throw new AttachmentTooLargeError(deps.maxBytes);
    throw error;
  }
  const { TicketAttachment } = conversationModels(deps.db.writer);
  try {
    const row = await withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
      await removeAbandoned(deps, signedIn, transaction);
      return TicketAttachment.create(
        {
          id,
          workspaceId,
          ticketId: null,
          messageId: null,
          uploadedByUserId: signedIn.user.id,
          fileName,
          contentType: file.contentType.slice(0, 255) || 'application/octet-stream',
          sizeBytes: size,
        },
        { transaction },
      );
    });
    return attachmentView(row);
  } catch (error) {
    await deps.storage.remove(storageKey({ workspaceId, id }));
    throw error;
  }
}

/** Removes an upload that has not been sent yet (only the person who uploaded it). */
export async function removeUpload(
  deps: StorageDeps,
  signedIn: SignedIn,
  attachmentId: string,
): Promise<void> {
  requirePermission(signedIn, 'tickets.work');
  const { TicketAttachment } = conversationModels(deps.db.writer);
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const row = await TicketAttachment.findByPk(attachmentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    // Someone else's upload is "not found", like a file that does not exist.
    const found = row?.uploadedByUserId === signedIn.user.id ? row : null;
    if (!found) throw new NotFoundError('This file does not exist.');
    if (found.ticketId) throw new ConflictError('This file was sent with a message and stays.');
    await found.destroy({ transaction });
    return found;
  });
  await deps.storage.remove(storageKey(row));
}

/**
 * A file to download (every member, for files on a ticket's messages; the uploader for files not
 * sent yet). Reads the writer: a file can be opened right after sending.
 */
export async function downloadAttachment(
  deps: StorageDeps,
  signedIn: SignedIn,
  attachmentId: string,
): Promise<{ attachment: AttachmentView; file: StoredFile }> {
  requirePermission(signedIn, 'tickets.work');
  const { TicketAttachment } = conversationModels(deps.db.writer);
  const row = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    TicketAttachment.findByPk(attachmentId, { transaction }),
  );
  if (!row || (!row.ticketId && row.uploadedByUserId !== signedIn.user.id)) {
    throw new NotFoundError('This file does not exist.');
  }
  return { attachment: attachmentView(row), file: await deps.storage.get(storageKey(row)) };
}

/**
 * Attaches the person's uploads to a new message inside its transaction. Each id must be their
 * own upload, not yet sent; at most MAX_ATTACHMENTS.
 */
export async function attachUploads(
  db: Database,
  signedIn: SignedIn,
  ids: string[],
  target: { ticketId: string; messageId: string },
  transaction: Transaction,
): Promise<AttachmentRecord[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > MAX_ATTACHMENTS) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [
        { field: 'attachmentIds', message: `Attach at most ${String(MAX_ATTACHMENTS)} files.` },
      ],
    });
  }
  const { TicketAttachment } = conversationModels(db.writer);
  const rows = await TicketAttachment.findAll({
    where: { id: unique, uploadedByUserId: signedIn.user.id, ticketId: null },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (rows.length !== unique.length) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [{ field: 'attachmentIds', message: 'A file is missing. Upload it again.' }],
    });
  }
  for (const row of rows) await row.update(target, { transaction });
  return rows;
}

/** Workspaces cleaned per round of the daily clean-up, and uploads removed per workspace. */
const CLEAN_UP_BATCH = 200;

/**
 * The daily clean-up (the worker's clean-uploads job): every workspace's uploads that were never
 * sent, older than a day. Only workspaces that have some are visited (abandoned_upload_workspaces,
 * see the outgoing-email migration). Rows go first, then the files, so a failure never leaves a
 * row pointing at a removed file. Returns how many were removed.
 */
export async function cleanAbandonedUploads(deps: {
  db: Database;
  storage: FileStorage;
}): Promise<number> {
  const { TicketAttachment } = conversationModels(deps.db.writer);
  const before = new Date(Date.now() - ABANDONED_AFTER_MS);
  let removed = 0;
  for (;;) {
    const workspaceIds = await deps.db.writer.query<{ id: string }>(
      'SELECT abandoned_upload_workspaces AS id FROM abandoned_upload_workspaces(:before, :limit)',
      { replacements: { before, limit: CLEAN_UP_BATCH }, type: QueryTypes.SELECT },
    );
    let removedThisRound = 0;
    for (const { id: workspaceId } of workspaceIds) {
      const keys = await withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
        const old = await TicketAttachment.findAll({
          attributes: ['id', 'workspaceId'],
          where: { ticketId: null, createdAt: { [Op.lt]: before } },
          limit: CLEAN_UP_BATCH,
          transaction,
        });
        if (old.length === 0) return [];
        await TicketAttachment.destroy({
          where: { id: old.map((row) => row.id), ticketId: null },
          transaction,
        });
        return old.map(storageKey);
      });
      for (const key of keys) await deps.storage.remove(key);
      removedThisRound += keys.length;
    }
    removed += removedThisRound;
    // Done when nothing is left, or nothing could be removed (so it never loops forever).
    if (workspaceIds.length === 0 || removedThisRound === 0) return removed;
  }
}
