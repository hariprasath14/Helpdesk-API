import {
  col,
  literal,
  Op,
  UniqueConstraintError,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { fieldDefinitions } from '../custom-fields/custom-fields.service.js';
import { checkCustomFieldValues, type CustomFieldValues } from '../custom-fields/values.js';
import { ticketModels } from '../tickets/models.js';
import { domainOf, isFreeEmailDomain } from './email-domains.js';
import { contactModels, type ContactModels, type ContactRecord } from './models.js';
import { encodeCursor, likePattern, paging, type ListSort } from './paging.js';

/** Other emails a contact can have besides the main one. */
export const MAX_OTHER_EMAILS = 5;

interface Deps {
  db: Database;
}

export interface CompanyRef {
  id: string;
  name: string;
}

export interface ContactSummary {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  company: CompanyRef | null;
  updatedAt: Date;
}

export interface ContactView extends ContactSummary {
  otherEmails: string[];
  note: string | null;
  customFields: CustomFieldValues;
  createdAt: Date;
}

const summaryOf = (contact: ContactRecord): ContactSummary => ({
  id: contact.id,
  name: contact.name,
  email: contact.email,
  phone: contact.phone,
  jobTitle: contact.jobTitle,
  company: contact.company ? { id: contact.company.id, name: contact.company.name } : null,
  updatedAt: contact.updatedAt,
});

const viewOf = (contact: ContactRecord): ContactView => ({
  ...summaryOf(contact),
  otherEmails: (contact.emails ?? [])
    .filter((email) => !email.isPrimary)
    .map((email) => email.email)
    .sort(),
  note: contact.note,
  customFields: contact.customFields,
  createdAt: contact.createdAt,
});

/** Trimmed text, or null when blank. */
const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

async function readContact(
  models: ContactModels,
  contactId: string,
  transaction: Transaction,
): Promise<ContactView> {
  const { Company, Contact, ContactEmail } = models;
  const contact = await Contact.findByPk(contactId, {
    include: [
      { model: Company, as: 'company', attributes: ['id', 'name'] },
      { model: ContactEmail, as: 'emails' },
    ],
    transaction,
  });
  if (!contact) throw new NotFoundError('This contact does not exist.');
  return viewOf(contact);
}

export interface ContactFilters {
  q?: string | undefined;
  companyId?: string | undefined;
  sort: ListSort;
}

/**
 * One page of contacts (every member). Reads the reader. Search matches the name, phone and any
 * of the contact's emails. `total` is counted on the first page only.
 */
export async function listContacts(
  deps: Deps,
  signedIn: SignedIn,
  filters: ContactFilters,
  page: { cursor?: string | undefined; limit: number },
): Promise<{ contacts: ContactSummary[]; nextCursor: string | null; total: number | null }> {
  const { Company, Contact } = contactModels(deps.db.reader);
  const conditions: WhereOptions[] = [];
  if (filters.companyId) conditions.push({ companyId: filters.companyId });
  const q = filters.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    conditions.push({
      [Op.or]: [
        { name: { [Op.iLike]: pattern } },
        { phone: { [Op.iLike]: pattern } },
        literal(
          `"Contact"."id" IN (SELECT contact_id FROM contact_emails WHERE email ILIKE ${deps.db.reader.escape(pattern)})`,
        ),
      ],
    });
  }
  const { order, after } = paging('Contact', filters.sort, page.cursor);

  return withWorkspace(deps.db.reader, signedIn.workspace.id, async (transaction) => {
    const rows = await Contact.findAll({
      attributes: { include: [[col('Contact.sort_name'), 'sortName']] },
      include: [{ model: Company, as: 'company', attributes: ['id', 'name'] }],
      where: { [Op.and]: after ? [...conditions, after] : conditions },
      order,
      limit: page.limit + 1,
      transaction,
    });
    const total = page.cursor
      ? null
      : await Contact.count({ where: { [Op.and]: conditions }, transaction });
    const contacts = rows.slice(0, page.limit);
    const last = contacts.at(-1);
    return {
      contacts: contacts.map(summaryOf),
      total,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({
              sort: filters.sort,
              value:
                filters.sort === 'name'
                  ? String(last.get('sortName'))
                  : last.updatedAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  });
}

/** One contact with its other emails, note and custom fields (every member). */
export async function getContact(
  deps: Deps,
  signedIn: SignedIn,
  contactId: string,
): Promise<ContactView> {
  return withWorkspace(deps.db.reader, signedIn.workspace.id, (transaction) =>
    readContact(contactModels(deps.db.reader), contactId, transaction),
  );
}

export interface ContactInput {
  name?: string | undefined;
  email?: string | null | undefined;
  otherEmails?: string[] | undefined;
  phone?: string | null | undefined;
  jobTitle?: string | null | undefined;
  /** A company id; null for none. Left out on a new contact: linked by email domain. */
  companyId?: string | null | undefined;
  note?: string | null | undefined;
  customFields?: CustomFieldValues | undefined;
}

interface Problem {
  field: string;
  message: string;
}

/** The main email and other emails, lowercased and checked against each other. */
function emailsFrom(
  email: string | null,
  others: string[],
): { all: string[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const all = email ? [email] : [];
  others.forEach((other, index) => {
    const address = other.trim().toLowerCase();
    if (all.includes(address)) {
      problems.push({
        field: `otherEmails.${String(index)}`,
        message: 'This email is already listed.',
      });
    } else all.push(address);
  });
  if (!email && others.length > 0) {
    problems.push({ field: 'email', message: 'Add a main email before other emails.' });
  }
  if (others.length > MAX_OTHER_EMAILS) {
    problems.push({
      field: 'otherEmails',
      message: `Add at most ${String(MAX_OTHER_EMAILS)} other emails.`,
    });
  }
  return { all, problems };
}

/** Problems for emails that already belong to another contact, naming that contact. */
async function emailsTaken(
  models: ContactModels,
  email: string | null,
  others: string[],
  contactId: string | null,
  transaction: Transaction,
): Promise<Problem[]> {
  const addresses = [...(email ? [email] : []), ...others];
  if (addresses.length === 0) return [];
  const taken = await models.ContactEmail.findAll({
    where: {
      email: addresses,
      ...(contactId ? { contactId: { [Op.ne]: contactId } } : {}),
    },
    transaction,
  });
  if (taken.length === 0) return [];
  const owners = await models.Contact.findAll({
    where: { id: taken.map((row) => row.contactId) },
    attributes: ['id', 'name'],
    transaction,
  });
  const ownerOf = (address: string) => {
    const row = taken.find((item) => item.email === address);
    return owners.find((owner) => owner.id === row?.contactId)?.name;
  };
  const problems: Problem[] = [];
  const check = (address: string, field: string) => {
    const owner = ownerOf(address);
    if (owner) problems.push({ field, message: `This email belongs to ${owner}.` });
  };
  if (email) check(email, 'email');
  others.forEach((other, index) => {
    check(other, `otherEmails.${String(index)}`);
  });
  return problems;
}

/** The company whose domain matches the email, if any. Free email services never match. */
async function companyForEmail(
  models: ContactModels,
  email: string | null,
  transaction: Transaction,
): Promise<string | null> {
  if (!email || isFreeEmailDomain(domainOf(email))) return null;
  const match = await models.CompanyDomain.findOne({
    where: { domain: domainOf(email) },
    transaction,
  });
  return match?.companyId ?? null;
}

async function checkCompany(
  models: ContactModels,
  companyId: string | null,
  transaction: Transaction,
): Promise<Problem[]> {
  if (!companyId) return [];
  const company = await models.Company.findByPk(companyId, { attributes: ['id'], transaction });
  return company ? [] : [{ field: 'companyId', message: 'This company no longer exists.' }];
}

/** Saves the contact's emails: the main one first, then the others. */
async function saveEmails(
  models: ContactModels,
  workspaceId: string,
  contactId: string,
  all: string[],
  transaction: Transaction,
) {
  const { ContactEmail } = models;
  const existing = await ContactEmail.findAll({ where: { contactId }, transaction });
  for (const row of existing) {
    if (!all.includes(row.email)) await row.destroy({ transaction });
  }
  for (const [index, email] of all.entries()) {
    const isPrimary = index === 0;
    const row = existing.find((item) => item.email === email);
    if (row) {
      if (row.isPrimary !== isPrimary) await row.update({ isPrimary }, { transaction });
    } else {
      await ContactEmail.create(
        { id: newId(), workspaceId, contactId, email, isPrimary },
        { transaction },
      );
    }
  }
}

/** A unique-email race (two saves at once) explained like the normal check. */
function explainUnique(error: unknown): never {
  if (error instanceof UniqueConstraintError) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [{ field: 'email', message: 'This email already belongs to another contact.' }],
    });
  }
  throw error;
}

function refuse(problems: Problem[]) {
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
}

/**
 * Adds a contact (every member). Needs a name and an email or phone. With no company given, it is
 * linked to the company whose domain matches the email. Returns the contact, read from the writer.
 */
export async function createContact(
  deps: Deps,
  signedIn: SignedIn,
  input: ContactInput & { name: string },
): Promise<ContactView> {
  requirePermission(signedIn, 'contacts.edit');
  const models = contactModels(deps.db.writer);
  const email = blankToNull(input.email)?.toLowerCase() ?? null;
  const phone = blankToNull(input.phone);
  const others = (input.otherEmails ?? []).map((other) => other.trim().toLowerCase());
  const { all, problems } = emailsFrom(email, others);
  if (!email && !phone) {
    problems.push({ field: 'email', message: 'Enter an email or a phone number.' });
  }

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const definitions = await fieldDefinitions(deps, 'contact', transaction);
    const found = [
      ...problems,
      ...(await emailsTaken(models, email, others, null, transaction)),
      ...(await checkCompany(models, input.companyId ?? null, transaction)),
    ];
    let customFields: CustomFieldValues = {};
    try {
      customFields = checkCustomFieldValues(definitions, input.customFields, { creating: true });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      found.push(...(error.details as { fields: Problem[] }).fields);
    }
    refuse(found);

    const id = newId();
    try {
      await models.Contact.create(
        {
          id,
          workspaceId: signedIn.workspace.id,
          name: input.name.trim(),
          email,
          phone,
          jobTitle: blankToNull(input.jobTitle),
          companyId:
            input.companyId === undefined
              ? await companyForEmail(models, email, transaction)
              : input.companyId,
          note: blankToNull(input.note),
          customFields,
        },
        { transaction },
      );
      await saveEmails(models, signedIn.workspace.id, id, all, transaction);
    } catch (error) {
      explainUnique(error);
    }
    return readContact(models, id, transaction);
  });
}

