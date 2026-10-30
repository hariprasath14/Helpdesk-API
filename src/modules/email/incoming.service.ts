import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from 'mailparser';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import type { FileStorage } from '../../adapters/storage/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import type { JobQueue } from '../../jobs/queue.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { findOrAddContact } from '../contacts/contacts.service.js';
import { contactModels } from '../contacts/models.js';
import {
  BLOCKED_EXTENSIONS,
  cleanFileName,
  MAX_ATTACHMENTS,
} from '../conversation/attachments.service.js';
import { BODY_MAX } from '../conversation/messages.service.js';
import { conversationModels } from '../conversation/models.js';
import { ticketModels, type TicketRecord } from '../tickets/models.js';
import { notifyMembers } from '../notifications/notify.js';
import { runRules } from '../rules/engine.js';
import { createCustomerTicket, reopenForCustomer } from '../tickets/tickets.service.js';
import { readTicketAddress } from './addresses.js';
import { REPLY_ABOVE_LINE } from './templates.js';

/** Emails one sender may send one workspace in an hour; more are dropped (a mail loop). */
export const MAX_EMAILS_PER_SENDER_HOUR = 20;
/** Inline images smaller than this are signatures and logos, not something the customer sent. */
const SMALL_INLINE_IMAGE_BYTES = 10 * 1024;
const SUBJECT_MAX = 200;

export interface IncomingDeps {
  config: Config;
  db: Database;
  storage: FileStorage;
  /** Adds the "we received your request" email (F15). */
  jobs: Pick<JobQueue, 'enqueue'>;
}

export type Outcome =
  | { result: 'ticket' | 'reply'; workspaceId: string; ticketNumber: number }
  | { result: 'duplicate'; workspaceId: string }
  | { result: 'ignored'; reason: string };

const addressesOf = (field: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(field) ? field : field ? [field] : [])
    .flatMap((object) => object.value)
    .flatMap((entry) => entry.group ?? [entry])
    .flatMap((entry) => (entry.address ? [entry.address.trim().toLowerCase()] : []));

/** A header as text (address headers by their text, structured ones by their main value). */
const header = (parsed: ParsedMail, name: string): string => {
  const value: unknown = parsed.headers.get(name);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('text' in value) return String(value.text);
    if ('value' in value) return String(value.value);
  }
  return '';
};

/**
 * Why an email must not become a ticket: it was sent by a machine (an auto-reply, a bounce, bulk
 * mail) or by us. Answering those is how mail loops start. Mailing lists are allowed: a company's
 * support@ is often a group that forwards to the workspace address.
 */
export function automatedReason(parsed: ParsedMail, from: string, domain: string): string | null {
  const [local = '', fromDomain = ''] = from.split('@');
  if (fromDomain === domain) return 'sent from a workspace address';
  if (['mailer-daemon', 'postmaster'].includes(local)) return 'a bounce';
  const autoSubmitted = header(parsed, 'auto-submitted').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return 'an automatic email (Auto-Submitted)';
  const precedence = header(parsed, 'precedence').trim().toLowerCase();
  if (['bulk', 'junk', 'auto_reply'].includes(precedence)) return `bulk email (${precedence})`;
  for (const name of ['x-autoreply', 'x-autorespond', 'x-autoresponse']) {
    if (header(parsed, name)) return 'an auto-reply';
  }
  if (header(parsed, 'x-loop').toLowerCase().includes(domain)) return 'a mail loop';
  if (header(parsed, 'content-type').toLowerCase().includes('multipart/report')) {
    return 'a delivery report';
  }
  return null;
}

/**
 * What the customer wrote: up to our "reply above this line" marker, without the quoted earlier
 * email under it ("On Mon, Ravi wrote:" and the "> " lines), at most BODY_MAX characters.
 */
