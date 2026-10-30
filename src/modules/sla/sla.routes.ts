import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { ConditionsSchema } from '../rules/rules.routes.js';
import { DURATION_UNITS, REASSIGN_TO, SLA_HOURS } from './clock.js';
import {
  createPolicy,
  deletePolicy,
  listPolicies,
  MAX_POLICIES,
  reorderPolicies,
  updatePolicy,
} from './sla.service.js';

const DurationSchema = z
  .object({
    amount: z.number().int().min(1, 'Enter at least 1.').max(999, 'Enter at most 999.'),
    unit: z.enum(DURATION_UNITS),
  })
  .refine((duration) => duration.unit !== 'days' || duration.amount <= 365, {
    message: 'Enter at most 365 days.',
    path: ['amount'],
  })
  .meta({ id: 'SlaDuration' });

const PriorityTargetSchema = z
  .object({
    reply: DurationSchema.describe('First reply the customer sees (not a note)'),
    resolve: DurationSchema,
    hours: z
      .enum(SLA_HOURS)
      .describe(
        'business: only business hours count, a day is a working day; calendar: every hour',
      ),
  })
  .meta({ id: 'SlaPriorityTarget' });

const TargetsSchema = z
  .object({
    urgent: PriorityTargetSchema,
    high: PriorityTargetSchema,
    medium: PriorityTargetSchema,
    low: PriorityTargetSchema,
  })
  .meta({ id: 'SlaTargets' });

const EscalationSchema = z
  .object({
    warnMinutes: z
      .number()
      .int()
      .min(1, 'Enter at least 1 minute.')
      .max(1440, 'Enter at most 1,440 minutes (a day).')
      .nullable()
      .describe('Warn this many minutes before each deadline; null for no warning'),
    reassign: z
      .enum(REASSIGN_TO)
      .describe(
        'At a deadline: nobody (keep the assignee), team_lead, person (reassignUserId) or team (unassigned)',
      ),
    reassignUserId: z.uuid().nullable().describe('The person, for reassign = person'),
  })
  .meta({ id: 'SlaEscalation' });

const SlaPolicySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    isDefault: z.boolean().describe('Covers every ticket no other policy matches; always last'),
    position: z.number().int(),
    conditions: ConditionsSchema,
    targets: TargetsSchema,
    escalation: EscalationSchema.describe(
      'At a deadline the ticket is marked overdue and the team leads are told, then this',
    ),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'SlaPolicy' });

const SlaPolicyListSchema = z
  .object({ policies: z.array(SlaPolicySchema).describe('In order; the default is last') })
  .meta({ id: 'SlaPolicyList' });

const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');

const CreateSlaPolicySchema = z
  .object({
    name,
    conditions: ConditionsSchema,
    targets: TargetsSchema,
    escalation: EscalationSchema.optional().describe('Warn 10 minutes before when left out'),
  })
  .meta({ id: 'CreateSlaPolicyRequest' });

const UpdateSlaPolicySchema = z
  .object({
    name: name.optional(),
    conditions: ConditionsSchema.optional().describe('Not for the default policy'),
    targets: TargetsSchema.optional(),
    escalation: EscalationSchema.optional(),
  })
  .meta({ id: 'UpdateSlaPolicyRequest' });

const ReorderSchema = z
  .object({ policyIds: z.array(z.uuid()).max(MAX_POLICIES) })
  .meta({ id: 'ReorderSlaPoliciesRequest' });

const IdParams = z.object({ policyId: z.uuid() });

/**
 * SLA policies (F23): per priority, how soon a ticket needs its first reply and to be resolved.
 * Admins only (settings.manage).
 */
export const slaRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/sla-policies',
    {
      schema: {
        tags: ['sla'],
        summary: 'The SLA policies, in the order they are tried, the default last',
        response: { 200: SlaPolicyListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => ({ policies: await listPolicies(deps, await signedIn(request)) }),
  );

  app.post(
    '/sla-policies',
    {
      schema: {
        tags: ['sla'],
        summary: 'Add a policy with conditions, tried before the default',
        description: `The first policy whose conditions match a ticket wins. Up to ${String(MAX_POLICIES)} policies (409).`,
        body: CreateSlaPolicySchema,
        response: { 200: SlaPolicySchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => createPolicy(deps, await signedIn(request), request.body),
  );

  app.put(
    '/sla-policies/order',
    {
      schema: {
        tags: ['sla'],
        summary: 'Reorder the policies with conditions',
        description: 'Every policy id except the default, once each (409 if they changed).',
        body: ReorderSchema,
        response: { 200: SlaPolicyListSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => ({
      policies: await reorderPolicies(deps, await signedIn(request), request.body.policyIds),
    }),
  );

  app.patch(
    '/sla-policies/:policyId',
    {
      schema: {
        tags: ['sla'],
        summary: 'Change a policy',
        description: 'Applies to due times worked out from now on (new tickets, priority changes).',
        params: IdParams,
        body: UpdateSlaPolicySchema,
        response: { 200: SlaPolicySchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updatePolicy(deps, await signedIn(request), request.params.policyId, request.body),
  );

  app.delete(
    '/sla-policies/:policyId',
    {
      schema: {
        tags: ['sla'],
        summary: 'Delete a policy with conditions (not the default, 409)',
        params: IdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await deletePolicy(deps, await signedIn(request), request.params.policyId);
      return reply.code(204).send(null);
    },
  );

  done();
};
