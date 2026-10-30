import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { getHome } from './home.service.js';

const count = (description: string) => z.number().int().describe(description);

const HomeSchema = z
  .object({
    counts: z.object({
      mine: count('Unresolved tickets assigned to the signed-in person'),
      overdue: count('Tickets past an SLA deadline that is still running'),
      unassigned: count('Unresolved tickets nobody is assigned to'),
      waitingOnCustomer: count("The signed-in person's tickets waiting on the customer"),
    }),
    setup: z
      .object({
        teamInvited: z.boolean().describe('Someone besides the owner joined or was invited'),
        emailConnected: z.boolean().describe('A ticket came in by email'),
        businessHoursSet: z.boolean().describe('The business hours were saved'),
      })
      .nullable()
      .describe('The setup checklist; null for people who cannot change settings'),
  })
  .meta({ id: 'Home' });

/** The home page (F29): the signed-in person's work and the admins' setup checklist. */
export const homeRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  app.get(
    '/home',
    {
      schema: {
        tags: ['home'],
        summary: 'Counts for the home page and what is left to set up',
        description:
          'Each count uses the same filters as the ticket list it opens (assignee=me, overdue=true, assignee=none, and so on).',
        response: { 200: HomeSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => getHome(deps, await requireSignedIn(deps.config, deps.db, request)),
  );

  done();
};