/**
 * Changes a contact (every member); only the fields given change. `otherEmails` replaces the
 * list. A contact without a company is linked by its new email's domain. Returns the contact.
 */
export async function updateContact(
  deps: Deps,
  signedIn: SignedIn,
  contactId: string,
  changes: ContactInput,
): Promise<ContactView> {
  requirePermission(signedIn, 'contacts.edit');
  const models = contactModels(deps.db.writer);

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const contact = await models.Contact.findByPk(contactId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!contact) throw new NotFoundError('This contact does not exist.');
    contact.emails = await models.ContactEmail.findAll({ where: { contactId }, transaction });

    const email =
      changes.email === undefined
        ? contact.email
        : (blankToNull(changes.email)?.toLowerCase() ?? null);
    const phone = changes.phone === undefined ? contact.phone : blankToNull(changes.phone);
    const others =
      changes.otherEmails?.map((other) => other.trim().toLowerCase()) ??
      viewOf(contact).otherEmails;
    const { all, problems } = emailsFrom(email, others);
    if (!email && !phone) {
      problems.push({ field: 'email', message: 'Enter an email or a phone number.' });
    }
    problems.push(...(await emailsTaken(models, email, others, contactId, transaction)));
    if (changes.companyId !== undefined) {
      problems.push(...(await checkCompany(models, changes.companyId, transaction)));
    }
    let customFields = contact.customFields;
    try {
      customFields = checkCustomFieldValues(
        await fieldDefinitions(deps, 'contact', transaction),
        changes.customFields,
        { existing: contact.customFields },
      );
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      problems.push(...(error.details as { fields: Problem[] }).fields);
    }
    refuse(problems);

    let companyId = contact.companyId;
    if (changes.companyId !== undefined) companyId = changes.companyId;
    else if (!companyId && email !== contact.email) {
      companyId = await companyForEmail(models, email, transaction);
    }

    try {
      await contact.update(
        {
          ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
          email,
          phone,
          ...(changes.jobTitle !== undefined ? { jobTitle: blankToNull(changes.jobTitle) } : {}),
          companyId,
          ...(changes.note !== undefined ? { note: blankToNull(changes.note) } : {}),
          customFields,
        },
        { transaction },
      );
      await saveEmails(models, signedIn.workspace.id, contactId, all, transaction);
    } catch (error) {
      explainUnique(error);
    }
    return readContact(models, contactId, transaction);
  });
}

