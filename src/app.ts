import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { createEmailSender, type EmailSender } from './adapters/email/index.js';
import { createFileStorage, type FileStorage } from './adapters/storage/index.js';
import { createJobQueue, type JobQueue } from './jobs/queue.js';
import type { Config } from './config/index.js';
import type { Database } from './db/index.js';
import { loggerOptions } from './lib/logger.js';
import { accountsRoutes } from './modules/accounts/accounts.routes.js';
import { authRoutes } from './modules/accounts/auth.routes.js';
import { membersRoutes } from './modules/accounts/members.routes.js';
import { twoFactorRoutes } from './modules/accounts/two-factor.routes.js';
import {
  createBreachCheck,
  noBreachCheck,
  type BreachCheck,
} from './modules/accounts/passwords.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { businessHoursRoutes } from './modules/business-hours/business-hours.routes.js';
import { cannedResponsesRoutes } from './modules/canned-responses/canned-responses.routes.js';
import { contactsRoutes } from './modules/contacts/contacts.routes.js';
import { conversationRoutes } from './modules/conversation/conversation.routes.js';
import { customFieldsRoutes } from './modules/custom-fields/custom-fields.routes.js';
import { emailRoutes } from './modules/email/email.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { homeRoutes } from './modules/home/home.routes.js';
import { teamsRoutes } from './modules/teams/teams.routes.js';
import { notificationsRoutes } from './modules/notifications/notifications.routes.js';
import { rulesRoutes } from './modules/rules/rules.routes.js';
import { slaRoutes } from './modules/sla/sla.routes.js';
import { ticketsRoutes } from './modules/tickets/tickets.routes.js';
import { webFormRoutes } from './modules/web-form/web-form.routes.js';
import { apiContractPlugin } from './plugins/api-contract.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { sameOriginPlugin } from './plugins/same-origin.js';
import { securityPlugin } from './plugins/security.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Writer and reader connections; modules use them through withWorkspace(). */
    db: Database;
  }
}

export interface BuildAppOptions {
  /** Opened and closed by the caller (server.ts or a test), so one pool can outlive an app instance. */
  db: Database;
  /** Where log lines go. Tests pass a stream to inspect them; normally stdout. */
  logStream?: NodeJS.WritableStream;
  /** Replaces the email adapter chosen by EMAIL_DRIVER (tests capture emails instead of sending). */
  email?: EmailSender;
  /** Replaces the breached-password check (tests avoid calling Have I Been Pwned). */
  breachCheck?: BreachCheck;
  /** Replaces the file storage chosen by STORAGE_DRIVER. */
  storage?: FileStorage;
  /** Replaces the background job queue (pg-boss on the writer connection). */
  jobs?: JobQueue;
}

/** Builds the Fastify app without listening, so tests can call it with `app.inject()`. */
export async function buildApp(config: Config, options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config, options.logStream),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Always generate our own ID; a client-supplied X-Request-Id is never trusted.
    genReqId: () => randomUUID(),
  });

  app.decorate('db', options.db);

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin, { config });
  await app.register(sameOriginPlugin);
  await app.register(cookie);
  // Must come before any route, so every route is validated and appears in the OpenAPI spec.
  await app.register(apiContractPlugin, { config });

  await app.register(healthRoutes, { config, db: options.db });

  const breachCheck =
    options.breachCheck ??
    (config.PASSWORD_BREACH_CHECK
      ? createBreachCheck(fetch, (error) => {
          app.log.warn({ err: error }, 'breached-password check unavailable; skipped');
        })
      : noBreachCheck);
  const accountDeps = {
    config,
    db: options.db,
    email: options.email ?? createEmailSender(config),
    breachCheck,
  };
  await app.register(accountsRoutes, { prefix: '/api/v1', ...accountDeps });
  await app.register(authRoutes, { prefix: '/api/v1', ...accountDeps });
  await app.register(twoFactorRoutes, { prefix: '/api/v1', ...accountDeps });
  await app.register(membersRoutes, { prefix: '/api/v1', ...accountDeps });
  await app.register(auditRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(customFieldsRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(contactsRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(teamsRoutes, { prefix: '/api/v1', config, db: options.db });
  const jobs = options.jobs ?? createJobQueue(options.db.writer);
  if (!options.jobs) {
    app.addHook('onClose', async () => {
      await jobs.stop();
    });
  }
  const email = accountDeps.email;
  await app.register(ticketsRoutes, { prefix: '/api/v1', config, db: options.db, jobs });
  await app.register(conversationRoutes, {
    prefix: '/api/v1',
    config,
    db: options.db,
    jobs,
    storage: options.storage ?? createFileStorage(config),
  });
  await app.register(emailRoutes, { prefix: '/api/v1', config, db: options.db, email });
  await app.register(webFormRoutes, { prefix: '/api/v1', config, db: options.db, jobs });
  await app.register(rulesRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(cannedResponsesRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(businessHoursRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(slaRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(notificationsRoutes, { prefix: '/api/v1', config, db: options.db });
  await app.register(homeRoutes, { prefix: '/api/v1', config, db: options.db });

  return app;
}
