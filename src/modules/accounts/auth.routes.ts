import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/schemas.js';
import {
  checkResetLink,
  findWorkspaces,
  forgotPassword,
  login,
  logout,
  resetPassword,
} from './auth.service.js';
import {
  readCookie,
  requireMainAddress,
  requireWorkspace,
  sentCsrfToken,
  sessionToken,
  toMe,
} from './request-context.js';
import {
  EmailAcceptedSchema,
  EmailRequestSchema,
  LoginRequestSchema,
  MeSchema,
  ResetPasswordRequestSchema,
  ResetTokenRequestSchema,
  ResetTokenStatusSchema,
  TwoFactorRequiredSchema,
} from './schemas.js';
import {
  CHALLENGE_COOKIE,
  challengeCookieOptions,
  clearedCookieOptions,
  sessionCookieOptions,
  SESSION_COOKIE,
  TRUSTED_DEVICE_COOKIE,
} from './sessions.js';
import type { AccountDeps } from './signup.service.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Login, sign-out and password reset (on a workspace address); "find your workspace" (main address). */
export const authRoutes: FastifyPluginCallbackZod<Omit<AccountDeps, 'log'>> = (app, deps, done) => {
  const withLog = (log: AccountDeps['log']): AccountDeps => ({ ...deps, log });

  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 20, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['auth'],
        summary: 'Sign in to this workspace',
        description:
          'Wrong password, unknown email and "not a member here" all answer 401 INVALID_CREDENTIALS. Five failures for one email within 15 minutes lock it for 15 minutes (429 LOGIN_LOCKED). With two-step verification on, a correct password answers 202 and sets a short challenge cookie; send the code to /auth/login/two-factor.',
        body: LoginRequestSchema,
        response: {
          200: MeSchema,
          202: TwoFactorRequiredSchema,
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      const outcome = await login(
        withLog(request.log),
        workspace,
        request.body,
        { ip: request.ip, userAgent: request.headers['user-agent'] },
        {
          session: sessionToken(request),
          trustedDevice: readCookie(request, TRUSTED_DEVICE_COOKIE),
        },
      );
      if (outcome.kind === 'two-factor') {
        void reply.setCookie(
          CHALLENGE_COOKIE,
          outcome.challenge.token,
          challengeCookieOptions(deps.config, outcome.challenge.expiresAt),
        );
        return reply.status(202).send({ twoFactorRequired: true as const });
      }
      void reply.setCookie(
        SESSION_COOKIE,
        outcome.result.session.token,
        sessionCookieOptions(deps.config, outcome.result.session.expiresAt),
      );
      return reply.status(200).send(toMe(outcome.result));
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Sign out on this device',
        description: 'Needs the X-CSRF-Token header while the session is live.',
        response: { 204: z.null().describe('No content'), ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      await logout(withLog(request.log), workspace, sessionToken(request), sentCsrfToken(request));
      void reply.clearCookie(SESSION_COOKIE, clearedCookieOptions(deps.config));
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/forgot-password',
    {
      config: { rateLimit: { max: 10, timeWindow: HOUR } },
      schema: {
        tags: ['auth'],
        summary: 'Email a password reset link',
        description:
          'Answers the same way whether or not the email belongs to a member of this workspace.',
        body: EmailRequestSchema,
        response: { 202: EmailAcceptedSchema, ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      await forgotPassword(withLog(request.log), workspace, request.body.email);
      return reply.status(202).send({ email: request.body.email.trim().toLowerCase() });
    },
  );

  app.post(
    '/auth/reset-password/check',
    {
      config: { rateLimit: { max: 30, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['auth'],
        summary: 'Check a password reset link before choosing a new password',
        body: ResetTokenRequestSchema,
        response: { 200: ResetTokenStatusSchema, ...errorResponses(403, 404) },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      return checkResetLink(withLog(request.log), workspace, request.body.token);
    },
  );

  app.post(
    '/auth/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['auth'],
        summary: 'Choose a new password from a reset link',
        description:
          'Signs the person out everywhere. A used, expired or unknown link answers 400 with details.reason.',
        body: ResetPasswordRequestSchema,
        response: { 204: z.null().describe('No content'), ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      await resetPassword(
        withLog(request.log),
        workspace,
        request.body.token,
        request.body.password,
        {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        },
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/find-workspaces',
    {
      config: { rateLimit: { max: 5, timeWindow: HOUR } },
      schema: {
        tags: ['auth'],
        summary: 'Email links to every workspace this email can sign in to',
        description:
          'Main address only. Answers the same way whether or not the email has an account.',
        body: EmailRequestSchema,
        response: { 202: EmailAcceptedSchema, ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      requireMainAddress(deps.config, request);
      await findWorkspaces(withLog(request.log), request.body.email);
      return reply.status(202).send({ email: request.body.email.trim().toLowerCase() });
    },
  );

  done();
};