/** Deletes a contact for good (admins and supervisors), recorded in the audit log. */
export async function deleteContact(
  deps: Deps,
  signedIn: SignedIn,
  contactId: string,
): Promise<void> {
  requirePermission(signedIn, 'contacts.delete');
  const { Contact } = contactModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const contact = await Contact.findByPk(contactId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!contact) throw new NotFoundError('This contact does not exist.');
    const tickets = await ticketModels(deps.db.writer).Ticket.count({
      where: { contactId },
      transaction,
    });
    if (tickets > 0) {
      throw new ConflictError(
        tickets === 1
          ? 'This contact raised a ticket (deleted tickets count too). Change its requester first.'
          : `This contact raised ${String(tickets)} tickets (deleted tickets count too). Change their requester first.`,
      );
    }
    await contact.destroy({ transaction });
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'contact.deleted',
        target: { type: 'contact', id: contact.id, label: contact.name },
        details: contact.email ? { email: contact.email } : {},
        meta: signedIn.meta,
      },
      transaction,
    );
  });
}

/**
 * The requester of a new ticket (F9), inside the ticket's transaction: the contact that already
 * has this email, or a new contact linked to the company of the email's domain. A new contact
 * gets the contact custom fields' defaults; if a contact field is required, the contact must be
 * added under Contacts first, unless `skipRequired` (a customer who emailed in, F14).
 */
