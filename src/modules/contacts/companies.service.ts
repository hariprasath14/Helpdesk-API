import {
  col,
  fn,
  literal,
  Op,
  UniqueConstraintError,
  where,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { fieldDefinitions } from '../custom-fields/custom-fields.service.js';
import { checkCustomFieldValues, type CustomFieldValues } from '../custom-fields/values.js';
import { cleanDomain, isFreeEmailDomain } from './email-domains.js';
import { contactModels, type CompanyRecord, type ContactModels } from './models.js';
import { encodeCursor, likePattern, paging } from './paging.js';

/** Email domains one company can have. */
export const MAX_DOMAINS = 20;

interface Deps {
  db: Database;
}

export interface CompanySummary {
  id: string;
  name: string;
  domains: string[];
  contactCount: number;
  updatedAt: Date;
}

export interface CompanyView extends CompanySummary {
  phone: string | null;
  website: string | null;
  note: string | null;
  customFields: CustomFieldValues;
  createdAt: Date;
}

interface Problem {
  field: string;
  message: string;
}

const CONTACT_COUNT = literal(
  '(SELECT count(*)::int FROM contacts WHERE contacts.company_id = "Company"."id")',
);

/** Trimmed text, or null when blank. */
const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

/** Each company's domains, A to Z. Read in the same transaction (row-level security). */
async function domainsFor(models: ContactModels, ids: string[], transaction: Transaction) {
  const rows = await models.CompanyDomain.findAll({
    where: { companyId: ids },
    order: [['domain', 'ASC']],
    transaction,
  });
  return (id: string) => rows.filter((row) => row.companyId === id).map((row) => row.domain);
}

const summaryOf = (company: CompanyRecord, domains: string[]): CompanySummary => ({
  id: company.id,
  name: company.name,
  domains,
  contactCount: Number(company.get('contactCount') ?? 0),
  updatedAt: company.updatedAt,
});

async function readCompany(
  models: ContactModels,
  companyId: string,
  transaction: Transaction,
): Promise<CompanyView> {
  const company = await models.Company.findByPk(companyId, {
    attributes: { include: [[CONTACT_COUNT, 'contactCount']] },
    transaction,
  });
  if (!company) throw new NotFoundError('This company does not exist.');
  const domains = await domainsFor(models, [company.id], transaction);
  return {
    ...summaryOf(company, domains(company.id)),
    phone: company.phone,
    website: company.website,
    note: company.note,
    customFields: company.customFields,
    createdAt: company.createdAt,
  };
}

/**
 * One page of companies, A to Z (every member). Reads the reader. Search matches the name and the
 * domains; the contact form's company picker uses it too.
 */
export async function listCompanies(
  deps: Deps,
  signedIn: SignedIn,
  filters: { q?: string | undefined },
  page: { cursor?: string | undefined; limit: number },
): Promise<{ companies: CompanySummary[]; nextCursor: string | null; total: number | null }> {
  const models = contactModels(deps.db.reader);
  const conditions: WhereOptions[] = [];
  const q = filters.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    conditions.push({
      [Op.or]: [
        { name: { [Op.iLike]: pattern } },
        literal(
          `"Company"."id" IN (SELECT company_id FROM company_domains WHERE domain ILIKE ${deps.db.reader.escape(pattern)})`,
        ),
      ],
    });
  }
  const { order, after } = paging('Company', 'name', page.cursor);

  return withWorkspace(deps.db.reader, signedIn.workspace.id, async (transaction) => {
    const rows = await models.Company.findAll({
      attributes: {
        include: [
          [CONTACT_COUNT, 'contactCount'],
          [col('Company.sort_name'), 'sortName'],
        ],
      },
      where: { [Op.and]: after ? [...conditions, after] : conditions },
      order,
      limit: page.limit + 1,
      transaction,
    });
    const total = page.cursor
      ? null
      : await models.Company.count({ where: { [Op.and]: conditions }, transaction });
    const companies = rows.slice(0, page.limit);
    const domains = await domainsFor(
      models,
      companies.map((company) => company.id),
      transaction,
    );
    const last = companies.at(-1);
    return {
      companies: companies.map((company) => summaryOf(company, domains(company.id))),
      total,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ sort: 'name', value: String(last.get('sortName')), id: last.id })
          : null,
    };
  });
}

