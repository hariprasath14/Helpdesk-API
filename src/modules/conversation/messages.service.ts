import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { QUEUES, type JobQueue } from '../../jobs/queue.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { contactModels } from '../contacts/models.js';
import { notifyMembers } from '../notifications/notify.js';
import { updateSla } from '../sla/sla.service.js';
import { ticketModels, type TicketStatus } from '../tickets/models.js';
import {
  applyTicketChanges,
  lockTicketForChange,
  ticketIdForNumber,
  afterMemberChange,
} from '../tickets/tickets.service.js';
import { attachmentView, attachUploads, type AttachmentView } from './attachments.service.js';
import { messageIdFor } from '../email/addresses.js';
import { conversationModels, type EmailStatus, type MessageKind } from './models.js';

export const BODY_MAX = 20_000;
export const MAX_RECIPIENTS = 10;
export const MAX_MENTIONS = 20;

interface Deps {
  config: Config;
  db: Database;
  jobs: JobQueue;
}

export interface MessageView {
  id: string;
  kind: MessageKind;
  body: string;
  /** Sanitized HTML of customer emails (F14); null for messages written here. */
  bodyHtml: string | null;
  author:
    | { type: 'member'; userId: string; name: string }
    | { type: 'contact'; contactId: string; name: string }
    | { type: 'rule'; name: string }
    | null;
  to: string[];
  cc: string[];
  mentions: { userId: string; name: string }[];
  emailStatus: EmailStatus | null;
  emailSentAt: Date | null;
  /** Why the last try failed (shown with "Couldn't send"). */
  emailError: string | null;
  attachments: AttachmentView[];
  /** Moved in by a merge (F28): the ticket it came from. */
  fromTicketNumber: number | null;
  createdAt: Date;
}

/** A ticket's conversation: its messages, and the files that came with the email that raised it. */
export interface Conversation {
  messages: MessageView[];
  descriptionFiles: AttachmentView[];
}

/**
 * A ticket's conversation, oldest first (every member). The first message, the description, is
 * on the ticket itself. Reads the writer: the page reloads it right after sending.
 */
export async function listMessages(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
): Promise<Conversation> {
  requirePermission(signedIn, 'tickets.work');
  const { TicketMessage, TicketAttachment } = conversationModels(deps.db.writer);
  const { messages, files, contacts } = await withWorkspace(
    deps.db.writer,
    signedIn.workspace.id,
    async (transaction) => {
      const ticketId = await ticketIdForNumber(deps, number, transaction);
      const rows = await TicketMessage.findAll({
        where: { ticketId },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
        limit: 1000,
        transaction,
      });
      const contactIds = [
        ...new Set(rows.flatMap((row) => (row.authorContactId ? [row.authorContactId] : []))),
      ];
      return {
        messages: rows,
        files: await TicketAttachment.findAll({
          where: { ticketId },
          order: [['createdAt', 'ASC']],
          transaction,
        }),
        contacts:
          contactIds.length > 0
            ? await contactModels(deps.db.writer).Contact.findAll({
                attributes: ['id', 'name'],
                where: { id: contactIds },
                transaction,
              })
            : [],
      };
    },
  );
  const userIds = [
    ...new Set(
      messages.flatMap((row) => [
        ...(row.authorUserId ? [row.authorUserId] : []),
        ...row.mentionedUserIds,
      ]),
    ),
  ];
  const users =
    userIds.length > 0
      ? await accountModels(deps.db.writer).User.findAll({
          attributes: ['id', 'name'],
          where: { id: userIds },
        })
      : [];
  const userName = new Map(users.map((user) => [user.id, user.name]));
  const contactName = new Map(contacts.map((contact) => [contact.id, contact.name]));

  const views = messages.map((row) => ({
    id: row.id,
    kind: row.kind,
    body: row.bodyText,
    bodyHtml: row.bodyHtml,
    author: row.authorUserId
      ? {
          type: 'member' as const,
          userId: row.authorUserId,
          name: userName.get(row.authorUserId) ?? 'A former member',
        }
      : row.authorContactId
        ? {
            type: 'contact' as const,
            contactId: row.authorContactId,
            name: contactName.get(row.authorContactId) ?? 'Unknown contact',
          }
        : row.authorName
          ? { type: 'rule' as const, name: row.authorName }
          : null,
    to: row.toEmails,
    cc: row.ccEmails,
    mentions: row.mentionedUserIds.map((userId) => ({
      userId,
      name: userName.get(userId) ?? 'A former member',
    })),
    emailStatus: row.emailStatus,
    emailSentAt: row.emailSentAt ?? null,
    emailError: row.emailStatus === 'failed' ? (row.emailError ?? null) : null,
    attachments: files.filter((file) => file.messageId === row.id).map(attachmentView),
    fromTicketNumber: row.fromTicketNumber ?? null,
    createdAt: row.createdAt,
  }));
  return {
    messages: views,
    descriptionFiles: files.filter((file) => file.messageId === null).map(attachmentView),
  };
}

