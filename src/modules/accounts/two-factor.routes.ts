import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/schemas.js';
import {
  readCookie,
  requireSignedIn,
  requireWorkspace,
  sessionToken,
  toMe,
} from './request-context.js';
import {
  DisableTwoFactorRequestSchema,
  MeSchema,
  PasswordConfirmRequestSchema,
  RecoveryCodesSchema,
  TwoFactorCodeRequestSchema,
  TwoFactorLoginRequestSchema,
  TwoFactorSetupSchema,
  UpdateWorkspaceSecurityRequestSchema,
  WorkspaceSecuritySchema,
} from './schemas.js';
import {
  CHALLENGE_COOKIE,
  clearedChallengeCookieOptions,
  sessionCookieOptions,
  SESSION_COOKIE,
  TRUSTED_DEVICE_COOKIE,
  trustedDeviceCookieOptions,
} from './sessions.js';
import type { AccountDeps } from './signup.service.js';
import {
  completeTwoFactorLogin,
  confirmTwoFactorSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  startTwoFactorSetup,
  updateWorkspaceSecurity,
  workspaceSecurity,
} from './two-factor.service.js';

const SECURITY_LIMIT = { rateLimit: { max: 10, timeWindow: 15 * 60 * 1000 } };

/**
 * Two-step verification: your own setup (Your account), the code step of login, and the
 * workspace's "require it for everyone" rule (admins).
 */
export const twoFactorRoutes: FastifyPluginCallbackZod<Omit<AccountDeps, 'log'>> = (
  app,
  deps,
  done,
) => {
  const withLog = (log: AccountDeps['log']): AccountDeps => ({ ...deps, log });
  const signedIn = (request: Parameters<typeof requireSignedIn>[2], duringTwoFactorSetup = false) =>
    requireSignedIn(deps.config, deps.db, request, { duringTwoFactorSetup });

  app.post(
    '/me/two-factor/setup',
    {
      config: SECURITY_LIMIT,
      schema: {
        tags: ['two-factor'],
        summary: 'Start setting up two-step verification',
        description:
          'Needs your password. Returns the setup key and QR code for an authenticator app; nothing changes until /me/two-factor/confirm.',
        body: PasswordConfirmRequestSchema,
        response: { 200: TwoFactorSetupSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      startTwoFactorSetup(
        withLog(request.log),
        await signedIn(request, true),
        request.body.password,
      ),
  );

  app.post(
    '/me/two-factor/confirm',
    {
      config: SECURITY_LIMIT,
      schema: {
        tags: ['two-factor'],
        summary: 'Turn on two-step verification with the first code from the app',
        description:
          'Returns the recovery codes (shown once) and signs you out on your other devices.',
        body: TwoFactorCodeRequestSchema,
        response: { 200: RecoveryCodesSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      confirmTwoFactorSetup(withLog(request.log), await signedIn(request, true), request.body.code),
  );

  app.post(
    '/me/two-factor/recovery-codes',
    {
      config: SECURITY_LIMIT,
      schema: {
        tags: ['two-factor'],
        summary: 'Create new recovery codes',
        description: 'Needs your password. The old codes stop working.',
        body: PasswordConfirmRequestSchema,
        response: { 200: RecoveryCodesSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      regenerateRecoveryCodes(withLog(request.log), await signedIn(request), request.body.password),
  );

  app.post(
    '/me/two-factor/disable',
    {
      config: SECURITY_LIMIT,
      schema: {
        tags: ['two-factor'],
        summary: 'Turn off two-step verification',
        description:
          'Needs your password and a code (or a recovery code). 409 TWO_FACTOR_REQUIRED, with details.workspaces, while a workspace you belong to requires it.',
        body: DisableTwoFactorRequestSchema,
        response: {
          204: z.null().describe('No content'),
          ...errorResponses(401, 403, 404, 409),
        },
      },
    },
    async (request, reply) => {
      await disableTwoFactor(withLog(request.log), await signedIn(request), request.body);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/auth/login/two-factor',
    {
      config: SECURITY_LIMIT,
      schema: {
        tags: ['auth'],
        summary: 'Finish signing in with a code',
        description:
          'After /auth/login answered 202. A code from the app or a recovery code. Wrong codes answer 401 INVALID_CODE and count toward the login lock; a missing, expired or used-up challenge answers 401 TWO_FACTOR_EXPIRED (start again with the password).',
        body: TwoFactorLoginRequestSchema,
        response: { 200: MeSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      void reply.clearCookie(CHALLENGE_COOKIE, clearedChallengeCookieOptions(deps.config));
      const { result, trustedDevice } = await completeTwoFactorLogin(
        withLog(request.log),
        workspace,
        request.body,
        { ip: request.ip, userAgent: request.headers['user-agent'] },
        { challenge: readCookie(request, CHALLENGE_COOKIE), session: sessionToken(request) },
      );
      void reply.setCookie(
        SESSION_COOKIE,
        result.session.token,
        sessionCookieOptions(deps.config, result.session.expiresAt),
      );
      if (trustedDevice) {
        void reply.setCookie(
          TRUSTED_DEVICE_COOKIE,
          trustedDevice.token,
          trustedDeviceCookieOptions(deps.config, trustedDevice.expiresAt),
        );
      }
      return toMe(result);
    },
  );

  app.get(
    '/workspace/security',
    {
      schema: {
        tags: ['two-factor'],
        summary: "The workspace's security settings (admins)",
        response: { 200: WorkspaceSecuritySchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => workspaceSecurity(withLog(request.log), await signedIn(request)),
  );

  app.patch(
    '/workspace/security',
    {
      schema: {
        tags: ['two-factor'],
        summary: 'Require two-step verification for everyone (admins)',
        description: 'Turning it on needs two-step verification on for yourself first (409).',
        body: UpdateWorkspaceSecurityRequestSchema,
        response: { 200: WorkspaceSecuritySchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      updateWorkspaceSecurity(withLog(request.log), await signedIn(request), request.body),
  );

  done();
};
