import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../../db/index.js';
import type { Config } from '../../config/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { exportAuditCsv, listAudit, type AuditFilters } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_CATEGORIES } from './models.js';

const filterFields = {
  from: z.iso.datetime({ offset: true }).optional().describe('Entries at or after this time'),
  to: z.iso.datetime({ offset: true }).optional().describe('Entries before this time'),
  actorId: z.uuid().optional().describe('Only entries by this person'),
  category: z.enum(AUDIT_CATEGORIES).optional(),
  q: z.string().trim().max(100).optional().describe('Search the person affected or who acted'),
};

const AuditListQuerySchema = z.object({
  ...filterFields,
  cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const AuditExportQuerySchema = z.object(filterFields);

const AuditEntrySchema = z
  .object({
    id: z.string(),
    occurredAt: z.date(),
    actor: z.object({
      type: z.enum(['member', 'support', 'system']),
      userId: z.string().nullable(),
      name: z.string(),
      email: z.string().nullable(),
      role: z.enum(['admin', 'supervisor', 'agent']).nullable(),
    }),
    category: z.enum(AUDIT_CATEGORIES),
    action: z.enum(Object.keys(AUDIT_ACTIONS) as [keyof typeof AUDIT_ACTIONS]),
    summary: z.string().describe('The entry as one plain sentence'),
    target: z.object({ type: z.string(), id: z.string().nullable(), label: z.string() }).nullable(),
    details: z.record(z.string(), z.unknown()),
    ip: z.string().nullable(),
    device: z.string().describe('For example "Chrome on Windows"'),
  })
  .meta({ id: 'AuditEntry' });

const AuditPageSchema = z
  .object({
    entries: z.array(AuditEntrySchema),
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
  })
  .meta({ id: 'AuditPage' });

function toFilters(query: z.infer<typeof AuditExportQuerySchema>): AuditFilters {
  return {
    from: query.from ? new Date(query.from) : undefined,
    to: query.to ? new Date(query.to) : undefined,
    actorId: query.actorId,
    category: query.category,
    q: query.q,
  };
}

/** The workspace's audit log (admins): a page at a time, or the filtered list as CSV. */
export const auditRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  app.get(
    '/audit-log',
    {
      schema: {
        tags: ['audit'],
        summary: 'The audit log, newest first',
        description:
          'Admins only. Pages with a cursor; filters by time, person, category and search.',
        querystring: AuditListQuerySchema,
        response: { 200: AuditPageSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => {
      const signedIn = await requireSignedIn(deps.config, deps.db, request);
      return listAudit(deps, signedIn, toFilters(request.query), {
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  );

  app.get(
    '/audit-log/export',
    {
      config: { rateLimit: { max: 10, timeWindow: 60 * 1000 } },
      schema: {
        tags: ['audit'],
        summary: 'Download the filtered audit log as CSV',
        description:
          'Admins only. Up to 10,000 rows, times in the workspace time zone and in UTC. Cells that a spreadsheet could run as a formula are made safe.',
        produces: ['text/csv'],
        querystring: AuditExportQuerySchema,
        response: { 200: z.string().describe('CSV file'), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const signedIn = await requireSignedIn(deps.config, deps.db, request);
      const csv = await exportAuditCsv(deps, signedIn, toFilters(request.query));
      const date = new Date().toISOString().slice(0, 10);
      return reply
        .type('text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="audit-log-${signedIn.workspace.subdomain}-${date}.csv"`,
        )
        .serializer((payload) => payload as string)
        .send(csv);
    },
  );

  done();
};
