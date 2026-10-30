import { AppError, ForbiddenError } from '../../lib/errors.js';
import type { Role } from './models.js';

/**
 * Everything a role can be allowed to do. Each endpoint names the one it needs; the app receives
 * the list in /me so it can hide what the person cannot do (the API still enforces it).
 * Keys for features not built yet are listed so the role table stays in one place.
 */
export const PERMISSIONS = [
  'tickets.work',
  'tickets.assign_any',
  'tickets.merge',
  'tickets.delete',
  'contacts.edit',
  'contacts.delete',
  'canned_responses.manage_shared',
  'views.manage_shared',
  'members.view',
  'members.manage',
  'teams.manage',
  'settings.manage',
  'audit_log.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The three fixed roles of Release 1 (custom roles: Release 2). */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  supervisor: [
    'tickets.work',
    'tickets.assign_any',
    'tickets.merge',
    'contacts.edit',
    'contacts.delete',
    'canned_responses.manage_shared',
    'views.manage_shared',
    'members.view',
  ],
  agent: ['tickets.work', 'contacts.edit'],
};

export function permissionsFor(role: Role): Permission[] {
  // A fixed table keyed by the Role type, not user input.
  // eslint-disable-next-line security/detect-object-injection
  return [...ROLE_PERMISSIONS[role]];
}

/** 403 unless the signed-in member's role has the permission. */
export function requirePermission(
  signedIn: { permissions: readonly Permission[] },
  permission: Permission,
): void {
  if (!signedIn.permissions.includes(permission)) throw new ForbiddenError();
}

/** How long a confirmed password lets sensitive admin actions through without asking again. */
export const REAUTH_MINUTES = 10;

export class ReauthRequiredError extends AppError {
  constructor() {
    super(403, 'REAUTH_REQUIRED', 'Confirm your password to continue.');
  }
}

/**
 * Sensitive admin actions (making someone an admin, deactivating, resetting two-step
 * verification) need the password confirmed on this session within REAUTH_MINUTES. Signing in
 * counts as confirming it.
 */
export function requireRecentPassword(signedIn: {
  session: { reauthenticatedAt: Date | null };
}): void {
  const at = signedIn.session.reauthenticatedAt;
  if (!at || Date.now() - at.getTime() > REAUTH_MINUTES * 60 * 1000) {
    throw new ReauthRequiredError();
  }
}
