import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { EmailSender } from '../../adapters/email/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { emailSettings, sendTestEmail, updateEmailSettings } from './email-settings.service.js';

const CustomerNotificationsSchema = z
  .object({
    received: z
      .boolean()
      .describe('"We received your request" for tickets raised by email or the web form'),
    resolved: z.boolean().describe('"Your ticket is resolved; reply to reopen it"'),
    agentCreated: z.boolean().describe('"A ticket was opened for you" when an agent logs one'),
  })
  .meta({ id: 'CustomerNotifications' });

const EmailSettingsSchema = z
  .object({
    senderName: z.string().nullable().describe('Null means the workspace name is used'),
    workspaceName: z.string(),
    address: z
      .string()
      .describe('Ticket email goes out from it; email sent to it becomes a ticket (F14)'),
    from: z.string().describe('How the From line looks to customers'),
    customerNotifications: CustomerNotificationsSchema,
  })
  .meta({ id: 'EmailSettings' });

const UpdateEmailSettingsSchema = z
  .object({
    senderName: z
      .string()
      .trim()
      .max(80, 'Use at most 80 characters.')
      .nullable()
      .optional()
      .describe('Empty or null goes back to the workspace name'),
    customerNotifications: CustomerNotificationsSchema.partial()
      .optional()
      .describe('Only the ones given change'),
  })
  .meta({ id: 'UpdateEmailSettingsRequest' });

const TestEmailSentSchema = z
  .object({ to: z.string().describe('Your own email address') })
  .meta({ id: 'TestEmailSent' });

/** Settings → Email (admins): the sender name customers see, and a test email. */
export const emailRoutes: FastifyPluginCallbackZod<{
  config: Config;
  db: Database;
  email: EmailSender;
}> = (app, deps, done) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);
  const withLog = (log: FastifyBaseLogger) => ({ ...deps, log });

  app.get(
    '/workspace/email',
    {
      schema: {
        tags: ['email'],
        summary: "The workspace's email settings (admins)",
        response: { 200: EmailSettingsSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => emailSettings(withLog(request.log), await signedIn(request)),
  );

  app.patch(
    '/workspace/email',
    {
      schema: {
        tags: ['email'],
        summary: 'Change the sender name and customer notifications (admins)',
        body: UpdateEmailSettingsSchema,
        response: { 200: EmailSettingsSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      updateEmailSettings(withLog(request.log), await signedIn(request), request.body),
  );

  app.post(
    '/workspace/email/test',
    {
      config: { rateLimit: { max: 5, timeWindow: 10 * 60 * 1000 } },
      schema: {
        tags: ['email'],
        summary: 'Send yourself a test email from the workspace address (admins)',
        response: { 200: TestEmailSentSchema, ...errorResponses(401, 403, 404, 503) },
      },
    },
    async (request) => sendTestEmail(withLog(request.log), await signedIn(request)),
  );

  done();
};
