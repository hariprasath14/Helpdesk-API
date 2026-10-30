import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { ACTION_TYPES } from './actions.js';
import { ALL_OPERATORS } from './conditions.js';
import { RULE_EVENTS } from './models.js';
import {
  createRule,
  deleteRule,
  listRules,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  MAX_RULES,
  reorderRules,
  testRule,
  updateRule,
} from './rules.service.js';

const value = z.union([z.string().max(2000), z.array(z.string().max(200)).max(50)]);

const ConditionSchema = z
  .object({
    field: z
      .string()
      .max(120)
      .describe(
        'subject, description, subject_or_description, requester_email, status, priority, type, source, team, assignee, company, tags; changed, previous_status, message (event-only); hours_in_status, hours_since_created, hours_since_updated (time rules); or ticket.<key>, contact.<key>, company.<key> for custom fields',
      ),
    operator: z.enum(ALL_OPERATORS),
    value: value.optional().describe('A list for contains_any, contains_none, is_any and is_none'),
  })
  .meta({ id: 'RuleCondition' });

export const ConditionsSchema = z
  .object({
    match: z.enum(['all', 'any']),
    items: z.array(ConditionSchema).max(MAX_CONDITIONS),
  })
  .meta({ id: 'RuleConditions' });

const ActionSchema = z
  .object({
    type: z.enum(ACTION_TYPES),
    value: value.describe(
      'The priority, status or type; a team or member id, or "none"; tags; or the note text',
    ),
  })
  .meta({ id: 'RuleAction' });

const RuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    event: z.enum(RULE_EVENTS),
    enabled: z.boolean(),
    position: z.number().int(),
    conditions: ConditionsSchema,
    actions: z.array(ActionSchema),
    stopAfter: z.boolean().describe('When it matches, later rules for the same event do not run'),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'Rule' });

const RuleListSchema = z.object({ rules: z.array(RuleSchema) }).meta({ id: 'RuleList' });

const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');

const CreateRuleSchema = z
  .object({
    name,
    event: z.enum(RULE_EVENTS),
    enabled: z.boolean().optional(),
    conditions: ConditionsSchema,
    actions: z.array(ActionSchema).max(MAX_ACTIONS),
    stopAfter: z.boolean().optional(),
  })
  .meta({ id: 'CreateRuleRequest' });

const UpdateRuleSchema = z
  .object({
    name: name.optional(),
    event: z.enum(RULE_EVENTS).optional(),
    enabled: z.boolean().optional(),
    conditions: ConditionsSchema.optional(),
    actions: z.array(ActionSchema).max(MAX_ACTIONS).optional(),
    stopAfter: z.boolean().optional(),
  })
  .meta({ id: 'UpdateRuleRequest' });

const ReorderRulesSchema = z
  .object({ ruleIds: z.array(z.uuid()).max(MAX_RULES).describe('Every rule, in the new order') })
  .meta({ id: 'ReorderRulesRequest' });

const TestRuleSchema = z
  .object({ conditions: ConditionsSchema, ticketNumber: z.number().int().min(1) })
  .meta({ id: 'TestRuleRequest' });

const TestRuleResultSchema = z
  .object({
    matched: z.boolean(),
    results: z.array(z.boolean()).describe('Whether each condition matched, in order'),
  })
  .meta({ id: 'TestRuleResult' });

const RuleIdParams = z.object({ ruleId: z.uuid() });

/**
 * Rules (F17): when something happens to a ticket and the conditions match, do the actions.
 * Admins manage them (settings.manage).
 */
export const rulesRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/rules',
    {
      schema: {
        tags: ['rules'],
        summary: 'The rules, in order (admins)',
        response: { 200: RuleListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => ({ rules: await listRules(deps, await signedIn(request)) }),
  );

  app.post(
    '/rules',
    {
      schema: {
        tags: ['rules'],
        summary: 'Add a rule at the end (admins)',
        body: CreateRuleSchema,
        response: { 200: RuleSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => createRule(deps, await signedIn(request), request.body),
  );

  app.patch(
    '/rules/:ruleId',
    {
      schema: {
        tags: ['rules'],
        summary: 'Change a rule (admins)',
        params: RuleIdParams,
        body: UpdateRuleSchema,
        response: { 200: RuleSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateRule(deps, await signedIn(request), request.params.ruleId, request.body),
  );

  app.delete(
    '/rules/:ruleId',
    {
      schema: {
        tags: ['rules'],
        summary: 'Delete a rule (admins)',
        params: RuleIdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteRule(deps, await signedIn(request), request.params.ruleId);
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/rules/order',
    {
      schema: {
        tags: ['rules'],
        summary: 'Put the rules in a new order (admins)',
        body: ReorderRulesSchema,
        response: { 200: RuleListSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => ({
      rules: await reorderRules(deps, await signedIn(request), request.body.ruleIds),
    }),
  );

  app.post(
    '/rules/test',
    {
      schema: {
        tags: ['rules'],
        summary: 'Whether conditions would match a ticket now (admins); changes nothing',
        body: TestRuleSchema,
        response: { 200: TestRuleResultSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => testRule(deps, await signedIn(request), request.body),
  );

  done();
};