/** One company with its details and custom fields (every member). */
export async function getCompany(
  deps: Deps,
  signedIn: SignedIn,
  companyId: string,
): Promise<CompanyView> {
  return withWorkspace(deps.db.reader, signedIn.workspace.id, (transaction) =>
    readCompany(contactModels(deps.db.reader), companyId, transaction),
  );
}

export interface CompanyInput {
  name?: string | undefined;
  domains?: string[] | undefined;
  phone?: string | null | undefined;
  website?: string | null | undefined;
  note?: string | null | undefined;
  customFields?: CustomFieldValues | undefined;
}

/** Domains tidied and checked: valid, not a free email service, not another company's. */
async function checkDomains(
  models: ContactModels,
  typed: string[],
  companyId: string | null,
  transaction: Transaction,
): Promise<{ domains: string[]; problems: Problem[] }> {
  const problems: Problem[] = [];
  const domains: string[] = [];
  typed.forEach((text, index) => {
    const field = `domains.${String(index)}`;
    const domain = cleanDomain(text);
    if (!domain) problems.push({ field, message: 'Enter a domain like acme.com.' });
    else if (isFreeEmailDomain(domain)) {
      problems.push({
        field,
        message: `${domain} is a free email service, so it can't belong to one company.`,
      });
    } else if (!domains.includes(domain)) domains.push(domain);
  });
  if (domains.length > MAX_DOMAINS) {
    problems.push({ field: 'domains', message: `Add at most ${String(MAX_DOMAINS)} domains.` });
  }
  if (domains.length > 0) {
    const taken = await models.CompanyDomain.findAll({
      where: { domain: domains, ...(companyId ? { companyId: { [Op.ne]: companyId } } : {}) },
      transaction,
    });
    if (taken.length > 0) {
      const owners = await models.Company.findAll({
        where: { id: taken.map((row) => row.companyId) },
        attributes: ['id', 'name'],
        transaction,
      });
      for (const row of taken) {
        const owner =
          owners.find((company) => company.id === row.companyId)?.name ?? 'another company';
        const index = typed.findIndex((text) => cleanDomain(text) === row.domain);
        problems.push({
          field: `domains.${String(index)}`,
          message: `${row.domain} belongs to ${owner}.`,
        });
      }
    }
  }
  return { domains, problems };
}

async function nameTaken(
  models: ContactModels,
  name: string,
  companyId: string | null,
  transaction: Transaction,
): Promise<Problem[]> {
  const same = await models.Company.findOne({
    where: {
      [Op.and]: [
        where(col('sort_name'), Op.eq, fn('lower', name)),
        ...(companyId ? [{ id: { [Op.ne]: companyId } }] : []),
      ],
    },
    attributes: ['id'],
    transaction,
  });
  return same ? [{ field: 'name', message: 'A company with this name already exists.' }] : [];
}

async function saveDomains(
  models: ContactModels,
  workspaceId: string,
  companyId: string,
  domains: string[],
  transaction: Transaction,
) {
  const existing = await models.CompanyDomain.findAll({ where: { companyId }, transaction });
  for (const row of existing) {
    if (!domains.includes(row.domain)) await row.destroy({ transaction });
  }
  for (const domain of domains) {
    if (!existing.some((row) => row.domain === domain)) {
      await models.CompanyDomain.create(
        { id: newId(), workspaceId, companyId, domain },
        { transaction },
      );
    }
  }
}

function refuse(problems: Problem[]) {
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
}

/** A race on a unique name or domain (two saves at once) explained like the normal check. */
function explainUnique(error: unknown): never {
  if (error instanceof UniqueConstraintError) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [
        {
          field: 'name',
          message: 'Another company with this name or one of these domains was just saved.',
        },
      ],
    });
  }
  throw error;
}