export async function findOrAddContact(
  deps: Deps,
  workspaceId: string,
  input: { name: string; email?: string | null | undefined; phone?: string | null | undefined },
  transaction: Transaction,
  { skipRequired = false }: { skipRequired?: boolean } = {},
): Promise<{ id: string; companyId: string | null; added: boolean }> {
  const models = contactModels(deps.db.writer);
  const email = blankToNull(input.email)?.toLowerCase() ?? null;
  const phone = blankToNull(input.phone);
  const problem = (message: string) =>
    new ValidationError('Check the highlighted fields.', {
      fields: [{ field: 'contact.email', message }],
    });
  if (!email && !phone) throw problem('Enter an email or a phone number.');
  if (email) {
    const known = await models.ContactEmail.findOne({ where: { email }, transaction });
    if (known) {
      const contact = await models.Contact.findByPk(known.contactId, {
        attributes: ['id', 'companyId'],
        transaction,
      });
      if (contact) return { id: contact.id, companyId: contact.companyId, added: false };
    }
  }
  let customFields: CustomFieldValues;
  try {
    customFields = checkCustomFieldValues(
      await fieldDefinitions(deps, 'contact', transaction),
      {},
      { creating: true, skipRequired },
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    throw problem('Contacts here have required fields. Add this person under Contacts first.');
  }
  const id = newId();
  const companyId = await companyForEmail(models, email, transaction);
  await models.Contact.create(
    {
      id,
      workspaceId,
      name: input.name.trim(),
      email,
      phone,
      jobTitle: null,
      companyId,
      note: null,
      customFields,
    },
    { transaction },
  );
  await saveEmails(models, workspaceId, id, email ? [email] : [], transaction);
  return { id, companyId, added: true };
}
