import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import type { JobQueue } from '../../jobs/queue.js';
import { errorResponses } from '../../lib/schemas.js';
import { ValidationError } from '../../lib/errors.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { TARGET_STATES } from '../sla/clock.js';
import { TICKET_PRIORITIES, TICKET_SOURCES, TICKET_STATUSES, TICKET_TYPES } from './models.js';
import {
  createTicket,
  deleteTicket,
  DESCRIPTION_MAX,
  getTicket,
  listTickets,
  MAX_TAGS,
  restoreTicket,
  SUBJECT_MAX,
  suggestTags,
  TAG_MAX,
  ticketActivity,
  updateTicket,
} from './tickets.service.js';
import { MAX_MERGED, mergeTickets, splitMessage } from './merge.service.js';
import { TICKET_SORTS } from './ticket-list.js';
import {
  createView,
  deleteView,
  listViews,
  MAX_VIEWS_PER_PERSON,
  updateView,
} from './views.service.js';

const subject = z
  .string()
  .trim()
  .min(1, 'Enter a subject.')
  .max(SUBJECT_MAX, `Use at most ${String(SUBJECT_MAX)} characters.`);
const status = z.enum(TICKET_STATUSES);
const priority = z.enum(TICKET_PRIORITIES);
const type = z.enum(TICKET_TYPES);
const tags = z
  .array(z.string().max(TAG_MAX + 20))
  .max(MAX_TAGS + 10)
  .optional()
  .describe(`Up to ${String(MAX_TAGS)} tags of ${String(TAG_MAX)} characters; replaces the list`);
const customFields = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Values by field key (see custom fields); null clears one');

const Ref = z.object({ id: z.string(), name: z.string() });
const PersonRef = z.object({ userId: z.string(), name: z.string() });

const TicketSummarySchema = z
  .object({
    id: z.string().describe('As live updates name the ticket (F26)'),
    number: z.number().int().describe('Unique in the workspace; used in addresses'),
    subject: z.string(),
    status,
    priority,
    type: type.nullable(),
    contact: Ref.extend({ email: z.string().nullable() }).describe('The requester'),
    company: Ref.nullable(),
    team: Ref.nullable(),
    assignee: PersonRef.nullable(),
    tags: z.array(z.string()),
    createdAt: z.date(),
    updatedAt: z.date(),
    deletedAt: z.date().nullable().describe('Set while the ticket is in the trash'),
    due: z
      .object({ at: z.date(), target: z.enum(['reply', 'resolve']) })
      .nullable()
      .describe('The next SLA deadline still running; null while waiting on the customer or done'),
    mergedInto: z
      .object({ number: z.number().int() })
      .nullable()
      .describe('Merged into this ticket (F28): closed and read-only'),
  })
  .meta({ id: 'TicketSummary' });

const SlaTargetSchema = z
  .object({
    dueAt: z.date(),
    state: z
      .enum(TARGET_STATES)
      .describe('running, overdue, paused (waiting on the customer), met or missed'),
    doneAt: z.date().nullable().describe('The first reply, or when it was resolved'),
  })
  .meta({ id: 'SlaTarget' });

const TicketSlaSchema = z
  .object({
    policy: Ref.nullable().describe('null if the policy was deleted since'),
    reply: SlaTargetSchema.nullable().describe('null when resolved without a reply'),
    resolve: SlaTargetSchema.nullable(),
  })
  .meta({ id: 'TicketSla' });

const TicketSchema = TicketSummarySchema.extend({
  description: z.string().describe('The first message, plain text'),
  source: z.enum(TICKET_SOURCES),
  customFields: z.record(z.string(), z.unknown()),
  createdBy: PersonRef.nullable(),
  resolvedAt: z.date().nullable(),
  closedAt: z.date().nullable(),
  firstResponseAt: z.date().nullable().describe('When the first reply went out'),
  sla: TicketSlaSchema.nullable(),
  ccEmails: z.array(z.string()).describe('Copied on every reply (requesters of merged tickets)'),
}).meta({ id: 'Ticket' });

