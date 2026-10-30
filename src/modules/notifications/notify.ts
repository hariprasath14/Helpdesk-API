import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { QUEUES, type JobQueue } from '../../jobs/queue.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { DEFAULT_EMAIL, notificationModels, type NotificationKind } from './models.js';

/** Something members are told about a ticket. */
export interface MemberNotice {
  workspaceId: string;
  ticketId: string;
  kind: NotificationKind;
  /** Who is told; anyone no longer active in the workspace is skipped. */
  userIds: string[];
  /** The headline, also the email's subject, for example "Ticket #42 is overdue". */
  subject: string;
  /** What happened, in a sentence or two. */
  text: string;
}

const TITLE_MAX = 300;
const BODY_MAX = 1000;
const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Tells members about a ticket, inside the caller's transaction (which works in the notice's
 * workspace), so nobody hears about a change that was not saved. Each active member gets a
 * notification in the app (F25); those who chose email for this kind also get an email: the
 * member-notice email, or the caller's own (`email`, for example the "assigned to you" email).
 */
export async function notifyMembers(
  deps: { db: Database; jobs: Pick<JobQueue, 'enqueue'> },
  notice: MemberNotice,
  transaction: Transaction,
  options: { email?: (userIds: string[]) => Promise<void> } = {},
): Promise<void> {
  const userIds = [...new Set(notice.userIds)];
  if (userIds.length === 0) return;
  const members = await accountModels(deps.db.writer).Membership.findAll({
    attributes: ['userId', 'notificationEmail'],
    where: { workspaceId: notice.workspaceId, userId: userIds, status: 'active' },
    transaction,
  });
  if (members.length === 0) return;
  await notificationModels(deps.db.writer).Notification.bulkCreate(
    members.map((member) => ({
      id: newId(),
      workspaceId: notice.workspaceId,
      userId: member.userId,
      kind: notice.kind,
      ticketId: notice.ticketId,
      title: cut(notice.subject, TITLE_MAX),
      body: cut(notice.text, BODY_MAX),
      readAt: null,
    })),
    { transaction },
  );
  const byEmail = members
    .filter((member) => ({ ...DEFAULT_EMAIL, ...member.notificationEmail })[notice.kind])
    .map((member) => member.userId);
  if (byEmail.length === 0) return;
  if (options.email) await options.email(byEmail);
  else {
    await deps.jobs.enqueue(QUEUES.memberNotice, { ...notice, userIds: byEmail }, transaction);
  }
}
