import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import {
  createCannedResponse,
  deleteCannedResponse,
  fillCannedResponse,
  listCannedResponses,
  MAX_PERSONAL,
  MAX_SHARED,
  updateCannedResponse,
} from './canned-responses.service.js';
import { PLACEHOLDERS } from './placeholders.js';

const CannedResponseSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    shared: z.boolean().describe('Everyone in the workspace sees it; otherwise it is your own'),
    mine: z.boolean(),
    authorName: z.string(),
    canEdit: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .meta({ id: 'CannedResponse' });

const PlaceholderSchema = z
  .object({
    key: z.string().describe('Written in the text as {{key}}'),
    label: z.string(),
  })
  .meta({ id: 'Placeholder' });

const CannedResponseListSchema = z
  .object({
    cannedResponses: z.array(CannedResponseSchema),
    placeholders: z.array(PlaceholderSchema),
  })
  .meta({ id: 'CannedResponseList' });

const title = z.string().trim().min(1, 'Enter a title.').max(80, 'Use at most 80 characters.');
const body = z.string().trim().min(1, 'Enter the text.').max(5000, 'Use at most 5,000 characters.');

const CreateCannedResponseSchema = z
  .object({
    title,
    body,
    shared: z.boolean().optional().describe('Needs canned_responses.manage_shared'),
  })
  .meta({ id: 'CreateCannedResponseRequest' });

const UpdateCannedResponseSchema = z
  .object({
    title: title.optional(),
    body: body.optional(),
    shared: z.boolean().optional().describe('Changing it needs canned_responses.manage_shared'),
  })
  .meta({ id: 'UpdateCannedResponseRequest' });

const FilledSchema = z.object({ body: z.string() }).meta({ id: 'FilledCannedResponse' });

const IdParams = z.object({ cannedResponseId: z.uuid() });
const FillQuery = z.object({
  ticketNumber: z.coerce.number().int().positive().max(2_147_483_647),
});

/**
 * Canned responses (F21): saved replies for the composer, an agent's own or shared with the
 * workspace (canned_responses.manage_shared: admins and supervisors).
 */
export const cannedResponsesRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/canned-responses',
    {
      schema: {
        tags: ['canned-responses'],
        summary: 'Your canned responses and the shared ones, A to Z, with the placeholders',
        response: { 200: CannedResponseListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => ({
      cannedResponses: await listCannedResponses(deps, await signedIn(request)),
      placeholders: PLACEHOLDERS.map(({ key, label }) => ({ key, label })),
    }),
  );

  app.post(
    '/canned-responses',
    {
      schema: {
        tags: ['canned-responses'],
        summary: 'Save a canned response',
        description: `Up to ${String(MAX_PERSONAL)} per person and ${String(MAX_SHARED)} shared per workspace (409). Unknown placeholders are refused (400).`,
        body: CreateCannedResponseSchema,
        response: { 200: CannedResponseSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => createCannedResponse(deps, await signedIn(request), request.body),
  );

  app.patch(
    '/canned-responses/:cannedResponseId',
    {
      schema: {
        tags: ['canned-responses'],
        summary: 'Change a canned response (your own, or shared ones if you manage them)',
        params: IdParams,
        body: UpdateCannedResponseSchema,
        response: { 200: CannedResponseSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateCannedResponse(
        deps,
        await signedIn(request),
        request.params.cannedResponseId,
        request.body,
      ),
  );

  app.delete(
    '/canned-responses/:cannedResponseId',
    {
      schema: {
        tags: ['canned-responses'],
        summary: 'Delete a canned response (your own, or shared ones if you manage them)',
        params: IdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteCannedResponse(deps, await signedIn(request), request.params.cannedResponseId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/canned-responses/:cannedResponseId/filled',
    {
      schema: {
        tags: ['canned-responses'],
        summary: 'The text with its placeholders filled in for a ticket',
        params: IdParams,
        querystring: FillQuery,
        response: { 200: FilledSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      fillCannedResponse(
        deps,
        await signedIn(request),
        request.params.cannedResponseId,
        request.query.ticketNumber,
      ),
  );

  done();
};
