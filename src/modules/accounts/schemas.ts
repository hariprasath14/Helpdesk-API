import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords.js';
import { PERMISSIONS } from './permissions.js';
import { THEMES } from './models.js';

/**
 * Any IANA time zone the runtime knows, including aliases: browsers send Asia/Kolkata while Node's
 * list has the older Asia/Calcutta, so ask the date library instead of comparing names.
 */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const SignUpRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').max(100),
    email: z.email('Enter a valid email address.').max(254),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`)
      .max(PASSWORD_MAX_LENGTH),
    companyName: z.string().trim().min(2, 'Enter your company name.').max(100),
    workspaceAddress: z.string().trim().min(3).max(30),
    timezone: z.string().refine(isTimeZone, 'Unknown time zone.'),
    acceptTerms: z.literal(true, 'Accept the Terms and Privacy Policy to continue.'),
  })
  .meta({ id: 'SignUpRequest' });

export const SignUpAcceptedSchema = z
  .object({ email: z.string().describe('Where the confirmation link was sent') })
  .meta({ id: 'SignUpAccepted' });

export const ResendRequestSchema = z
  .object({ email: z.email().max(254) })
  .meta({ id: 'ResendRequest' });

export const AddressCheckQuerySchema = z.object({ address: z.string().max(64) });

export const AddressCheckSchema = z
  .object({
    address: z.string(),
    available: z.boolean(),
    reason: z.enum(['format', 'reserved', 'taken']).optional(),
    alternatives: z.array(z.string()).describe('Free addresses to suggest instead'),
  })
  .meta({ id: 'AddressCheck' });

export const VerifyEmailRequestSchema = z
  .object({ token: z.string().min(20).max(200) })
  .meta({ id: 'VerifyEmailRequest' });

export const MeSchema = z
  .object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      theme: z
        .enum(THEMES)
        .nullable()
        .describe("The colour theme this person chose; null keeps the deployment's brand"),
    }),
    workspace: z.object({
      id: z.string(),
      name: z.string(),
      subdomain: z.string(),
      timezone: z.string(),
    }),
    role: z.enum(['admin', 'supervisor', 'agent']),
    isOwner: z.boolean(),
    permissions: z
      .array(z.enum(PERMISSIONS))
      .describe("What this member's role allows; the app hides the rest"),
    twoFactor: z.object({
      enabled: z.boolean(),
      recoveryCodesLeft: z.number().int(),
      required: z.boolean().describe('This workspace requires two-step verification'),
      setupRequired: z
        .boolean()
        .describe('Required here but not set up: only setup and sign-out are allowed until it is'),
    }),
    csrfToken: z.string().describe('Send back in the X-CSRF-Token header on every change'),
  })
  .meta({ id: 'Me' });

const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${String(PASSWORD_MIN_LENGTH)} characters.`)
  .max(PASSWORD_MAX_LENGTH);

export const LoginRequestSchema = z
  .object({
    email: z.email('Enter a valid email address.').max(254),
    password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
  })
  .meta({ id: 'LoginRequest' });

export const EmailRequestSchema = z
  .object({ email: z.email('Enter a valid email address.').max(254) })
  .meta({ id: 'EmailRequest' });

export const EmailAcceptedSchema = z
  .object({ email: z.string().describe('Where the email was sent, if there is an account') })
  .meta({ id: 'EmailAccepted' });

export const ResetTokenRequestSchema = z
  .object({ token: z.string().min(20).max(200) })
  .meta({ id: 'ResetTokenRequest' });

export const ResetTokenStatusSchema = z
  .object({ email: z.string().describe('The account the link resets') })
  .meta({ id: 'ResetTokenStatus' });

export const ResetPasswordRequestSchema = z
  .object({ token: z.string().min(20).max(200), password: newPassword })
  .meta({ id: 'ResetPasswordRequest' });

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(PASSWORD_MAX_LENGTH),
    newPassword,
  })
  .meta({ id: 'ChangePasswordRequest' });

export const UpdateProfileRequestSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name.').max(100).optional(),
    theme: z
      .enum(THEMES)
      .nullable()
      .optional()
      .describe("Your colour theme, on every device; null goes back to the deployment's brand"),
  })
  .refine((body) => body.name !== undefined || body.theme !== undefined, {
    message: 'Send a name or a theme.',
  })
  .meta({ id: 'UpdateProfileRequest' });

export const SignedOutSessionsSchema = z
  .object({ signedOut: z.number().int().describe('How many other sessions were signed out') })
  .meta({ id: 'SignedOutSessions' });

export const PasswordConfirmRequestSchema = z
  .object({ password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH) })
  .meta({ id: 'PasswordConfirmRequest' });

