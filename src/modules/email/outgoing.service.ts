import type { Readable } from 'node:stream';
import { Op } from 'sequelize';
import type { EmailAttachment, EmailMessage, EmailSender } from '../../adapters/email/index.js';
import type { FileStorage } from '../../adapters/storage/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { accountModels } from '../accounts/models.js';
import { workspaceUrl } from '../accounts/signup.service.js';
import { contactModels } from '../contacts/models.js';
import { conversationModels } from '../conversation/models.js';
import type { MemberNotice } from '../notifications/notify.js';
import { teamModels } from '../teams/models.js';
import { ticketModels } from '../tickets/models.js';
import { newId } from '../../lib/tokens.js';
import { messageIdFor, ticketReplyAddress, workspaceFrom } from './addresses.js';
import {
  assignmentEmail,
  customerNotificationBodies,
  memberNoticeEmail,
  ruleNoticeEmail,
  ticketEmailBodies,
  type CustomerEmailEvent,
  type Quoted,
} from './templates.js';

/** Files on one email, together; larger sets send the rest by name only. */
export const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Earlier messages quoted under a forward. */
const FORWARD_QUOTES = 10;
/** Message-IDs carried in References (the most recent ones). */
const MAX_REFERENCES = 10;

export interface OutgoingDeps {
  config: Config;
  db: Database;
  email: EmailSender;
  storage: FileStorage;
}

/** Which try this is, from the job (pg-boss counts retries from 0). */
export interface Attempt {
  retryCount: number;
  retryLimit: number;
}

const subjectFor = (kind: 'reply' | 'forward', subject: string, number: number) =>
  `${kind === 'reply' ? 'Re' : 'Fwd'}: ${subject} [#${String(number)}]`;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** The ticket email for a queued reply or forward, read inside its workspace. */
async function compose(deps: OutgoingDeps, workspaceId: string, messageId: string) {
  const { Workspace, User } = accountModels(deps.db.writer);
  const workspace = await Workspace.findByPk(workspaceId);
  if (!workspace) return null;
  const found = await withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
    const { TicketMessage, TicketAttachment } = conversationModels(deps.db.writer);
    const message = await TicketMessage.findByPk(messageId, { transaction });
    if (!message || (message.kind !== 'reply' && message.kind !== 'forward')) return null;
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(message.ticketId, {
      transaction,
    });
    if (!ticket) return null;
    const requester = await contactModels(deps.db.writer).Contact.findByPk(ticket.contactId, {
      attributes: ['name'],
      transaction,
    });
    const earlier = await TicketMessage.findAll({
      where: {
        ticketId: ticket.id,
        kind: ['reply', 'forward', 'customer'],
        createdAt: { [Op.lt]: message.createdAt },
      },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    const files = await TicketAttachment.findAll({ where: { messageId }, transaction });
    // Replies a rule writes (F19) get their Message-ID here, so later replies thread under them.
    if (!message.emailMessageId) {
      await message.update(
        { emailMessageId: messageIdFor(deps.config, message.id) },
        { transaction },
      );
    }
    return { message, ticket, requester, earlier, files };
  });
  if (!found) return null;
  const { message, ticket, requester, earlier, files } = found;

  const people = await User.findAll({
    attributes: ['id', 'name'],
    where: {
      id: [message.authorUserId, ...earlier.map((row) => row.authorUserId)].filter(
        (id): id is string => id !== null,
      ),
    },
  });
  const nameOf = (userId: string | null, contact = requester?.name ?? 'The customer') =>
    userId ? (people.find((person) => person.id === userId)?.name ?? 'Support') : contact;

  // What the customer last saw or wrote: the latest earlier message, or the description.
  const history: Quoted[] = [
    { author: requester?.name ?? 'The customer', at: ticket.createdAt, text: ticket.description },
    ...earlier
      .filter((row) => row.kind !== 'forward')
      .map((row) => ({ author: nameOf(row.authorUserId), at: row.createdAt, text: row.bodyText })),
  ].filter((item) => item.text.trim() !== '');
  const quoted =
    message.kind === 'forward' ? history.slice(-FORWARD_QUOTES).reverse() : history.slice(-1);

  const attachments: EmailAttachment[] = [];
  const notAttached: string[] = [];
  let total = 0;
  for (const file of files) {
    const stored =
      total + file.sizeBytes <= MAX_EMAIL_ATTACHMENT_BYTES
        ? await deps.storage.get(`${workspaceId}/${file.id}`)
        : null;
    if (stored && 'stream' in stored) {
      attachments.push({
        filename: file.fileName,
        content: await readAll(stored.stream),
        contentType: file.contentType,
      });
      total += file.sizeBytes;
    } else {
      notAttached.push(file.fileName);
    }
  }

  const senderName = workspace.emailSenderName ?? workspace.name;
  // The email that raised the ticket (F14) first, then every earlier message that was an email.
  const references = [
    ...(ticket.emailMessageId ? [ticket.emailMessageId] : []),
    ...earlier.flatMap((row) => (row.emailMessageId ? [row.emailMessageId] : [])),
  ].slice(-MAX_REFERENCES);
  const email: EmailMessage = {
    to: message.toEmails[0] ?? '',
    cc: [...message.toEmails.slice(1), ...message.ccEmails],
    from: workspaceFrom(deps.config, workspace),
    replyTo: ticketReplyAddress(deps.config, workspace, ticket.number),
    subject: subjectFor(
      message.kind === 'forward' ? 'forward' : 'reply',
      ticket.subject,
      ticket.number,
    ),
    ...(message.emailMessageId ? { messageId: message.emailMessageId } : {}),
    ...(references.length > 0 ? { inReplyTo: references.at(-1), references } : {}),
    attachments,
    ...ticketEmailBodies({
      body: message.bodyText,
      // A rule's reply is signed by the workspace alone, not "Rule: <name>".
      agentName: message.authorUserId ? nameOf(message.authorUserId) : senderName,
      senderName,
      ticketNumber: ticket.number,
      timeZone: workspace.timezone,
      quoted,
      ...(message.kind === 'forward'
        ? { forwardedHeading: `Forwarded ticket #${String(ticket.number)}: ${ticket.subject}` }
        : {}),
      notAttached,
    }),
  };
  return { email, alreadySent: message.emailStatus === 'sent' };
}