async function customFieldsFor(
  deps: Deps,
  input: CustomFieldValues | undefined,
  options: { existing?: CustomFieldValues; creating?: boolean },
  problems: Problem[],
  transaction: Transaction,
): Promise<CustomFieldValues> {
  try {
    return checkCustomFieldValues(
      await fieldDefinitions(deps, 'company', transaction),
      input,
      options,
    );
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problems.push(...(error.details as { fields: Problem[] }).fields);
    return {};
  }
}

/** Adds a company (every member). Returns it, read from the writer. */
export async function createCompany(
  deps: Deps,
  signedIn: SignedIn,
  input: CompanyInput & { name: string },
): Promise<CompanyView> {
  requirePermission(signedIn, 'contacts.edit');
  const models = contactModels(deps.db.writer);
  const name = input.name.trim();

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const { domains, problems } = await checkDomains(
      models,
      input.domains ?? [],
      null,
      transaction,
    );
    problems.push(...(await nameTaken(models, name, null, transaction)));
    const customFields = await customFieldsFor(
      deps,
      input.customFields,
      { creating: true },
      problems,
      transaction,
    );
    refuse(problems);

    const id = newId();
    try {
      await models.Company.create(
        {
          id,
          workspaceId: signedIn.workspace.id,
          name,
          phone: blankToNull(input.phone),
          website: blankToNull(input.website),
          note: blankToNull(input.note),
          customFields,
        },
        { transaction },
      );
      await saveDomains(models, signedIn.workspace.id, id, domains, transaction);
    } catch (error) {
      explainUnique(error);
    }
    return readCompany(models, id, transaction);
  });
}

/** Changes a company (every member); only the fields given change. `domains` replaces the list. */
export async function updateCompany(
  deps: Deps,
  signedIn: SignedIn,
  companyId: string,
  changes: CompanyInput,
): Promise<CompanyView> {
  requirePermission(signedIn, 'contacts.edit');
  const models = contactModels(deps.db.writer);

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const company = await models.Company.findByPk(companyId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!company) throw new NotFoundError('This company does not exist.');

    const problems: Problem[] = [];
    let domains: string[] | null = null;
    if (changes.domains !== undefined) {
      const checked = await checkDomains(models, changes.domains, companyId, transaction);
      domains = checked.domains;
      problems.push(...checked.problems);
    }
    const name = changes.name?.trim();
    if (name !== undefined && name.toLowerCase() !== company.name.toLowerCase()) {
      problems.push(...(await nameTaken(models, name, companyId, transaction)));
    }
    const customFields = await customFieldsFor(
      deps,
      changes.customFields,
      { existing: company.customFields },
      problems,
      transaction,
    );
    refuse(problems);

    try {
      await company.update(
        {
          ...(name !== undefined ? { name } : {}),
          ...(changes.phone !== undefined ? { phone: blankToNull(changes.phone) } : {}),
          ...(changes.website !== undefined ? { website: blankToNull(changes.website) } : {}),
          ...(changes.note !== undefined ? { note: blankToNull(changes.note) } : {}),
          customFields,
        },
        { transaction },
      );
      if (domains)
        await saveDomains(models, signedIn.workspace.id, companyId, domains, transaction);
    } catch (error) {
      explainUnique(error);
    }
    return readCompany(models, companyId, transaction);
  });
}

/**
 * Deletes a company for good (admins and supervisors). Its contacts stay, without a company.
 * Recorded in the audit log.
 */
export async function deleteCompany(
  deps: Deps,
  signedIn: SignedIn,
  companyId: string,
): Promise<void> {
  requirePermission(signedIn, 'contacts.delete');
  const { Company, Contact } = contactModels(deps.db.writer);
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const company = await Company.findByPk(companyId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!company) throw new NotFoundError('This company does not exist.');
    const contacts = await Contact.count({ where: { companyId }, transaction });
    await company.destroy({ transaction });
    await recordAudit(
      deps.db,
      {
        workspaceId: signedIn.workspace.id,
        actor: memberActor(signedIn.user, signedIn.role),
        action: 'company.deleted',
        target: { type: 'company', id: company.id, label: company.name },
        details: { contacts },
        meta: signedIn.meta,
      },
      transaction,
    );
  });
}
