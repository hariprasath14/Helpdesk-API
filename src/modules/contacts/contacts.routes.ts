import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  MAX_DOMAINS,
  updateCompany,
} from './companies.service.js';
import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  MAX_OTHER_EMAILS,
  updateContact,
} from './contacts.service.js';

const name = z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.');
const email = z.email('Enter a valid email address.').max(254);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${String(max)} characters.`)
    .nullable()
    .optional()
    .describe('Empty or null clears it');
const customFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Values by field key (see custom fields); null clears one');
const pageFields = {
  cursor: z.string().max(400).optional().describe('nextCursor from the previous page'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

const CompanyRefSchema = z.object({ id: z.string(), name: z.string() }).nullable();

const ContactSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable().describe('The main email'),
    phone: z.string().nullable(),
    jobTitle: z.string().nullable(),
    company: CompanyRefSchema,
    updatedAt: z.date(),
  })
  .meta({ id: 'ContactSummary' });

const ContactSchema = ContactSummarySchema.extend({
  otherEmails: z.array(z.string()),
  note: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
}).meta({ id: 'Contact' });

const ContactPageSchema = z
  .object({
    contacts: z.array(ContactSummarySchema),
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
    total: z.number().int().nullable().describe('All matching contacts; first page only'),
  })
  .meta({ id: 'ContactPage' });

const contactFields = {
  email: email.nullable().optional().describe('The main email; matched to company domains'),
  otherEmails: z
    .array(email)
    .max(MAX_OTHER_EMAILS + 5)
    .optional()
    .describe(`Up to ${String(MAX_OTHER_EMAILS)}; replaces the list`),
  phone: optionalText(40),
  jobTitle: optionalText(100),
  companyId: z
    .uuid()
    .nullable()
    .optional()
    .describe('null for none; left out on a new contact: linked by email domain'),
  note: optionalText(5000),
  customFields,
};

const CreateContactSchema = z
  .object({ name, ...contactFields })
  .meta({ id: 'CreateContactRequest' });
const UpdateContactSchema = z
  .object({ name: name.optional(), ...contactFields })
  .meta({ id: 'UpdateContactRequest' });

const CompanySummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    domains: z.array(z.string()),
    contactCount: z.number().int(),
    updatedAt: z.date(),
  })
  .meta({ id: 'CompanySummary' });

const CompanySchema = CompanySummarySchema.extend({
  phone: z.string().nullable(),
  website: z.string().nullable(),
  note: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
}).meta({ id: 'Company' });

const CompanyPageSchema = z
  .object({
    companies: z.array(CompanySummarySchema),
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
    total: z.number().int().nullable().describe('All matching companies; first page only'),
  })
  .meta({ id: 'CompanyPage' });

const companyFields = {
  domains: z
    .array(z.string().trim().max(260))
    .max(MAX_DOMAINS + 5)
    .optional()
    .describe(`Email domains such as acme.com, up to ${String(MAX_DOMAINS)}; replaces the list`),
  phone: optionalText(40),
  website: optionalText(200),
  note: optionalText(5000),
  customFields,
};

const CreateCompanySchema = z
  .object({ name, ...companyFields })
  .meta({ id: 'CreateCompanyRequest' });
const UpdateCompanySchema = z
  .object({ name: name.optional(), ...companyFields })
  .meta({ id: 'UpdateCompanyRequest' });

const ContactIdParams = z.object({ contactId: z.uuid() });
const CompanyIdParams = z.object({ companyId: z.uuid() });

/** Contacts and companies: every member reads, adds and edits; admins and supervisors delete. */
export const contactsRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'A page of contacts',
        description: 'Search matches the name, phone and every email. Pages with a cursor.',
        querystring: z.object({
          q: z.string().trim().max(100).optional(),
          companyId: z.uuid().optional().describe("Only this company's contacts"),
          sort: z.enum(['name', 'updated']).default('name'),
          ...pageFields,
        }),
        response: { 200: ContactPageSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const { q, companyId, sort, cursor, limit } = request.query;
      return listContacts(deps, await signedIn(request), { q, companyId, sort }, { cursor, limit });
    },
  );

  app.post(
    '/contacts',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Add a contact',
        description:
          'Needs a name and an email or phone. Emails are unique in the workspace. With no companyId, the contact is linked to the company whose domain matches the email.',
        body: CreateContactSchema,
        response: { 200: ContactSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => createContact(deps, await signedIn(request), request.body),
  );

  app.get(
    '/contacts/:contactId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'One contact',
        params: ContactIdParams,
        response: { 200: ContactSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => getContact(deps, await signedIn(request), request.params.contactId),
  );

  app.patch(
    '/contacts/:contactId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Change a contact',
        description: 'Only the fields given change; customFields merges by key.',
        params: ContactIdParams,
        body: UpdateContactSchema,
        response: { 200: ContactSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateContact(deps, await signedIn(request), request.params.contactId, request.body),
  );

  app.delete(
    '/contacts/:contactId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Delete a contact for good',
        description:
          'Admins and supervisors (contacts.delete). Recorded in the audit log. 409 while the contact is the requester of any ticket, deleted ones included.',
        params: ContactIdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await deleteContact(deps, await signedIn(request), request.params.contactId);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/companies',
    {
      schema: {
        tags: ['contacts'],
        summary: 'A page of companies, A to Z',
        description: 'Search matches the name and domains. Pages with a cursor.',
        querystring: z.object({ q: z.string().trim().max(100).optional(), ...pageFields }),
        response: { 200: CompanyPageSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => {
      const { q, cursor, limit } = request.query;
      return listCompanies(deps, await signedIn(request), { q }, { cursor, limit });
    },
  );

  app.post(
    '/companies',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Add a company',
        description:
          'Names are unique in the workspace (ignoring case); each domain belongs to one company, and free email services are refused.',
        body: CreateCompanySchema,
        response: { 200: CompanySchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => createCompany(deps, await signedIn(request), request.body),
  );

  app.get(
    '/companies/:companyId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'One company',
        params: CompanyIdParams,
        response: { 200: CompanySchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => getCompany(deps, await signedIn(request), request.params.companyId),
  );

  app.patch(
    '/companies/:companyId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Change a company',
        description: 'Only the fields given change; customFields merges by key.',
        params: CompanyIdParams,
        body: UpdateCompanySchema,
        response: { 200: CompanySchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateCompany(deps, await signedIn(request), request.params.companyId, request.body),
  );

  app.delete(
    '/companies/:companyId',
    {
      schema: {
        tags: ['contacts'],
        summary: 'Delete a company for good (its contacts stay, without a company)',
        description: 'Admins and supervisors (contacts.delete). Recorded in the audit log.',
        params: CompanyIdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteCompany(deps, await signedIn(request), request.params.companyId);
      return reply.status(204).send(null);
    },
  );

  done();
};
