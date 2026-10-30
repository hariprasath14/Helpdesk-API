import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { FileStorage } from '../../adapters/storage/index.js';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import type { JobQueue } from '../../jobs/queue.js';
import { ValidationError } from '../../lib/errors.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { TICKET_STATUSES } from '../tickets/models.js';
import {
  downloadAttachment,
  MAX_ATTACHMENTS,
  removeUpload,
  uploadAttachment,
} from './attachments.service.js';
import {
  BODY_MAX,
  listMessages,
  MAX_MENTIONS,
  MAX_RECIPIENTS,
  postMessage,
  resendMessage,
} from './messages.service.js';
import { MESSAGE_KINDS } from './models.js';

const AttachmentSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    contentType: z.string().describe('As the uploader’s browser said; files are always downloaded'),
    size: z.number().int().describe('Bytes'),
  })
  .meta({ id: 'Attachment' });

const MessageSchema = z
  .object({
    id: z.string(),
    kind: z.enum(MESSAGE_KINDS).describe('reply and forward go out by email; note is private'),
    body: z.string().describe('Plain text'),
    bodyHtml: z.string().nullable().describe('Sanitized HTML of customer emails (F14)'),
    author: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('member'), userId: z.string(), name: z.string() }),
        z.object({ type: z.literal('contact'), contactId: z.string(), name: z.string() }),
        z
          .object({ type: z.literal('rule'), name: z.string() })
          .describe('A note added by a rule (F17), named "Rule: <rule name>"'),
      ])
      .nullable(),
    to: z.array(z.string()),
    cc: z.array(z.string()),
    mentions: z.array(z.object({ userId: z.string(), name: z.string() })),
    emailStatus: z
      .enum(['queued', 'sent', 'failed'])
      .nullable()
      .describe(
        'Replies and forwards: queued until the worker sends it, then sent or failed; null for notes',
      ),
    emailSentAt: z.date().nullable(),
    emailError: z.string().nullable().describe('Why sending failed, when emailStatus is failed'),
    attachments: z.array(AttachmentSchema),
    fromTicketNumber: z
      .number()
      .int()
      .nullable()
      .describe('Moved in by a merge: the ticket it came from'),
    createdAt: z.date(),
  })
  .meta({ id: 'TicketMessage' });

const ConversationSchema = z
  .object({
    messages: z.array(MessageSchema),
    descriptionFiles: z
      .array(AttachmentSchema)
      .describe('Files that came with the email that raised the ticket (F14)'),
  })
  .meta({ id: 'TicketConversation' });

const emails = z
  .array(z.email('Enter valid email addresses.').max(254))
  .max(MAX_RECIPIENTS + 10)
  .optional();

const PostMessageSchema = z
  .object({
    kind: z.enum(['reply', 'note', 'forward']),
    body: z.string().max(BODY_MAX, `Use at most ${String(BODY_MAX)} characters.`),
    cc: emails.describe(`Replies: copies, up to ${String(MAX_RECIPIENTS)}`),
    to: emails.describe(`Forwards: recipients, 1 to ${String(MAX_RECIPIENTS)}`),
    mentions: z
      .array(z.uuid())
      .max(MAX_MENTIONS + 10)
      .optional()
      .describe('Notes: user ids of @mentioned members'),
    attachmentIds: z
      .array(z.uuid())
      .max(MAX_ATTACHMENTS + 10)
      .optional()
      .describe(`Your uploads (POST /attachments), up to ${String(MAX_ATTACHMENTS)}`),
    status: z.enum(TICKET_STATUSES).optional().describe('Replies and notes: set the status too'),
  })
  .meta({ id: 'PostMessageRequest' });

const NumberParams = z.object({ number: z.coerce.number().int().positive().max(2_147_483_647) });
const AttachmentParams = z.object({ attachmentId: z.uuid() });

interface ConversationDeps {
  config: Config;
  db: Database;
  jobs: JobQueue;
  storage: FileStorage;
}

