import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { QUEUES, type JobQueue } from '../../jobs/queue.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { contactModels } from '../contacts/models.js';
import { conversationModels } from '../conversation/models.js';
import { fieldDefinitions } from '../custom-fields/custom-fields.service.js';
import { checkCustomFieldValues } from '../custom-fields/values.js';
import { runRules } from '../rules/engine.js';
import { updateSla } from '../sla/sla.service.js';
import { ticketModels, type TicketRecord } from './models.js';
import {
  lockTicketForChange,
  nextNumber,
  readTicket,
  recordActivity,
  saveTags,
  statusTimes,
  type TicketView,
} from './tickets.service.js';

interface Deps {
  db: Database;
  jobs: Pick<JobQueue, 'enqueue'>;
}

/** Tickets merged into a main one at once (2 to 5 in all). */
export const MAX_MERGED = 4;

const ref = (number: number) => `#${String(number)}`;

/**
 * Merges 1 to 4 tickets into a main one (F28; admins and supervisors, tickets.merge). Their
 * messages, notes, files and tags move into the main ticket in time order, marked "From #41"
 * (each one's description becomes a customer message there); they are closed, read-only and
 * "Merged into #42"; their requesters are copied on the main ticket's replies, and replies to
 * their old email threads land there. Customers are told only if asked. No undo; audited.
 */
export async function mergeTickets(
  deps: Deps,
  signedIn: SignedIn,
  mainNumber: number,
  input: { numbers: number[]; tellCustomers?: boolean | undefined },
): Promise<TicketView> {
  requirePermission(signedIn, 'tickets.merge');
  const numbers = [...new Set(input.numbers)].filter((number) => number !== mainNumber);
  if (numbers.length === 0 || numbers.length > MAX_MERGED) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [
        {
          field: 'numbers',
          message: `Choose 1 to ${String(MAX_MERGED)} other tickets to merge into this one.`,
        },
      ],
    });
  }
  const models = ticketModels(deps.db.writer);
  const { TicketMessage, TicketAttachment } = conversationModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    // Locked in one order, so two merges at once cannot deadlock.
    const locked = await models.Ticket.findAll({
      where: { number: [mainNumber, ...numbers] },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const byNumber = new Map(locked.map((ticket) => [ticket.number, ticket]));
    const missing = [mainNumber, ...numbers].filter((number) => !byNumber.has(number));
    if (missing.length > 0) {
      throw new NotFoundError(`These tickets do not exist: ${missing.map(ref).join(', ')}.`);
    }
    const main = await lockTicketForChange(models, mainNumber, transaction);
    const others = numbers
      .map((number) => byNumber.get(number))
      .filter((ticket): ticket is TicketRecord => ticket !== undefined)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const unusable = others.filter(
      (ticket) => ticket.deletedAt !== null || Boolean(ticket.mergedIntoId),
    );
    if (unusable.length > 0) {
      throw new ConflictError(
        `${unusable.map((ticket) => ref(ticket.number)).join(', ')} cannot be merged: deleted or already merged.`,
      );
    }

    const { Contact } = contactModels(deps.db.writer);
    const requester = await Contact.findByPk(main.contactId, {
      attributes: ['email'],
      transaction,
    });
    const tags = new Set((main.tags ?? []).map((row) => row.tag));
    const copies = new Set(main.ccEmails);
    for (const other of others) {
      const contact = await Contact.findByPk(other.contactId, {
        attributes: ['name', 'email'],
        transaction,
      });
      // Its description, as the customer's first message, with the files that came with it.
      const description = await TicketMessage.create(
        {
          id: newId(),
          workspaceId: main.workspaceId,
          ticketId: main.id,
          kind: 'customer',
          bodyText: `${other.subject}\n\n${other.description}`.trim(),
          bodyHtml: null,
          authorUserId: null,
          authorContactId: other.contactId,
          toEmails: [],
          ccEmails: [],
          mentionedUserIds: [],
          emailStatus: null,
          fromTicketNumber: other.number,
        },
        { transaction },
      );
      await deps.db.writer.query('UPDATE ticket_messages SET created_at = :at WHERE id = :id', {
        replacements: { at: other.createdAt, id: description.id },
        transaction,
      });
      await TicketAttachment.update(
        { ticketId: main.id, messageId: description.id },
        { where: { ticketId: other.id, messageId: null }, transaction },
      );
      // Everything else moves as it is; the conversation shows it in time order.
      await TicketMessage.update(
        { ticketId: main.id, fromTicketNumber: other.number },
        { where: { ticketId: other.id, fromTicketNumber: null }, transaction },
      );
      await TicketMessage.update(
        { ticketId: main.id },
        { where: { ticketId: other.id }, transaction },
      );
      await TicketAttachment.update(
        { ticketId: main.id },
        { where: { ticketId: other.id }, transaction },
      );
      for (const row of await models.TicketTag.findAll({
        where: { ticketId: other.id },
        transaction,
      })) {
        tags.add(row.tag);
      }
      if (contact?.email && contact.email !== requester?.email) copies.add(contact.email);
      for (const email of other.ccEmails) if (email !== requester?.email) copies.add(email);

      // The merged ticket: closed, read-only, pointing at the main one.
      const before = {
        status: other.status,
        priority: other.priority,
        statusChangedAt: other.statusChangedAt,
      };
      other.set({ status: 'closed', mergedIntoId: main.id, ...statusTimes('closed', other) });
      await other.save({ transaction });
      await recordActivity(
        models,
        signedIn,
        other,
        'updated',
        [
          ...(before.status !== 'closed'
            ? [{ field: 'status', from: before.status, to: 'closed' }]
            : []),
          { field: 'merged_into', from: null, to: main.number },
        ],
        transaction,
      );
      await updateSla(deps, other, transaction, before);
      if (input.tellCustomers) {
        await deps.jobs.enqueue(
          QUEUES.customerEmail,
          {
            workspaceId: other.workspaceId,
            ticketId: other.id,
            event: 'merged',
            mergedInto: main.number,
          },
          transaction,
        );
      }
    }

    await saveTags(models, main, [...tags], transaction);
    main.ccEmails = [...copies];
    main.changed('updatedAt', true);
    await main.save({ transaction });
    await recordActivity(
      models,
      signedIn,
      main,
      'updated',
      [{ field: 'merged', from: null, to: others.map((other) => other.number) }],
      transaction,
    );
    await auditMerge(deps, signedIn, main, others, input.tellCustomers ?? false, transaction);
    return readTicket(deps, main.number, transaction);
  });
}