export const TwoFactorSetupSchema = z
  .object({
    secret: z.string().describe('Setup key to type into the app (base32)'),
    otpauthUri: z.string().describe('otpauth:// address the QR code holds'),
    qrSvg: z.string().describe('The QR code as an SVG document'),
  })
  .meta({ id: 'TwoFactorSetup' });

const code = z.string().trim().min(6, 'Enter the code.').max(20);

export const TwoFactorCodeRequestSchema = z.object({ code }).meta({ id: 'TwoFactorCodeRequest' });

export const RecoveryCodesSchema = z
  .object({ recoveryCodes: z.array(z.string()).describe('Shown once; each works once') })
  .meta({ id: 'RecoveryCodes' });

export const DisableTwoFactorRequestSchema = z
  .object({
    password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX_LENGTH),
    code: code.describe('A code from the app, or a recovery code'),
  })
  .meta({ id: 'DisableTwoFactorRequest' });

export const TwoFactorLoginRequestSchema = z
  .object({
    code: code.describe('A code from the app, or a recovery code'),
    trustDevice: z.boolean().default(false).describe("Don't ask again on this device for 30 days"),
  })
  .meta({ id: 'TwoFactorLoginRequest' });

export const TwoFactorRequiredSchema = z
  .object({
    twoFactorRequired: z
      .literal(true)
      .describe('Password accepted; send a code to POST /api/v1/auth/login/two-factor'),
  })
  .meta({ id: 'TwoFactorRequired' });

export const WorkspaceSecuritySchema = z
  .object({
    requireTwoFactor: z.boolean(),
    members: z.number().int(),
    membersWithTwoFactor: z.number().int(),
  })
  .meta({ id: 'WorkspaceSecurity' });

export const UpdateWorkspaceSecurityRequestSchema = z
  .object({ requireTwoFactor: z.boolean() })
  .meta({ id: 'UpdateWorkspaceSecurityRequest' });

const role = z.enum(['admin', 'supervisor', 'agent']);

export const MemberSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    role,
    isOwner: z.boolean(),
    status: z.enum(['active', 'deactivated']),
    twoFactorEnabled: z.boolean(),
    lastActiveAt: z.date().nullable(),
    joinedAt: z.date(),
    teams: z
      .array(z.object({ id: z.string(), name: z.string(), isLead: z.boolean() }))
      .describe('A to Z'),
  })
  .meta({ id: 'Member' });

export const InvitationSummarySchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role,
    invitedByName: z.string().nullable(),
    createdAt: z.date(),
    expiresAt: z.date(),
    expired: z.boolean(),
    teams: z
      .array(z.object({ id: z.string(), name: z.string() }))
      .describe('Teams they join when they accept'),
  })
  .meta({ id: 'InvitationSummary' });

export const MembersListSchema = z
  .object({
    members: z.array(MemberSchema),
    invitations: z.array(InvitationSummarySchema).describe('Open invitations, newest first'),
  })
  .meta({ id: 'MembersList' });

export const UserIdParamsSchema = z.object({ userId: z.uuid() });
export const InvitationIdParamsSchema = z.object({ invitationId: z.uuid() });

export const ChangeRoleRequestSchema = z.object({ role }).meta({ id: 'ChangeRoleRequest' });

export const InviteRequestSchema = z
  .object({
    emails: z
      .array(z.email('Enter valid email addresses.').max(254))
      .min(1, 'Enter at least one email address.')
      .max(20, 'Invite up to 20 people at a time.'),
    role,
    teamIds: z
      .array(z.uuid())
      .max(100)
      .optional()
      .describe('Teams they join when they accept the invitation'),
  })
  .meta({ id: 'InviteRequest' });

export const InviteResultSchema = z
  .object({
    invited: z.array(z.string()),
    skipped: z.array(z.object({ email: z.string(), reason: z.string() })),
  })
  .meta({ id: 'InviteResult' });

export const InvitationStatusSchema = z
  .object({
    email: z.string(),
    workspaceName: z.string(),
    role,
    invitedByName: z.string().nullable(),
    existingAccount: z
      .boolean()
      .describe('The email already has an account: accept with that password'),
    twoFactorRequired: z.boolean().describe('That account also needs a code to accept'),
  })
  .meta({ id: 'InvitationStatus' });

export const AcceptInvitationRequestSchema = z
  .object({
    token: z.string().min(20).max(200),
    name: z.string().trim().max(100).optional().describe('New people only'),
    password: z.string().min(1, 'Enter a password.').max(PASSWORD_MAX_LENGTH),
    code: z
      .string()
      .trim()
      .max(20)
      .optional()
      .describe('Existing accounts with two-step verification'),
  })
  .meta({ id: 'AcceptInvitationRequest' });