/** Saves how a send went on the message. */
async function record(
  deps: OutgoingDeps,
  workspaceId: string,
  messageId: string,
  changes: { emailStatus?: 'sent' | 'failed'; emailSentAt?: Date; emailError: string | null },
) {
  const { TicketMessage } = conversationModels(deps.db.writer);
  await withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
    const message = await TicketMessage.findByPk(messageId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!message) return;
    await message.update({ ...changes, emailAttempts: message.emailAttempts + 1 }, { transaction });
  });
}

/**
 * Sends one queued reply or forward (the ticket-email job). Sending twice is avoided: a message
 * already sent is skipped. A failed send is retried by the queue; after the last try the message
 * is marked failed with the reason, and the ticket shows "Couldn't send" with Retry.
 */
export async function sendTicketEmail(
  deps: OutgoingDeps,
  job: { workspaceId: string; messageId: string },
  attempt: Attempt,
  log: { warn: (data: object, message: string) => void },
): Promise<void> {
  const composed = await compose(deps, job.workspaceId, job.messageId);
  if (!composed || composed.alreadySent) return;
  try {
    await deps.email.send(composed.email);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const last = attempt.retryCount >= attempt.retryLimit;
    log.warn({ err: error, ...job, attempt: attempt.retryCount, last }, 'ticket email not sent');
    await record(deps, job.workspaceId, job.messageId, {
      ...(last ? { emailStatus: 'failed' as const } : {}),
      emailError: reason,
    });
    if (!last) throw error;
    return;
  }
  await record(deps, job.workspaceId, job.messageId, {
    emailStatus: 'sent',
    emailSentAt: new Date(),
    emailError: null,
  });
}

/**
 * Emails a member that a ticket is now theirs (the assignment-email job). Skipped when the
 * ticket has moved on to someone else meanwhile, or the person is no longer active.
 */
