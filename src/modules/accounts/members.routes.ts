import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponses } from '../../lib/schemas.js';
import { reauthenticate } from './auth.service.js';
import {
  acceptInvitation,
  checkInvitation,
  inviteMembers,
  resendInvitation,
  revokeInvitation,
} from './invitations.service.js';
import {
  changeRole,
  deactivateMember,
  listMembers,
  listPeople,
  reactivateMember,
  resetMemberTwoFactor,
} from './members.service.js';
import { requireSignedIn, requireWorkspace, sessionToken, toMe } from './request-context.js';
import {
  AcceptInvitationRequestSchema,
  ChangeRoleRequestSchema,
  InvitationIdParamsSchema,
  InvitationStatusSchema,
  InviteRequestSchema,
  InviteResultSchema,
  MembersListSchema,
  MeSchema,
  PasswordConfirmRequestSchema,
  ResetTokenRequestSchema,
  UserIdParamsSchema,
} from './schemas.js';
import { sessionCookieOptions, SESSION_COOKIE } from './sessions.js';
import type { AccountDeps } from './signup.service.js';

const MINUTE = 60 * 1000;
const noContent = { 204: z.null().describe('No content') };

/**
 * Members and invitations (admins manage, supervisors view), accepting an invitation (signed out),
 * and confirming the password for sensitive admin actions.
 */
export const membersRoutes: FastifyPluginCallbackZod<Omit<AccountDeps, 'log'>> = (
  app,
  deps,
  done,
) => {
  const withLog = (log: AccountDeps['log']): AccountDeps => ({ ...deps, log });
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);
  const sensitive =
    'Admins only. Needs the password confirmed in the last 10 minutes (403 REAUTH_REQUIRED, then POST /me/reauthenticate).';

  app.post(
    '/me/reauthenticate',
    {
      config: { rateLimit: { max: 10, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['members'],
        summary: 'Confirm your password for sensitive actions',
        description:
          'Allows sensitive admin actions on this session for 10 minutes. Wrong passwords count toward the login lock.',
        body: PasswordConfirmRequestSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await reauthenticate(withLog(request.log), await signedIn(request), request.body.password, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/members',
    {
      schema: {
        tags: ['members'],
        summary: 'Members and open invitations',
        description: 'Admins and supervisors.',
        response: { 200: MembersListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => listMembers(withLog(request.log), await signedIn(request)),
  );

  app.get(
    '/people',
    {
      schema: {
        tags: ['members'],
        summary: 'Everyone in the workspace, by name',
        description:
          'Every member: names, roles and status only (no emails), for choosing or filtering by an assignee. Active people first.',
        response: {
          200: z
            .object({
              people: z.array(
                z.object({
                  userId: z.string(),
                  name: z.string(),
                  role: z.enum(['admin', 'supervisor', 'agent']),
                  status: z.enum(['active', 'deactivated']),
                }),
              ),
            })
            .meta({ id: 'PeopleList' }),
          ...errorResponses(401, 403, 404),
        },
      },
    },
    async (request) => ({
      people: await listPeople(withLog(request.log), await signedIn(request)),
    }),
  );

  app.patch(
    '/members/:userId',
    {
      schema: {
        tags: ['members'],
        summary: "Change a member's role",
        description: `Admins only. Making someone an admin needs the password confirmed in the last 10 minutes. The owner's role cannot change; a workspace keeps at least one admin.`,
        params: UserIdParamsSchema,
        body: ChangeRoleRequestSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await changeRole(
        withLog(request.log),
        await signedIn(request),
        request.params.userId,
        request.body.role,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/members/:userId/deactivate',
    {
      schema: {
        tags: ['members'],
        summary: 'Deactivate a member',
        description: `${sensitive} Signs them out of this workspace at once and unassigns their unresolved tickets. Not the owner, not yourself.`,
        params: UserIdParamsSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await deactivateMember(withLog(request.log), await signedIn(request), request.params.userId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/members/:userId/reactivate',
    {
      schema: {
        tags: ['members'],
        summary: 'Reactivate a member',
        description: 'Admins only.',
        params: UserIdParamsSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await reactivateMember(withLog(request.log), await signedIn(request), request.params.userId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/members/:userId/reset-two-factor',
    {
      schema: {
        tags: ['members'],
        summary: "Reset a member's two-step verification",
        description: `${sensitive} Refused (409 MEMBER_IN_OTHER_WORKSPACES) when they also belong to another workspace.`,
        params: UserIdParamsSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request, reply) => {
      await resetMemberTwoFactor(
        withLog(request.log),
        await signedIn(request),
        request.params.userId,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/invitations',
    {
      config: { rateLimit: { max: 30, timeWindow: 60 * MINUTE } },
      schema: {
        tags: ['members'],
        summary: 'Invite people by email',
        description:
          'Admins only. Up to 20 at a time; inviting as an admin needs the password confirmed in the last 10 minutes. Members are skipped with a reason; inviting someone again replaces their open invitation.',
        body: InviteRequestSchema,
        response: { 200: InviteResultSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => inviteMembers(withLog(request.log), await signedIn(request), request.body),
  );

  app.post(
    '/invitations/:invitationId/resend',
    {
      config: { rateLimit: { max: 30, timeWindow: 60 * MINUTE } },
      schema: {
        tags: ['members'],
        summary: 'Send a fresh invitation link',
        description: 'Admins only. Another 7 days; the old link stops working.',
        params: InvitationIdParamsSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await resendInvitation(
        withLog(request.log),
        await signedIn(request),
        request.params.invitationId,
      );
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/invitations/:invitationId',
    {
      schema: {
        tags: ['members'],
        summary: 'Revoke an invitation',
        description: 'Admins only.',
        params: InvitationIdParamsSchema,
        response: { ...noContent, ...errorResponses(401, 403, 404) },
      },
    },
    async (request, reply) => {
      await revokeInvitation(
        withLog(request.log),
        await signedIn(request),
        request.params.invitationId,
      );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/invitations/check',
    {
      config: { rateLimit: { max: 30, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['members'],
        summary: 'Check an invitation link before accepting',
        description:
          'Signed out, on the workspace address. A used, expired or revoked link answers 400 with details.reason.',
        body: ResetTokenRequestSchema,
        response: { 200: InvitationStatusSchema, ...errorResponses(403, 404) },
      },
    },
    async (request) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      return checkInvitation(withLog(request.log), workspace, request.body.token);
    },
  );

  app.post(
    '/invitations/accept',
    {
      config: { rateLimit: { max: 10, timeWindow: 15 * MINUTE } },
      schema: {
        tags: ['members'],
        summary: 'Accept an invitation and sign in',
        description:
          'New people send a name and a new password. People who already have an account send their password, and a code when they use two-step verification (400 with details.codeRequired when missing).',
        body: AcceptInvitationRequestSchema,
        response: { 200: MeSchema, ...errorResponses(403, 404) },
      },
    },
    async (request, reply) => {
      const workspace = await requireWorkspace(deps.config, deps.db, request);
      const result = await acceptInvitation(
        withLog(request.log),
        workspace,
        request.body,
        { ip: request.ip, userAgent: request.headers['user-agent'] },
        sessionToken(request),
      );
      void reply.setCookie(
        SESSION_COOKIE,
        result.session.token,
        sessionCookieOptions(deps.config, result.session.expiresAt),
      );
      return toMe(result);
    },
  );

  done();
};