const TicketPageSchema = z
  .object({
    tickets: z.array(TicketSummarySchema),
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
    total: z.number().int().nullable().describe('All matching tickets; first page only'),
  })
  .meta({ id: 'TicketPage' });

const ticketFields = {
  status: status.optional(),
  priority: priority.optional(),
  type: type.nullable().optional(),
  teamId: z.uuid().nullable().optional(),
  assigneeUserId: z
    .uuid()
    .nullable()
    .optional()
    .describe(
      'null for nobody. Admins and supervisors assign anyone; agents take unassigned tickets or give back their own (403 otherwise)',
    ),
  tags,
  customFields,
};

const CreateTicketSchema = z
  .object({
    subject,
    description: z
      .string()
      .max(DESCRIPTION_MAX, `Use at most ${String(DESCRIPTION_MAX)} characters.`)
      .optional(),
    contactId: z.uuid().optional().describe('The requester; or send contact'),
    contact: z
      .object({
        name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use at most 120 characters.'),
        email: z.email('Enter a valid email address.').max(254).nullable().optional(),
        phone: z.string().trim().max(40).nullable().optional(),
      })
      .optional()
      .describe(
        'A requester by name and email or phone: the contact with this email, or a new one',
      ),
    ...ticketFields,
  })
  .meta({ id: 'CreateTicketRequest' });

const UpdateTicketSchema = z
  .object({
    subject: subject.optional(),
    contactId: z.uuid().optional().describe('Change the requester (takes their company)'),
    ...ticketFields,
  })
  .meta({ id: 'UpdateTicketRequest' });

const ActivitySchema = z
  .object({
    id: z.string(),
    at: z.date(),
    actor: z.object({ userId: z.string().nullable(), name: z.string() }),
    action: z.enum(['created', 'updated', 'deleted', 'restored']),
    changes: z.array(
      z.object({
        field: z
          .string()
          .describe('subject, status, priority, type, team, contact, tags or customFields.<key>'),
        label: z.string().optional().describe("A custom field's label at the time"),
        from: z.unknown().describe('Names for team and contact; removed tags for tags'),
        to: z.unknown().describe('Names for team and contact; added tags for tags'),
      }),
    ),
  })
  .meta({ id: 'TicketActivity' });

const csv = (example: string) =>
  z.string().max(2000).optional().describe(`Comma-separated, for example ${example}`);

/** Filters as a view saves them, and as the list checks them after splitting its query. */
const ViewFiltersSchema = z.object({
  status: z.array(status).max(10).optional(),
  priority: z.array(priority).max(10).optional(),
  type: z
    .array(z.union([type, z.literal('none')]))
    .max(10)
    .optional(),
  teamId: z
    .array(z.union([z.uuid(), z.literal('none')]))
    .max(100)
    .optional(),
  assignee: z
    .array(z.union([z.uuid(), z.literal('none'), z.literal('me')]))
    .max(100)
    .optional(),
  tag: z.array(z.string().trim().min(1).max(TAG_MAX)).max(MAX_TAGS).optional(),
  q: z.string().trim().max(100).optional(),
  overdue: z.boolean().optional().describe('Only tickets past a running SLA deadline'),
});

/** The list's split query checked like a saved view's filters; problems name the parameter. */
function checkFilters(input: Record<string, unknown>) {
  const result = ViewFiltersSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError('Check the filters.', {
    fields: result.error.issues.map((issue) => ({
      field: String(issue.path[0] ?? 'filters'),
      message: `This filter has a value the list does not know: ${issue.message}`,
    })),
  });
}

const viewName = z.string().trim().min(1, 'Enter a name.').max(60, 'Use at most 60 characters.');

const SavedViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    // Named only on the response: a schema named on both sides is given a different name by
    // each spec run (the request copy gets an "Input" suffix), which breaks the contract check.
    filters: ViewFiltersSchema.meta({ id: 'TicketFilters' }),
    sort: z.enum(TICKET_SORTS),
    shared: z.boolean(),
    mine: z.boolean(),
    ownerName: z.string(),
    canEdit: z.boolean().describe('You can change and delete it'),
  })
  .meta({ id: 'SavedView' });

const CreateSavedViewSchema = z
  .object({
    name: viewName,
    filters: ViewFiltersSchema.optional(),
    sort: z.enum(TICKET_SORTS).optional(),
    shared: z.boolean().optional(),
  })
  .meta({ id: 'CreateSavedViewRequest' });
const UpdateSavedViewSchema = z
  .object({
    name: viewName.optional(),
    filters: ViewFiltersSchema.optional(),
    sort: z.enum(TICKET_SORTS).optional(),
    shared: z.boolean().optional(),
  })
  .meta({ id: 'UpdateSavedViewRequest' });
const ViewIdParams = z.object({ viewId: z.uuid() });

const NumberParams = z.object({ number: z.coerce.number().int().positive().max(2_147_483_647) });
const SplitParams = NumberParams.extend({ messageId: z.uuid() });

const MergeSchema = z
  .object({
    numbers: z
      .array(z.number().int().positive().max(2_147_483_647))
      .min(1, 'Choose at least one ticket.')
      .max(MAX_MERGED, `Choose at most ${String(MAX_MERGED)} tickets.`)
      .describe('The tickets to merge into this one'),
    tellCustomers: z
      .boolean()
      .optional()
      .describe(
        'Email their requesters that this ticket now carries their request (off unless set)',
      ),
  })
  .meta({ id: 'MergeTicketsRequest' });

