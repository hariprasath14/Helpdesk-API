import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  MAX_TEAM_MEMBERS,
  updateTeam,
} from './teams.service.js';

const name = z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.');
const description = z
  .string()
  .trim()
  .max(500, 'Use at most 500 characters.')
  .nullable()
  .optional()
  .describe('Empty or null clears it');
const members = z
  .array(
    z.object({
      userId: z.uuid(),
      isLead: z.boolean().optional().describe('Team leads get escalations (F24); default false'),
    }),
  )
  .max(MAX_TEAM_MEMBERS + 10)
  .optional()
  .describe(`Up to ${String(MAX_TEAM_MEMBERS)} people; replaces the list`);

const TeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    members: z
      .array(
        z.object({
          userId: z.string(),
          name: z.string(),
          email: z.string(),
          role: z.enum(['admin', 'supervisor', 'agent']),
          status: z.enum(['active', 'deactivated']),
          isLead: z.boolean(),
        }),
      )
      .describe('Leads first, then A to Z. Deactivated members keep their place.'),
    createdAt: z.date(),
    updatedAt: z.date().describe('Send back as updatedAt when saving, to catch other changes'),
  })
  .meta({ id: 'Team' });

const TeamListSchema = z.object({ teams: z.array(TeamSchema) }).meta({ id: 'TeamList' });

const CreateTeamSchema = z.object({ name, description, members }).meta({ id: 'CreateTeamRequest' });
const UpdateTeamSchema = z
  .object({
    name: name.optional(),
    description,
    members,
    updatedAt: z.coerce
      .date()
      .optional()
      .describe('The version you loaded; 409 TEAM_CHANGED if the team changed since'),
  })
  .meta({ id: 'UpdateTeamRequest' });

const TeamIdParams = z.object({ teamId: z.uuid() });

/** Teams: every member reads them (tickets are routed to teams); admins manage them. */
export const teamsRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/teams',
    {
      schema: {
        tags: ['teams'],
        summary: 'Every team, A to Z, with its members',
        response: { 200: TeamListSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => ({ teams: await listTeams(deps, await signedIn(request)) }),
  );

  app.post(
    '/teams',
    {
      schema: {
        tags: ['teams'],
        summary: 'Add a team',
        description:
          'Admins only (teams.manage). Names are unique in the workspace, ignoring case. Up to 100 teams (409).',
        body: CreateTeamSchema,
        response: { 200: TeamSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => createTeam(deps, await signedIn(request), request.body),
  );

  app.get(
    '/teams/:teamId',
    {
      schema: {
        tags: ['teams'],
        summary: 'One team',
        params: TeamIdParams,
        response: { 200: TeamSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) => getTeam(deps, await signedIn(request), request.params.teamId),
  );

  app.patch(
    '/teams/:teamId',
    {
      schema: {
        tags: ['teams'],
        summary: 'Change a team',
        description:
          'Admins only. Only the fields given change; members replaces the list. Deactivated people can stay but not be added.',
        params: TeamIdParams,
        body: UpdateTeamSchema,
        response: { 200: TeamSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      updateTeam(deps, await signedIn(request), request.params.teamId, request.body),
  );

  app.delete(
    '/teams/:teamId',
    {
      schema: {
        tags: ['teams'],
        summary: 'Delete a team (its members stay in the workspace)',
        description: 'Admins only. Recorded in the audit log.',
        params: TeamIdParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await deleteTeam(deps, await signedIn(request), request.params.teamId);
      return reply.status(204).send(null);
    },
  );

  done();
};
