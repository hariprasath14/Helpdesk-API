import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import type { JobQueue } from '../../jobs/queue.js';
import { NotFoundError } from '../../lib/errors.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn, requireWorkspace } from '../accounts/request-context.js';
import {
  publicWebForm,
  submitWebForm,
  updateWebFormSettings,
  webFormSettings,
} from './web-form.service.js';

const PublicWebFormSchema = z
  .object({
    enabled: z.boolean().describe('False: the page says the form is not available'),
    workspaceName: z.string(),
    title: z.string(),
    intro: z.string(),
  })
  .meta({ id: 'PublicWebForm' });

const WebFormRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Enter your name.').max(120, 'Use at most 120 characters.'),
    email: z.email('Enter a valid email address.').max(254),
    subject: z.string().trim().min(1, 'Enter a subject.').max(200, 'Use at most 200 characters.'),
    description: z
      .string()
      .trim()
      .min(1, 'Tell us how we can help.')
      .max(20_000, 'Use at most 20,000 characters.'),
    website: z
      .string()
      .max(200)
      .optional()
      .describe('Leave empty: a hidden field that only bots fill in'),
  })
  .meta({ id: 'WebFormRequest' });

const WebFormReceivedSchema = z
  .object({ received: z.literal(true) })
  .meta({ id: 'WebFormReceived' });

const WebFormSettingsSchema = z
  .object({
    enabled: z.boolean(),
    title: z.string(),
    intro: z.string(),
    url: z.string().describe('The page to link to or embed'),
  })
  .meta({ id: 'WebFormSettings' });

const UpdateWebFormSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z
      .string()
      .trim()
      .min(1, 'Enter a title.')
      .max(80, 'Use at most 80 characters.')
      .optional(),
    intro: z.string().trim().max(1000, 'Use at most 1,000 characters.').optional(),
  })
  .meta({ id: 'UpdateWebFormSettingsRequest' });

/**
 * The web form (F16): the public page's form and submissions (no sign-in, on the workspace
 * address), and Settings → Web form (admins).
 */
export const webFormRoutes: FastifyPluginCallbackZod<{
  config: Config;
  db: Database;
  jobs: JobQueue;
}> = (app, deps, done) => {
  const withLog = (log: FastifyBaseLogger) => ({ ...deps, log });

  app.get(
    '/web-form',
    {
      schema: {
        tags: ['web-form'],
        summary: "The workspace's public form (no sign-in)",
        response: { 200: PublicWebFormSchema, ...errorResponses(404) },
      },
    },
    async (request) => publicWebForm(await requireWorkspace(deps.config, deps.db, request)),
  );

  app.post(
    '/web-form/requests',
    {
      config: { rateLimit: { max: 5, timeWindow: 10 * 60 * 1000 } },
      schema: {
        tags: ['web-form'],
        summary: 'Send a request through the public form (no sign-in)',
        description:
          'Makes a ticket and emails the person that it arrived. 404 when the form is off. The answer is the same when the request is dropped (bot field filled, or too many from one person).',
        body: WebFormRequestSchema,
        response: { 200: WebFormReceivedSchema, ...errorResponses(404) },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      const { website, ...submission } = request.body;
      if (!workspace.webForm.enabled) throw new NotFoundError('This form is not available.');
      // A bot filled the hidden field: answer as usual so it learns nothing.
      if (website) {
        request.log.info({ workspaceId: workspace.id }, 'web form request dropped (bot field)');
        return { received: true as const };
      }
      await submitWebForm(withLog(request.log), workspace, submission);
      return { received: true as const };
    },
  );

  app.get(
    '/workspace/web-form',
    {
      schema: {
        tags: ['web-form'],
        summary: "The workspace's web form settings (admins)",
        response: { 200: WebFormSettingsSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      webFormSettings(withLog(request.log), await requireSignedIn(deps.config, deps.db, request)),
  );

  app.patch(
    '/workspace/web-form',
    {
      schema: {
        tags: ['web-form'],
        summary: 'Turn the web form on or off, or change its text (admins)',
        body: UpdateWebFormSettingsSchema,
        response: { 200: WebFormSettingsSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateWebFormSettings(
        withLog(request.log),
        await requireSignedIn(deps.config, deps.db, request),
        request.body,
      ),
  );

  done();
};