export interface MessageInput {
  kind: 'reply' | 'note' | 'forward';
  body: string;
  /** Replies: copies to these addresses besides the requester. */
  cc?: string[] | undefined;
  /** Forwards: who gets it. */
  to?: string[] | undefined;
  /** Notes: members called out with @ (notified with F25). */
  mentions?: string[] | undefined;
  attachmentIds?: string[] | undefined;
  /** Replies and notes: set the ticket's status at the same time ("send and set Pending"). */
  status?: TicketStatus | undefined;
}

interface Problem {
  field: string;
  message: string;
}

/** Addresses lowercased, each once; problems for repeats and too many. */
function recipients(list: string[] | undefined, field: string, problems: Problem[]): string[] {
  const clean = [...new Set((list ?? []).map((email) => email.trim().toLowerCase()))];
  if (clean.length > MAX_RECIPIENTS) {
    problems.push({ field, message: `Add at most ${String(MAX_RECIPIENTS)} addresses.` });
  }
  return clean;
}

/**
 * Adds a reply, note or forward to a ticket (every member). A reply goes to the requester's main
 * email (plus copies) and needs one; a forward needs at least one address. Replies and forwards
 * are queued for sending (F13 sends them). The first reply sets the ticket's first response
 * time. A status given with a reply or note changes the ticket in the same save, with the same
 * checks as changing it directly. Returns the conversation, read from the writer.
 */