export async function sendAssignmentEmail(
  deps: OutgoingDeps,
  job: { workspaceId: string; ticketId: string; assigneeUserId: string; assignedBy: string },
): Promise<void> {
  const { Workspace, User, Membership } = accountModels(deps.db.writer);
  const workspace = await Workspace.findByPk(job.workspaceId);
  if (!workspace) return;
  const found = await withWorkspace(deps.db.writer, job.workspaceId, async (transaction) => ({
    ticket: await ticketModels(deps.db.writer).Ticket.findByPk(job.ticketId, { transaction }),
    membership: await Membership.findOne({
      where: { userId: job.assigneeUserId, status: 'active' },
      transaction,
    }),
  }));
  if (!found.ticket || !found.membership || found.ticket.assigneeUserId !== job.assigneeUserId) {
    return;
  }
  const person = await User.findByPk(job.assigneeUserId, { attributes: ['name', 'email'] });
  if (!person) return;
  const link = workspaceUrl(deps.config, workspace.subdomain);
  link.pathname = `/tickets/${String(found.ticket.number)}`;
  await deps.email.send(
    assignmentEmail({
      to: person.email,
      name: person.name,
      assignedBy: job.assignedBy,
      workspaceName: workspace.name,
      ticketNumber: found.ticket.number,
      subject: found.ticket.subject,
      link: link.href,
    }),
  );
}

/**
 * Tells the requester what happened to their ticket (the customer-email job, F15): received,
 * resolved, or opened for them by an agent. Sent only if that notification is on when it goes
 * out, the ticket is not deleted, a "resolved" ticket is still resolved, and the requester has an
 * email that is not a workspace address. It threads with the ticket's email and carries the
 * signed reply address, so an answer lands on the ticket (and reopens it, F14).
 */
export async function sendCustomerEmail(
  deps: OutgoingDeps,
  job: {
    workspaceId: string;
    ticketId: string;
    event: CustomerEmailEvent;
    agentName?: string;
    /** For merged (F28): the main ticket's number; replies go to it. */
    mergedInto?: number;
  },
): Promise<void> {
  const { Workspace } = accountModels(deps.db.writer);
  const workspace = await Workspace.findByPk(job.workspaceId);
  if (!workspace) return;
  // A merge email is sent when the member chose it; the others follow the workspace setting.
  if (job.event !== 'merged' && !workspace.customerNotifications[job.event]) return;
  const found = await withWorkspace(deps.db.writer, job.workspaceId, async (transaction) => {
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(job.ticketId, {
      transaction,
    });
    if (!ticket || ticket.deletedAt) return null;
    const requester = await contactModels(deps.db.writer).Contact.findByPk(ticket.contactId, {
      attributes: ['name', 'email'],
      transaction,
    });
    const lastEmail = await conversationModels(deps.db.writer).TicketMessage.findOne({
      attributes: ['emailMessageId'],
      where: { ticketId: ticket.id, emailMessageId: { [Op.ne]: null } },
      order: [['createdAt', 'DESC']],
      transaction,
    });
    return { ticket, requester, lastEmail };
  });
  if (!found?.requester?.email) return;
  const { ticket, requester, lastEmail } = found;
  if (job.event === 'resolved' && ticket.status !== 'resolved') return;
  if (requester.email?.endsWith(`@${deps.config.TICKET_EMAIL_DOMAIN}`)) return;

  const senderName = workspace.emailSenderName ?? workspace.name;
  const references = [
    ...new Set(
      [ticket.emailMessageId, lastEmail?.emailMessageId].filter(
        (id): id is string => typeof id === 'string',
      ),
    ),
  ];
  const ref = `[#${String(ticket.number)}]`;
  await deps.email.send({
    to: requester.email ?? '',
    from: workspaceFrom(deps.config, workspace),
    replyTo: ticketReplyAddress(deps.config, workspace, job.mergedInto ?? ticket.number),
    subject:
      job.event === 'agentCreated' ? `${ticket.subject} ${ref}` : `Re: ${ticket.subject} ${ref}`,
    messageId: messageIdFor(deps.config, newId()),
    ...(references.length > 0 ? { inReplyTo: references.at(-1), references } : {}),
    ...customerNotificationBodies({
      event: job.event,
      customerName: requester.name,
      senderName,
      ticketNumber: ticket.number,
      subject: ticket.subject,
      agentName: job.agentName,
      mergedInto: job.mergedInto,
    }),
  });
}

