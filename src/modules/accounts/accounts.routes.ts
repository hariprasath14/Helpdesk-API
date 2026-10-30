import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { NotFoundError } from '../../lib/errors.js';
import { errorResponses } from '../../lib/schemas.js';
import { changePassword, signOutOtherSessions, updateProfile } from './auth.service.js';
import { requestSubdomain, requireMainAddress, requireSignedIn, toMe } from './request-context.js';
import {
  AddressCheckQuerySchema,
  AddressCheckSchema,
  ChangePasswordRequestSchema,
  MeSchema,
  ResendRequestSchema,
  SignedOutSessionsSchema,
  SignUpAcceptedSchema,
  SignUpRequestSchema,
  UpdateProfileRequestSchema,
  VerifyEmailRequestSchema,
} from './schemas.js';
import { sessionCookieOptions, SESSION_COOKIE } from './sessions.js';
import {
  checkAddress,
  resendVerification,
  signUp,
  verifyEmail,
  type AccountDeps,
} from './signup.service.js';

const HOUR = 60 * 60 * 1000;

/**
 * Sign-up (on the app's main address), email verification, and the signed-in person's own account
 * (on a workspace address).
 */
export const accountsRoutes: FastifyPluginCallbackZod<Omit<AccountDeps, 'log'>> = (
  app,
  deps,
  done,
) => {
  const withLog = (log: AccountDeps['log']): AccountDeps => ({ ...deps, log });
  const onMainAddress = (request: Parameters<typeof requireMainAddress>[1]) => {
    requireMainAddress(deps.config, request);
  };

  app.get(
    '/signup/address-availability',
    {
      config: { rateLimit: { max: 60, timeWindow: 60_000 } },
      schema: {
        tags: ['accounts'],
        summary: 'Check a workspace address',
        querystring: AddressCheckQuerySchema,
        response: { 200: AddressCheckSchema, ...errorResponses(404) },
      },
    },
    async (request) => {
      onMainAddress(request);
      return checkAddress(withLog(request.log), request.query.address);
    },
  );

  app.post(
    '/signup',
    {
      config: { rateLimit: { max: 5, timeWindow: HOUR } },
      schema: {
        tags: ['accounts'],
        summary: 'Sign up and create a workspace',
        description:
          'Creates a pending workspace and emails a confirmation link. Answers the same way when the email already has an account.',
        body: SignUpRequestSchema,
        response: { 202: SignUpAcceptedSchema, ...errorResponses(403, 404, 409) },
      },
    },
    async (request, reply) => {
      onMainAddress(request);
      const result = await signUp(withLog(request.log), request.body);
      return reply.status(202).send(result);
    },
  );

  app.post(
    '/signup/resend',
    {
      config: { rateLimit: { max: 3, timeWindow: HOUR } },
      schema: {
        tags: ['accounts'],
        summary: 'Resend the confirmation email',
        body: ResendRequestSchema,
        response: { 202: SignUpAcceptedSchema, ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      onMainAddress(request);
      await resendVerification(withLog(request.log), request.body.email);
      return reply.status(202).send({ email: request.body.email.trim().toLowerCase() });
    },
  );

  app.post(
    '/auth/verify-email',
    {
      config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } },
      schema: {
        tags: ['accounts'],
        summary: 'Confirm an email from its link and sign in',
        body: VerifyEmailRequestSchema,
        response: { 200: MeSchema, ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      const subdomain = requestSubdomain(deps.config, request);
      if (!subdomain) throw new NotFoundError();
      const signedIn = await verifyEmail(withLog(request.log), request.body.token, subdomain, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      void reply.setCookie(
        SESSION_COOKIE,
        signedIn.sessionToken,
        sessionCookieOptions(deps.config, signedIn.sessionExpiresAt),
      );
      return toMe({
        user: {
          id: signedIn.user.id,
          name: signedIn.user.name,
          email: signedIn.user.email,
          theme: null,
        },
        workspace: {
          id: signedIn.workspace.id,
          name: signedIn.workspace.name,
          subdomain: signedIn.workspace.subdomain,
          timezone: signedIn.workspace.timezone,
        },
        role: 'admin',
        isOwner: true,
        // A brand-new workspace: no rule yet, and the owner has not set anything up.
        twoFactor: { enabled: false, recoveryCodesLeft: 0, required: false, setupRequired: false },
        session: { token: signedIn.sessionToken },
      });
    },
  );

  app.get(
    '/me',
    {
      schema: {
        tags: ['accounts'],
        summary: 'The signed-in member and workspace',
        response: { 200: MeSchema, ...errorResponses(401, 404) },
      },
    },
    async (request) =>
      toMe(await requireSignedIn(deps.config, deps.db, request, { duringTwoFactorSetup: true })),
  );

  app.patch(
    '/me',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Update your name or colour theme',
        body: UpdateProfileRequestSchema,
        response: { 200: MeSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => {
      const signedIn = await requireSignedIn(deps.config, deps.db, request);
      return toMe(await updateProfile(withLog(request.log), signedIn, request.body));
    },
  );

  app.post(
    '/me/password',
    {
      config: { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } },
      schema: {
        tags: ['accounts'],
        summary: 'Change your password',
        description:
          'Signs you out on every other device and workspace; this browser gets a fresh session (new cookie and CSRF token).',
        body: ChangePasswordRequestSchema,
        response: { 200: MeSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const signedIn = await requireSignedIn(deps.config, deps.db, request);
      const result = await changePassword(withLog(request.log), signedIn, request.body, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      void reply.setCookie(
        SESSION_COOKIE,
        result.session.token,
        sessionCookieOptions(deps.config, result.session.expiresAt),
      );
      return toMe(result);
    },
  );

  app.post(
    '/me/sessions/sign-out-others',
    {
      schema: {
        tags: ['accounts'],
        summary: 'Sign out on every other device',
        response: { 200: SignedOutSessionsSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => {
      const signedIn = await requireSignedIn(deps.config, deps.db, request);
      return signOutOtherSessions(withLog(request.log), signedIn);
    },
  );
  done();
};