export function customerText(text: string): string {
  let body = text.replaceAll('\r\n', '\n');
  const marker = body.indexOf(REPLY_ABOVE_LINE);
  if (marker !== -1) body = body.slice(0, marker);
  const lines = body.split('\n');
  const quotedOrBlank = (line: string) => line.trim() === '' || line.trimStart().startsWith('>');
  while (lines.length > 0 && quotedOrBlank(lines.at(-1) ?? '')) lines.pop();
  // The line that introduces the quote, which email programs may wrap onto two lines.
  const last = lines.at(-1) ?? '';
  const twoLast = `${lines.at(-2) ?? ''} ${last}`;
  if (/^On .+wrote:$/.test(last.trim())) lines.pop();
  else if (/^On .+wrote:$/.test(twoLast.trim()) && last.trim().endsWith('wrote:')) lines.splice(-2);
  body = lines.join('\n').trim();
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body;
}

const messageIdOf = (value: string | undefined) => {
  const id = value?.trim();
  return id && id.length <= 255 ? id : null;
};

/** Message-IDs this email answers: In-Reply-To first, then References from newest to oldest. */
function answers(parsed: ParsedMail): string[] {
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : (parsed.references ?? '').split(/\s+/);
  return [parsed.inReplyTo ?? '', ...references.reverse()]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 255)
    .slice(0, 50);
}

/** The files to keep: not programs, not too large, not tiny inline logos; at most 10. */
function filesToKeep(attachments: Attachment[], maxBytes: number) {
  const kept: Attachment[] = [];
  const skipped: string[] = [];
  for (const file of attachments) {
    const name = cleanFileName(file.filename ?? 'attachment');
    const inlineImage =
      file.contentDisposition === 'inline' || file.related === true
        ? file.contentType.startsWith('image/')
        : false;
    if (inlineImage && file.size < SMALL_INLINE_IMAGE_BYTES) continue;
    if (BLOCKED_EXTENSIONS.has(extname(name).toLowerCase())) skipped.push(`${name} (a program)`);
    else if (file.size > maxBytes) skipped.push(`${name} (too large)`);
    else if (kept.length >= MAX_ATTACHMENTS) skipped.push(`${name} (more than 10 files)`);
    else kept.push(file);
  }
  return { kept, skipped };
}

async function storeFiles(
  deps: IncomingDeps,
  files: Attachment[],
  target: { workspaceId: string; ticketId: string; messageId: string | null },
  transaction: Transaction,
) {
  const { TicketAttachment } = conversationModels(deps.db.writer);
  const maxBytes = deps.config.ATTACHMENT_MAX_MB * 1024 * 1024;
  for (const file of files) {
    const id = newId();
    await deps.storage.put(`${target.workspaceId}/${id}`, Readable.from(file.content), maxBytes);
    await TicketAttachment.create(
      {
        id,
        workspaceId: target.workspaceId,
        ticketId: target.ticketId,
        messageId: target.messageId,
        uploadedByUserId: null,
        fileName: cleanFileName(file.filename ?? 'attachment'),
        contentType: file.contentType.slice(0, 255) || 'application/octet-stream',
        sizeBytes: file.size,
      },
      { transaction },
    );
  }
}