export async function postMessage(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
  input: MessageInput,
): Promise<Conversation> {
  requirePermission(signedIn, 'tickets.work');
  const body = input.body.trim();
  const problems: Problem[] = [];
  const cc = input.kind === 'reply' ? recipients(input.cc, 'cc', problems) : [];
  const forwardTo = input.kind === 'forward' ? recipients(input.to, 'to', problems) : [];
  if (input.kind === 'forward' && forwardTo.length === 0) {
    problems.push({ field: 'to', message: 'Add who to forward this ticket to.' });
  }
  if (!body && (input.attachmentIds ?? []).length === 0) {
    problems.push({ field: 'body', message: 'Write a message or attach a file.' });
  }
  if (input.kind === 'forward' && input.status) {
    problems.push({ field: 'status', message: 'Change the status with a reply or a note.' });
  }
  const mentions = input.kind === 'note' ? [...new Set(input.mentions ?? [])] : [];
  if (mentions.length > MAX_MENTIONS) {
    problems.push({
      field: 'mentions',
      message: `Mention at most ${String(MAX_MENTIONS)} people.`,
    });
  }

  const models = ticketModels(deps.db.writer);
  const { TicketMessage } = conversationModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticket = await lockTicketForChange(models, number, transaction);
    let to = forwardTo;
    if (input.kind === 'reply') {
      const requester = await contactModels(deps.db.writer).Contact.findByPk(ticket.contactId, {
        attributes: ['email'],
        transaction,
      });
      if (!requester?.email) {
        throw new ConflictError(
          'The requester has no email address. Add one to the contact, or log a note.',
        );
      }
      to = [requester.email];
      if (cc.includes(requester.email)) {
        problems.push({ field: 'cc', message: 'The requester already gets the reply.' });
      }
    }
    if (mentions.length > 0) {
      const { Membership } = accountModels(deps.db.writer);
      const found = await Membership.count({
        where: { userId: mentions, status: 'active' },
        transaction,
      });
      if (found !== mentions.length) {
        problems.push({ field: 'mentions', message: 'You can only mention active members.' });
      }
    }
    if (problems.length > 0) {
      throw new ValidationError('Check the highlighted fields.', { fields: problems });
    }

    const message = await TicketMessage.create(
      {
        id: newId(),
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        kind: input.kind,
        bodyText: body,
        bodyHtml: null,
        authorUserId: signedIn.user.id,
        authorContactId: null,
        toEmails: to,
        // The ticket's standing copies (F28, requesters of merged tickets) join every reply.
        ccEmails:
          input.kind === 'reply'
            ? [...new Set([...cc, ...ticket.ccEmails])].filter((email) => !to.includes(email))
            : cc,
        mentionedUserIds: mentions,
        emailStatus: input.kind === 'note' ? null : 'queued',
      },
      { transaction },
    );
    if (input.kind !== 'note') {
      await message.update(
        { emailMessageId: messageIdFor(deps.config, message.id) },
        { transaction },
      );
      await deps.jobs.enqueue(
        QUEUES.ticketEmail,
        { workspaceId: ticket.workspaceId, messageId: message.id },
        transaction,
      );
    }
    await attachUploads(
      deps.db,
      signedIn,
      input.attachmentIds ?? [],
      { ticketId: ticket.id, messageId: message.id },
      transaction,
    );
    // The people @mentioned in a note are told (F25), not the one who wrote it.
    await notifyMembers(
      deps,
      {
        workspaceId: ticket.workspaceId,
        ticketId: ticket.id,
        kind: 'mention',
        userIds: mentions.filter((userId) => userId !== signedIn.user.id),
        subject: `${signedIn.user.name} mentioned you on ticket #${String(ticket.number)}`,
        text: body,
      },
      transaction,
    );
    if (input.status && input.status !== ticket.status) {
      const previousStatus = ticket.status;
      const made = await applyTicketChanges(
        deps,
        signedIn,
        ticket,
        { status: input.status },
        transaction,
      );
      await afterMemberChange(deps, ticket, made, previousStatus, transaction);
    }
    const firstReply = input.kind === 'reply' && !ticket.firstResponseAt;
    if (firstReply) ticket.firstResponseAt = new Date();
    // A new message moves the ticket up the "last updated" lists.
    ticket.changed('updatedAt', true);
    await ticket.save({ transaction });
    // The first reply meets (or misses) the reply target; the resolve time runs on (F23, F24).
    if (firstReply) {
      await updateSla(deps, ticket, transaction, {
        status: ticket.status,
        priority: ticket.priority,
        statusChangedAt: ticket.statusChangedAt,
      });
    }
  });
  return listMessages(deps, signedIn, number);
}

/**
 * Sends a reply or forward that could not be sent, again (every member). Only failed ones: a
 * queued email is still being tried. Returns the conversation.
 */
export async function resendMessage(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
  messageId: string,
): Promise<Conversation> {
  requirePermission(signedIn, 'tickets.work');
  const { TicketMessage } = conversationModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const ticketId = await ticketIdForNumber(deps, number, transaction);
    const message = await TicketMessage.findOne({
      where: { id: messageId, ticketId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!message || message.kind === 'note' || message.kind === 'customer') {
      throw new NotFoundError('This message does not exist.');
    }
    if (message.emailStatus !== 'failed') {
      throw new ConflictError('Only an email that could not be sent can be sent again.');
    }
    await message.update({ emailStatus: 'queued', emailError: null }, { transaction });
    await deps.jobs.enqueue(
      QUEUES.ticketEmail,
      { workspaceId: message.workspaceId, messageId: message.id },
      transaction,
    );
  });
  return listMessages(deps, signedIn, number);
}