/** A ticket's conversation (replies, notes, forwards) and the files sent with it. */
export const conversationRoutes: FastifyPluginAsyncZod<ConversationDeps> = async (app, deps) => {
  const maxBytes = deps.config.ATTACHMENT_MAX_MB * 1024 * 1024;
  const fileDeps = { db: deps.db, storage: deps.storage, maxBytes };
  // Only this plugin's routes accept file uploads. One byte over the limit lets the storage
  // adapter see the file is too big and refuse it.
  await app.register(multipart, {
    limits: { fileSize: maxBytes + 1, files: 1, fields: 0, parts: 1 },
  });
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/tickets/:number/messages',
    {
      schema: {
        tags: ['tickets'],
        summary: "A ticket's conversation, oldest first",
        description:
          'Replies, notes and forwards with their files. The description is on the ticket.',
        params: NumberParams,
        response: { 200: ConversationSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => listMessages(deps, await signedIn(request), request.params.number),
  );

  app.post(
    '/tickets/:number/messages',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Reply, add a note or forward',
        description:
          'A reply goes to the requester (409 when they have no email) plus cc; a forward to "to". Replies and forwards are sent by email in the background (F13). Notes are private and can @mention members. status (replies and notes) changes the ticket too. Answers with the whole conversation. 409 for a deleted ticket.',
        params: NumberParams,
        body: PostMessageSchema,
        response: { 200: ConversationSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      postMessage(deps, await signedIn(request), request.params.number, request.body),
  );

  app.post(
    '/tickets/:number/messages/:messageId/resend',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Send a reply or forward that could not be sent, again',
        description:
          'Only for emailStatus "failed" (409 otherwise). Answers with the conversation.',
        params: NumberParams.extend({ messageId: z.uuid() }),
        response: { 200: ConversationSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      resendMessage(deps, await signedIn(request), request.params.number, request.params.messageId),
  );

  app.post(
    '/attachments',
    {
      config: { rateLimit: { max: 60, timeWindow: 60 * 1000 } },
      schema: {
        tags: ['tickets'],
        summary: 'Upload a file for a message you are writing',
        description: `multipart/form-data with one "file" part, up to ATTACHMENT_MAX_MB (413). Files that run programs (.exe, .bat, .js and similar) are refused. Send its id in attachmentIds with the message; uploads never sent are removed after a day.`,
        consumes: ['multipart/form-data'],
        response: { 200: AttachmentSchema, ...errorResponses(401, 403, 404, 413, 415) },
      },
    },
    async (request) => {
      const member = await signedIn(request);
      if (!request.isMultipart()) {
        throw new ValidationError('Send the file as multipart/form-data.');
      }
      const part = await request.file();
      if (!part) throw new ValidationError('Choose a file to attach.');
      return uploadAttachment(fileDeps, member, {
        fileName: part.filename,
        contentType: part.mimetype,
        content: part.file,
      });
    },
  );

  app.delete(
    '/attachments/:attachmentId',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Remove one of your uploads that was not sent',
        params: AttachmentParams,
        response: { 204: z.null(), ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await removeUpload(fileDeps, await signedIn(request), request.params.attachmentId);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/attachments/:attachmentId',
    {
      schema: {
        tags: ['tickets'],
        summary: 'Download a file',
        description:
          'Always a download, never shown in the page. Files on messages: every member; your unsent uploads: you.',
        produces: ['application/octet-stream'],
        params: AttachmentParams,
        // A stream is sent as it is (Fastify skips serializing it); the schema is for the spec.
        response: { 200: z.unknown().describe('The file'), ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const { attachment, file } = await downloadAttachment(
        fileDeps,
        await signedIn(request),
        request.params.attachmentId,
      );
      if ('redirectTo' in file) return reply.redirect(file.redirectTo);
      return reply
        .type('application/octet-stream')
        .header('content-length', String(file.size))
        .header(
          'content-disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        )
        .header('cache-control', 'private, no-store')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(file.stream);
    },
  );
};