/** The ticket this email answers: by Message-ID, else by the signed reply address. */
async function answeredTicket(
  deps: IncomingDeps,
  parsed: ParsedMail,
  taggedNumber: number | null,
  transaction: Transaction,
): Promise<TicketRecord | null> {
  const { Ticket } = ticketModels(deps.db.writer);
  const { TicketMessage } = conversationModels(deps.db.writer);
  const ids = answers(parsed);
  if (ids.length > 0) {
    const message = await TicketMessage.findOne({
      attributes: ['ticketId'],
      where: { emailMessageId: ids },
      order: [['createdAt', 'DESC']],
      transaction,
    });
    const ticket = message
      ? await Ticket.findByPk(message.ticketId, { transaction, lock: transaction.LOCK.UPDATE })
      : await Ticket.findOne({
          where: { emailMessageId: ids },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
    if (ticket) return ticket;
  }
  if (taggedNumber === null) return null;
  return Ticket.findOne({
    where: { number: taggedNumber },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
}

/**
 * The ticket this email answers, following merges (F28): a reply to a merged ticket's old thread
 * lands on the ticket it was merged into.
 */
async function threadOf(
  deps: IncomingDeps,
  parsed: ParsedMail,
  taggedNumber: number | null,
  transaction: Transaction,
): Promise<TicketRecord | null> {
  let ticket = await answeredTicket(deps, parsed, taggedNumber, transaction);
  // A main ticket may itself be merged later, so follow the chain; the limit is only a guard.
  for (let hop = 0; ticket?.mergedIntoId && hop < 5; hop += 1) {
    ticket = await ticketModels(deps.db.writer).Ticket.findByPk(ticket.mergedIntoId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  }
  return ticket;
}

/**
 * Whether this sender has already raised too much within the hour in this workspace (tickets from
 * email or the web form, and emailed replies): a loop with another system, or abuse.
 */
export async function tooMany(deps: { db: Database }, from: string, transaction: Transaction) {
  const known = await contactModels(deps.db.writer).ContactEmail.findOne({
    where: { email: from },
    transaction,
  });
  if (!known) return false;
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const tickets = await ticketModels(deps.db.writer).Ticket.count({
    where: {
      contactId: known.contactId,
      source: ['email', 'web_form'],
      createdAt: { [Op.gte]: since },
    },
    transaction,
  });
  const messages = await conversationModels(deps.db.writer).TicketMessage.count({
    where: { authorContactId: known.contactId, kind: 'customer', createdAt: { [Op.gte]: since } },
    transaction,
  });
  return tickets + messages >= MAX_EMAILS_PER_SENDER_HOUR;
}

/**
 * Turns one received email into a new ticket or a customer message on its ticket (F14).
 * The email reaches a workspace through its address on TICKET_EMAIL_DOMAIN (To, Cc, Bcc or the
 * envelope's Delivered-To). Replies are matched by the Message-IDs they answer, then by the signed
 * reply address; an email to a closed or deleted ticket starts a new one. The same Message-ID is
 * never added twice. Only plain text is kept (HTML is converted to text and never shown), so no
 * HTML from email reaches the app.
 */
export async function receiveEmail(deps: IncomingDeps, raw: Buffer): Promise<Outcome> {
  const parsed = await simpleParser(raw);
  const sender = parsed.from?.value[0];
  const from = sender?.address?.trim().toLowerCase();
  if (!from?.includes('@')) return { result: 'ignored', reason: 'no sender address' };
  const domain = deps.config.TICKET_EMAIL_DOMAIN;
  const automated = automatedReason(parsed, from, domain);
  if (automated) return { result: 'ignored', reason: automated };

  const recipients = [
    ...addressesOf(parsed.to),
    ...addressesOf(parsed.cc),
    ...addressesOf(parsed.bcc),
    ...[header(parsed, 'delivered-to'), header(parsed, 'x-original-to')].flatMap((value) =>
      value ? value.split(',').map((item) => item.trim().toLowerCase()) : [],
    ),
  ].filter((address) => address.endsWith(`@${domain}`));
  const subdomains = [
    ...new Set(recipients.map((address) => address.split('@')[0]?.split('+')[0] ?? '')),
  ].filter(Boolean);
  if (subdomains.length === 0) return { result: 'ignored', reason: 'no workspace address' };
  const workspaces = await accountModels(deps.db.writer).Workspace.findAll({
    attributes: ['id', 'subdomain'],
    where: { subdomain: subdomains },
  });
  const idOf = (subdomain: string) =>
    workspaces.find((workspace) => workspace.subdomain === subdomain)?.id ?? null;
  // The first address that names a workspace; a signed ticket address wins over a plain one.
  const read = recipients
    .map((address) => readTicketAddress(deps.config, address, idOf))
    .filter((item) => item !== null && idOf(item.subdomain) !== null)
    .sort((a, b) => Number(b?.ticketNumber !== null) - Number(a?.ticketNumber !== null))[0];
  const workspaceId = read ? idOf(read.subdomain) : null;
  if (!read || !workspaceId) return { result: 'ignored', reason: 'unknown workspace address' };

  const messageId = messageIdOf(parsed.messageId);
  const text = customerText(parsed.text ?? '');
  const { kept, skipped } = filesToKeep(
    parsed.attachments,
    deps.config.ATTACHMENT_MAX_MB * 1024 * 1024,
  );
  const notAdded = skipped.length > 0 ? `\n\n[Files not added: ${skipped.join(', ')}]` : '';

  try {
    return await withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
      const { Ticket } = ticketModels(deps.db.writer);
      const { TicketMessage } = conversationModels(deps.db.writer);
      if (messageId) {
        const seen =
          (await TicketMessage.count({ where: { emailMessageId: messageId }, transaction })) +
          (await Ticket.count({ where: { emailMessageId: messageId }, transaction }));
        if (seen > 0) return { result: 'duplicate' as const, workspaceId };
      }
      if (await tooMany(deps, from, transaction)) {
        return { result: 'ignored' as const, reason: 'too many emails from this sender' };
      }

      const displayName = sender?.name.trim() ?? '';
      const name = (displayName !== '' ? displayName : from.slice(0, from.indexOf('@'))).slice(
        0,
        120,
      );
      const contact = await findOrAddContact(
        deps,
        workspaceId,
        { name, email: from },
        transaction,
        {
          skipRequired: true,
        },
      );
      const contactName =
        (
          await contactModels(deps.db.writer).Contact.findByPk(contact.id, {
            attributes: ['name'],
            transaction,
          })
        )?.name ?? name;

      const thread = await threadOf(deps, parsed, read.ticketNumber, transaction);
      const answersOpen = thread && !thread.deletedAt && thread.status !== 'closed';
      if (thread && answersOpen) {
        const message = await TicketMessage.create(
          {
            id: newId(),
            workspaceId,
            ticketId: thread.id,
            kind: 'customer',
            bodyText: `${text}${notAdded}`.trim(),
            bodyHtml: null,
            authorUserId: null,
            authorContactId: contact.id,
            toEmails: addressesOf(parsed.to).slice(0, 20),
            ccEmails: addressesOf(parsed.cc).slice(0, 20),
            mentionedUserIds: [],
            emailStatus: null,
            emailMessageId: messageId,
          },
          { transaction },
        );
        await storeFiles(
          deps,
          kept,
          { workspaceId, ticketId: thread.id, messageId: message.id },
          transaction,
        );
        const previousStatus = thread.status;
        await reopenForCustomer(deps, thread, contactName, transaction);
        // The assignee hears about it (F25); by email only if they chose that.
        if (thread.assigneeUserId) {
          await notifyMembers(
            deps,
            {
              workspaceId,
              ticketId: thread.id,
              kind: 'customer_reply',
              userIds: [thread.assigneeUserId],
              subject: `${contactName} replied on ticket #${String(thread.number)}`,
              text: text || 'Sent files.',
            },
            transaction,
          );
        }
        await runRules(deps, 'customer_replied', thread, transaction, {
          previousStatus,
          message: text,
        });
        return { result: 'reply' as const, workspaceId, ticketNumber: thread.number };
      }

      const followUp = thread
        ? `This email answers ticket #${String(thread.number)}, which is ${thread.deletedAt ? 'deleted' : 'closed'}.\n\n`
        : '';
      const subject = (parsed.subject ?? '').replace(/\s+/g, ' ').trim() || '(no subject)';
      const ticket = await createCustomerTicket(
        deps,
        workspaceId,
        {
          contact: { id: contact.id, companyId: contact.companyId, name: contactName },
          subject: subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject,
          description: `${followUp}${text}${notAdded}`.trim(),
          source: 'email',
          emailMessageId: messageId,
        },
        transaction,
      );
      await storeFiles(
        deps,
        kept,
        { workspaceId, ticketId: ticket.id, messageId: null },
        transaction,
      );
      return { result: 'ticket' as const, workspaceId, ticketNumber: ticket.number };
    });
  } catch (error) {
    // The same email arriving twice at the same moment: the unique Message-ID index stops one.
    if (error instanceof UniqueConstraintError) return { result: 'duplicate', workspaceId };
    throw error;
  }
}