/** Tickets and saved views: every member works them; admins delete (to the trash) and restore. */
export const ticketsRoutes: FastifyPluginCallbackZod<{
  config: Config;
  db: Database;
  jobs: JobQueue;
}> = (app, deps, done) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/tickets',
    {
      schema: {
        tags: ['tickets'],
        summary: 'A page of tickets',
        description:
          'Filters take comma-separated values ("open,pending"); none means not set (type, teamId, assignee) and me is you (assignee). q matches the number (#42), subject, requester name or email, a tag, or the start of words in the description and messages. Pages with a cursor. deleted=true lists the trash (admins).',
        querystring: z.object({
          status: csv('open,pending'),
          priority: csv('high,urgent'),
          type: csv('incident,none'),
          teamId: csv('Team ids, or none'),
          assignee: csv('me, none or user ids'),
          tag: csv('refund,billing'),
          q: z.string().trim().max(100).optional(),
          overdue: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => value === 'true')
            .describe('Only tickets past a running SLA deadline'),
          sort: z.enum(TICKET_SORTS).default('updated'),
          contactId: z.uuid().optional(),
          companyId: z.uuid().optional(),
          deleted: z
            .enum(['true', 'false'])
            .optional()
            .transform((value) => value === 'true'),
          cursor: z.string().max(400).optional().describe('nextCursor from the previous page'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: { 200: TicketPageSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => {
      const { contactId, companyId, deleted, cursor, limit, sort, q, overdue, ...lists } =
        request.query;
      const filters = checkFilters(
        Object.fromEntries(
          Object.entries(lists).flatMap(([key, value]) =>
            typeof value === 'string' ? [[key, value.split(',').filter(Boolean)]] : [],
          ),
        ),
      );
      return listTickets(
        deps,
        await signedIn(request),
        { ...filters, q, overdue, contactId, companyId, deleted },
        { cursor, limit, sort },
      );
    },
  );

  app.get(
    '/ticket-views',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Your saved views and shared ones, A to Z',
        response: {
          200: z.object({ views: z.array(SavedViewSchema) }).meta({ id: 'SavedViewList' }),
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request) => ({ views: await listViews(deps, await signedIn(request)) }),
  );

  app.post(
    '/ticket-views',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Save a view',
        description: `Up to ${String(MAX_VIEWS_PER_PERSON)} per person (409). shared=true needs views.manage_shared (admins and supervisors).`,
        body: CreateSavedViewSchema,
        response: { 200: SavedViewSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => createView(deps, await signedIn(request), request.body),
  );

  app.patch(
    '/ticket-views/:viewId',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Change a saved view',
        description:
          'Your own views; shared views also for views.manage_shared, which sharing and unsharing need too.',
        params: ViewIdParams,
        body: UpdateSavedViewSchema,
        response: { 200: SavedViewSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateView(deps, await signedIn(request), request.params.viewId, request.body),
  );

  app.delete(
    '/ticket-views/:viewId',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Delete a saved view',
        params: ViewIdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteView(deps, await signedIn(request), request.params.viewId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/tickets',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Create a ticket',
        description:
          'Needs a subject and a requester (contactId, or contact by name and email or phone). Status open and priority medium unless given; resolved or closed need the "required when resolving" fields.',
        body: CreateTicketSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => createTicket(deps, await signedIn(request), request.body),
  );

  app.get(
    '/tickets/tags',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Tags in use, for suggestions',
        description: 'Up to 10, most used first; q matches the start of the tag.',
        querystring: z.object({ q: z.string().max(TAG_MAX).optional() }),
        response: {
          200: z.object({ tags: z.array(z.string()) }).meta({ id: 'TagSuggestions' }),
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request) => ({
      tags: await suggestTags(deps, await signedIn(request), request.query.q),
    }),
  );

  app.get(
    '/tickets/:number',
    {
      schema: {
        tags: ['tickets'],
        summary: 'One ticket',
        params: NumberParams,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => getTicket(deps, await signedIn(request), request.params.number),
  );

  app.patch(
    '/tickets/:number',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Change a ticket',
        description:
          'Only the fields given change; tags replaces the list; customFields merges by key. Recorded in the ticket history. 409 for a deleted ticket.',
        params: NumberParams,
        body: UpdateTicketSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      updateTicket(deps, await signedIn(request), request.params.number, request.body),
  );

  app.get(
    '/tickets/:number/activity',
    {
      schema: {
        tags: ['tickets'],
        summary: "A ticket's history, oldest first",
        params: NumberParams,
        response: {
          200: z.object({ activity: z.array(ActivitySchema) }).meta({ id: 'TicketActivityList' }),
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request) => ({
      activity: await ticketActivity(deps, await signedIn(request), request.params.number),
    }),
  );

  app.delete(
    '/tickets/:number',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Move a ticket to the trash',
        description: 'Admins (tickets.delete). Restorable. Recorded in the audit log.',
        params: NumberParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteTicket(deps, await signedIn(request), request.params.number);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/tickets/:number/restore',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Bring a ticket back from the trash',
        description: 'Admins (tickets.delete). Recorded in the audit log.',
        params: NumberParams,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => restoreTicket(deps, await signedIn(request), request.params.number),
  );

  app.post(
    '/tickets/:number/merge',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Merge other tickets into this one',
        description: `Admins and supervisors (tickets.merge). 1 to ${String(MAX_MERGED)} others: their messages, notes, files and tags move here; they are closed and read-only; their requesters are copied on replies. No undo; recorded in the audit log. 409 for deleted or merged tickets.`,
        params: NumberParams,
        body: MergeSchema,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      mergeTickets(deps, await signedIn(request), request.params.number, request.body),
  );

  app.post(
    '/tickets/:number/messages/:messageId/split',
    {
      schema: {
        tags: ['tickets'],
        summary: "Split a customer's message into a new ticket",
        description:
          'Every member. Same requester, with its files; the message leaves this ticket. Answers the new ticket. 409 for messages not from the customer.',
        params: SplitParams,
        response: { 200: TicketSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      splitMessage(deps, await signedIn(request), request.params.number, request.params.messageId),
  );

  done();
};