function auditMerge(
  deps: Deps,
  signedIn: SignedIn,
  main: TicketRecord,
  others: TicketRecord[],
  toldCustomers: boolean,
  transaction: Transaction,
) {
  return recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action: 'ticket.merged',
      target: { type: 'ticket', id: main.id, label: `${ref(main.number)} ${main.subject}` },
      details: { merged: others.map((other) => other.number), toldCustomers },
      meta: signedIn.meta,
    },
    transaction,
  );
}

/**
 * Splits a customer's message off into a new ticket (F28; every member): same requester, its
 * files, "Split from #42" and "Split into #57" in the two histories. The message leaves the
 * original ticket. The new ticket runs the "ticket created" rules and gets its SLA.
 */
export async function splitMessage(
  deps: Deps,
  signedIn: SignedIn,
  number: number,
  messageId: string,
): Promise<TicketView> {
  requirePermission(signedIn, 'tickets.work');
  const models = ticketModels(deps.db.writer);
  const { TicketMessage, TicketAttachment } = conversationModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const original = await lockTicketForChange(models, number, transaction);
    const message = await TicketMessage.findOne({
      where: { id: messageId, ticketId: original.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!message) throw new NotFoundError('This message does not exist.');
    if (message.kind !== 'customer') {
      throw new ConflictError("Only a customer's message can be split into a new ticket.");
    }
    const customFields = checkCustomFieldValues(
      await fieldDefinitions(deps, 'ticket', transaction),
      {},
      { creating: true, skipRequired: true },
    );
    const split = await models.Ticket.create(
      {
        id: newId(),
        workspaceId: original.workspaceId,
        number: await nextNumber(deps, original.workspaceId, transaction),
        subject: original.subject,
        description: message.bodyText,
        contactId: original.contactId,
        companyId: original.companyId,
        status: 'open',
        priority: original.priority,
        type: original.type,
        teamId: original.teamId,
        assigneeUserId: null,
        source: original.source,
        customFields,
        createdByUserId: signedIn.user.id,
        ...statusTimes('open'),
        deletedAt: null,
      },
      { transaction },
    );
    split.tags = [];
    await TicketAttachment.update(
      { ticketId: split.id, messageId: null },
      { where: { messageId: message.id }, transaction },
    );
    await message.destroy({ transaction });
    await recordActivity(models, signedIn, split, 'created', [], transaction);
    await recordActivity(
      models,
      signedIn,
      split,
      'updated',
      [{ field: 'split_from', from: null, to: original.number }],
      transaction,
    );
    original.changed('updatedAt', true);
    await original.save({ transaction });
    await recordActivity(
      models,
      signedIn,
      original,
      'updated',
      [{ field: 'split_into', from: null, to: split.number }],
      transaction,
    );
    await runRules(deps, 'ticket_created', split, transaction);
    await updateSla(deps, split, transaction);
    return readTicket(deps, split.number, transaction);
  });
}
