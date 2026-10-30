import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { NOTIFICATION_KINDS } from './models.js';
import {
  emailChoices,
  listNotifications,
  markRead,
  UNREAD_MAX,
  unreadCount,
  updateEmailChoices,
} from './notifications.service.js';

const NotificationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(NOTIFICATION_KINDS),
    title: z.string(),
    body: z.string(),
    ticket: z
      .object({ number: z.number().int(), subject: z.string() })
      .nullable()
      .describe('null once the ticket is gone'),
    read: z.boolean(),
    createdAt: z.date(),
  })
  .meta({ id: 'Notification' });

const unread = z
  .number()
  .int()
  .describe(
    `Unread notifications, counted up to ${String(UNREAD_MAX + 1)} (shown as ${String(UNREAD_MAX)}+)`,
  );

const NotificationPageSchema = z
  .object({
    notifications: z.array(NotificationSchema),
    unread,
    nextCursor: z.string().nullable().describe('Pass as cursor for the next page; null at the end'),
  })
  .meta({ id: 'NotificationPage' });

const UnreadSchema = z.object({ unread }).meta({ id: 'NotificationUnread' });

const EmailChoicesSchema = z
  .object({
    assigned: z.boolean().describe('A ticket is assigned to you'),
    mention: z.boolean().describe('Someone @mentions you in a note'),
    sla_warning: z.boolean().describe('An SLA deadline is near'),
    sla_breach: z.boolean().describe('An SLA deadline passed'),
    customer_reply: z.boolean().describe('The customer replies on a ticket assigned to you'),
  })
  .meta({ id: 'NotificationEmailChoices' });

const MarkReadSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100).optional().describe('Leave out for all'),
  })
  .meta({ id: 'MarkNotificationsReadRequest' });

const UpdateEmailChoicesSchema = EmailChoicesSchema.partial().meta({
  id: 'UpdateNotificationEmailRequest',
});

/**
 * The notification center (F25): every member's own notifications, and which kinds also come by
 * email. Members only ever see their own.
 */
export const notificationsRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/notifications',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Your notifications, newest first',
        querystring: z.object({
          cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: NotificationPageSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => listNotifications(deps, await signedIn(request), request.query),
  );

  app.get(
    '/notifications/unread',
    {
      schema: {
        tags: ['notifications'],
        summary: 'How many of your notifications are unread, for the bell',
        response: { 200: UnreadSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => ({ unread: await unreadCount(deps, await signedIn(request)) }),
  );

  app.post(
    '/notifications/read',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Mark notifications read: the ones given, or all of yours',
        description: 'One id that is not yours answers 404.',
        body: MarkReadSchema,
        response: { 200: UnreadSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => markRead(deps, await signedIn(request), request.body.ids),
  );

  app.get(
    '/notifications/email',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Which kinds also come to you by email, in this workspace',
        response: { 200: EmailChoicesSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => emailChoices(deps, await signedIn(request)),
  );

  app.patch(
    '/notifications/email',
    {
      schema: {
        tags: ['notifications'],
        summary: 'Choose which kinds also come by email; in the app they always show',
        body: UpdateEmailChoicesSchema,
        response: { 200: EmailChoicesSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => updateEmailChoices(deps, await signedIn(request), request.body),
  );

  done();
};
