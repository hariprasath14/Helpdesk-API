import { literal, Op, QueryTypes } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { ticketModels } from '../tickets/models.js';
import {
  DEFAULT_EMAIL,
  NOTIFICATION_KINDS,
  notificationModels,
  type NotificationKind,
} from './models.js';

interface Deps {
  db: Database;
}

/** How long notifications are kept. */
export const KEEP_DAYS = 90;

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ticket: { number: number; subject: string } | null;
  read: boolean;
  createdAt: Date;
}

/** The unread count shown on the bell stops here ("99+"). */
export const UNREAD_MAX = 99;

async function unreadOf(deps: Deps, signedIn: SignedIn, sequelize = deps.db.writer) {
  return withWorkspace(sequelize, signedIn.workspace.id, async (transaction) => {
    const rows = await sequelize.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM (
         SELECT 1 FROM notifications
         WHERE workspace_id = :workspaceId AND user_id = :userId AND read_at IS NULL
         LIMIT ${String(UNREAD_MAX + 1)}) unread`,
      {
        replacements: { workspaceId: signedIn.workspace.id, userId: signedIn.user.id },
        type: QueryTypes.SELECT,
        transaction,
      },
    );
    return rows[0]?.count ?? 0;
  });
}

/** How many of the signed-in member's notifications are unread (up to 100), for the bell. */
export async function unreadCount(deps: Deps, signedIn: SignedIn): Promise<number> {
  requirePermission(signedIn, 'tickets.work');
  // The bell checks often; a moment's lag on the reader is fine.
  return unreadOf(deps, signedIn, deps.db.reader);
}

interface Cursor {
  at: string;
  id: string;
}

function decodeCursor(text: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof parsed.at === 'string' &&
      !Number.isNaN(Date.parse(parsed.at)) &&
      typeof parsed.id === 'string' &&
      /^[0-9a-f-]{36}$/.test(parsed.id)
    ) {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ValidationError('This page link is not valid. Reload the list.');
}

/**
 * The signed-in member's notifications, newest first, a page at a time, with their unread count.
 * Reads the writer: the list reloads right after marking some read.
 */
export async function listNotifications(
  deps: Deps,
  signedIn: SignedIn,
  page: { cursor?: string | undefined; limit: number },
): Promise<{ notifications: NotificationView[]; unread: number; nextCursor: string | null }> {
  requirePermission(signedIn, 'tickets.work');
  const { Notification } = notificationModels(deps.db.writer);
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  const rows = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const found = await Notification.findAll({
      where: {
        userId: signedIn.user.id,
        ...(after
          ? {
              [Op.and]: [
                literal(
                  `("Notification"."created_at", "Notification"."id") < (${deps.db.writer.escape(after.at)}, ${deps.db.writer.escape(after.id)})`,
                ),
              ],
            }
          : {}),
      },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: page.limit + 1,
      transaction,
    });
    const ticketIds = [...new Set(found.flatMap((row) => (row.ticketId ? [row.ticketId] : [])))];
    const tickets =
      ticketIds.length > 0
        ? await ticketModels(deps.db.writer).Ticket.findAll({
            attributes: ['id', 'number', 'subject'],
            where: { id: ticketIds },
            transaction,
          })
        : [];
    return { found, tickets: new Map(tickets.map((ticket) => [ticket.id, ticket])) };
  });
  const shown = rows.found.slice(0, page.limit);
  const last = shown.at(-1);
  return {
    notifications: shown.map((row) => {
      const ticket = row.ticketId ? rows.tickets.get(row.ticketId) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        ticket: ticket ? { number: ticket.number, subject: ticket.subject } : null,
        read: row.readAt !== null,
        createdAt: row.createdAt,
      };
    }),
    unread: await unreadOf(deps, signedIn),
    nextCursor:
      rows.found.length > page.limit && last
        ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}

/** Marks the given notifications of the signed-in member read, or all of them. Returns the unread count. */
export async function markRead(
  deps: Deps,
  signedIn: SignedIn,
  ids: string[] | undefined,
): Promise<{ unread: number }> {
  requirePermission(signedIn, 'tickets.work');
  const { Notification } = notificationModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const [changed] = await Notification.update(
      { readAt: new Date() },
      {
        where: {
          userId: signedIn.user.id,
          readAt: null,
          ...(ids ? { id: ids } : {}),
        },
        transaction,
      },
    );
    // Asking for one by id that is not yours (or does not exist) is "not found".
    if (ids?.length === 1 && changed === 0) {
      const own = await Notification.count({
        where: { id: ids, userId: signedIn.user.id },
        transaction,
      });
      if (own === 0) throw new NotFoundError('This notification does not exist.');
    }
  });
  return { unread: await unreadOf(deps, signedIn) };
}

export type EmailChoices = Record<NotificationKind, boolean>;

async function ownMembership(deps: Deps, signedIn: SignedIn) {
  const membership = await withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    accountModels(deps.db.writer).Membership.findOne({
      where: { userId: signedIn.user.id },
      transaction,
    }),
  );
  if (!membership) throw new NotFoundError();
  return membership;
}

const choicesOf = (saved: Record<string, boolean>): EmailChoices =>
  Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [
      kind,
      // A fixed table keyed by NotificationKind.
      // eslint-disable-next-line security/detect-object-injection
      new Map(Object.entries(saved)).get(kind) ?? DEFAULT_EMAIL[kind],
    ]),
  ) as EmailChoices;

/** Which notification kinds also come to the signed-in member by email, in this workspace. */
export async function emailChoices(deps: Deps, signedIn: SignedIn): Promise<EmailChoices> {
  requirePermission(signedIn, 'tickets.work');
  return choicesOf((await ownMembership(deps, signedIn)).notificationEmail);
}

/** Changes which kinds also come by email; only the kinds given change. In the app all show. */
export async function updateEmailChoices(
  deps: Deps,
  signedIn: SignedIn,
  changes: Partial<EmailChoices>,
): Promise<EmailChoices> {
  requirePermission(signedIn, 'tickets.work');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const membership = await accountModels(deps.db.writer).Membership.findOne({
      where: { userId: signedIn.user.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!membership) throw new NotFoundError();
    const next = { ...choicesOf(membership.notificationEmail), ...changes };
    await membership.update({ notificationEmail: next }, { transaction });
    return next;
  });
}

/** Removes notifications older than KEEP_DAYS in every workspace (the daily clean-up). */
export async function cleanOldNotifications(deps: Deps, now: Date = new Date()): Promise<number> {
  const rows = await deps.db.writer.query<{ removed: number }>(
    'SELECT delete_old_notifications(:before) AS removed',
    {
      replacements: { before: new Date(now.getTime() - KEEP_DAYS * 86_400_000) },
      type: QueryTypes.SELECT,
    },
  );
  return rows[0]?.removed ?? 0;
}