/**
 * A rule's email to the team (the team-email job, F19): to the ticket's assignee, or its team's
 * leads, when they are active members. Nothing is sent when nobody fits or the ticket is gone.
 */
/**
 * Sends a member notice (F24): to each of the members still active in the workspace, with a link
 * to the ticket. Nothing when the ticket is gone or deleted.
 */
export async function sendMemberNotice(deps: OutgoingDeps, job: MemberNotice): Promise<void> {
  const { Workspace, User, Membership } = accountModels(deps.db.writer);
  const workspace = await Workspace.findByPk(job.workspaceId);
  if (!workspace) return;
  const found = await withWorkspace(deps.db.writer, job.workspaceId, async (transaction) => {
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(job.ticketId, {
      transaction,
    });
    if (!ticket || ticket.deletedAt) return null;
    const active = await Membership.findAll({
      attributes: ['userId'],
      where: { workspaceId: job.workspaceId, userId: job.userIds, status: 'active' },
      transaction,
    });
    return { ticket, userIds: active.map((membership) => membership.userId) };
  });
  if (!found || found.userIds.length === 0) return;
  const people = await User.findAll({
    attributes: ['name', 'email'],
    where: { id: found.userIds },
  });
  const link = workspaceUrl(deps.config, workspace.subdomain);
  link.pathname = `/tickets/${String(found.ticket.number)}`;
  for (const person of people) {
    await deps.email.send(
      memberNoticeEmail({
        to: person.email,
        name: person.name,
        subject: job.subject,
        text: job.text,
        workspaceName: workspace.name,
        ticketNumber: found.ticket.number,
        ticketSubject: found.ticket.subject,
        link: link.href,
      }),
    );
  }
}

export async function sendTeamEmail(
  deps: OutgoingDeps,
  job: {
    workspaceId: string;
    ticketId: string;
    to: 'assignee' | 'team_leads';
    ruleName: string;
    text: string;
  },
): Promise<void> {
  const { Workspace, User, Membership } = accountModels(deps.db.writer);
  const workspace = await Workspace.findByPk(job.workspaceId);
  if (!workspace) return;
  const found = await withWorkspace(deps.db.writer, job.workspaceId, async (transaction) => {
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(job.ticketId, {
      transaction,
    });
    if (!ticket || ticket.deletedAt) return null;
    let userIds: string[] = [];
    if (job.to === 'assignee') {
      userIds = ticket.assigneeUserId ? [ticket.assigneeUserId] : [];
    } else if (ticket.teamId) {
      const leads = await teamModels(deps.db.writer).TeamMember.findAll({
        attributes: ['userId'],
        where: { teamId: ticket.teamId, isLead: true },
        transaction,
      });
      userIds = leads.map((lead) => lead.userId);
    }
    const active =
      userIds.length > 0
        ? await Membership.findAll({
            attributes: ['userId'],
            where: { workspaceId: job.workspaceId, userId: userIds, status: 'active' },
            transaction,
          })
        : [];
    return { ticket, userIds: active.map((membership) => membership.userId) };
  });
  if (!found || found.userIds.length === 0) return;
  const people = await User.findAll({
    attributes: ['name', 'email'],
    where: { id: found.userIds },
  });
  const link = workspaceUrl(deps.config, workspace.subdomain);
  link.pathname = `/tickets/${String(found.ticket.number)}`;
  for (const person of people) {
    await deps.email.send(
      ruleNoticeEmail({
        to: person.email,
        name: person.name,
        ruleName: job.ruleName,
        text: job.text,
        workspaceName: workspace.name,
        ticketNumber: found.ticket.number,
        subject: found.ticket.subject,
        link: link.href,
      }),
    );
  }
}
