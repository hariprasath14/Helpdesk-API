import type { AuditAction } from './models.js';

const ROLE_NAMES = new Map([
  ['admin', 'Admin'],
  ['supervisor', 'Supervisor'],
  ['agent', 'Agent'],
]);
const roleName = (role: unknown) =>
  typeof role === 'string' ? (ROLE_NAMES.get(role) ?? role) : 'a member';

const SIGN_IN_METHODS = new Map([
  ['password', ''],
  ['two_factor', ' with a code from their authenticator app'],
  ['recovery_code', ' with a recovery code'],
  ['invitation', ' after accepting an invitation'],
  ['email_confirmation', ' by confirming their email'],
]);

const recordName = (details: Record<string, unknown>) =>
  typeof details.recordType === 'string' ? details.recordType : 'record';
const text = (value: unknown) => (typeof value === 'string' ? value : 'something else');
const changedList = (details: Record<string, unknown>) =>
  Array.isArray(details.changed) ? details.changed.join(', ') : 'settings';

/** "Neha Iyer and Ravi Shankar", or null for an empty or missing list. */
function names(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const items = list.map(String);
  return items.length === 1
    ? (items[0] ?? null)
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What a team change did, for example "added Neha Iyer; made Neha Iyer team lead". */
function teamChanges(details: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof details.from === 'string' && typeof details.to === 'string') {
    parts.push(`renamed it from "${details.from}"`);
  }
  if (Array.isArray(details.changed) && details.changed.includes('description')) {
    parts.push('changed the description');
  }
  const add = (key: string, text: (list: string) => string) => {
    // Fixed keys written by the teams service.
    // eslint-disable-next-line security/detect-object-injection
    const list = names(details[key]);
    if (list) parts.push(text(list));
  };
  add('added', (list) => `added ${list}`);
  add('removed', (list) => `removed ${list}`);
  add('leads', (list) => `made ${list} team lead`);
  add('unleads', (list) => `${list} no longer team lead`);
  return parts.join('; ') || 'no visible change';
}

interface Describable {
  action: AuditAction;
  actorName: string;
  targetLabel: string | null;
  details: Record<string, unknown>;
}

/**
 * The entry as one plain sentence, for the audit log page and the CSV export, for example
 * "Asha Rao changed Neha Iyer's role from Agent to Supervisor."
 */
export function describeAuditEvent(event: Describable): string {
  const who = event.actorName;
  const target = event.targetLabel ?? 'someone';
  const { details } = event;
  switch (event.action) {
    case 'workspace.created':
      return `${who} created the workspace.`;
    case 'workspace.two_factor_requirement_changed':
      return details.required
        ? `${who} required two-step verification for everyone.`
        : `${who} stopped requiring two-step verification.`;
    case 'workspace.email_sender_changed':
      return typeof details.to === 'string'
        ? `${who} changed the email sender name to "${details.to}".`
        : `${who} set the email sender name back to the workspace name.`;
    case 'workspace.web_form_changed':
      if (details.enabled === true) return `${who} turned on the web form.`;
      if (details.enabled === false) return `${who} turned off the web form.`;
      return `${who} changed the web form's text.`;
    case 'workspace.time_zone_changed':
      return `${who} changed the workspace time zone from ${text(details.from)} to ${text(details.to)}.`;
    case 'workspace.business_hours_changed':
      return `${who} changed the business hours to ${text(details.to)}.`;
    case 'holiday.added':
      return `${who} added the holiday "${target}" on ${text(details.date)}.`;
    case 'holiday.removed':
      return `${who} removed the holiday "${target}" on ${text(details.date)}.`;
    case 'workspace.customer_notifications_changed': {
      const names = new Map([
        ['received', '"request received"'],
        ['resolved', '"ticket resolved"'],
        ['agentCreated', '"ticket opened for you"'],
      ]);
      const parts = Object.entries(details).map(
        ([key, on]) => `turned ${on ? 'on' : 'off'} the ${names.get(key) ?? key} email`,
      );
      return `${who} ${parts.length > 0 ? parts.join(' and ') : 'changed customer notifications'}.`;
    }
    case 'member.invited':
      return `${who} invited ${target} as ${roleName(details.role)}.`;
    case 'invitation.resent':
      return `${who} sent a new invitation link to ${target}.`;
    case 'invitation.revoked':
      return `${who} revoked the invitation for ${target}.`;
    case 'member.joined': {
      const teams = names(details.teams);
      return teams
        ? `${who} joined as ${roleName(details.role)}, in ${teams}.`
        : `${who} joined as ${roleName(details.role)}.`;
    }
    case 'member.role_changed':
      return `${who} changed ${target}'s role from ${roleName(details.from)} to ${roleName(details.to)}.`;
    case 'member.deactivated':
      return `${who} deactivated ${target}.`;
    case 'member.reactivated':
      return `${who} reactivated ${target}.`;
    case 'member.two_factor_reset':
      return `${who} reset two-step verification for ${target}.`;
    case 'password.changed':
      return `${who} changed their password.`;
    case 'password.reset':
      return `${who} reset their password with an email link.`;
    case 'two_factor.enabled':
      return `${who} turned on two-step verification.`;
    case 'two_factor.disabled':
      return `${who} turned off two-step verification.`;
    case 'two_factor.recovery_codes_regenerated':
      return `${who} created new recovery codes.`;
    case 'sessions.signed_out_others':
      return `${who} signed out of all other devices.`;
    case 'sign_in.succeeded': {
      const method = typeof details.method === 'string' ? details.method : 'password';
      return `${who} signed in${SIGN_IN_METHODS.get(method) ?? ''}.`;
    }
    case 'sign_in.locked':
      return `Sign-in for ${target} was locked after too many attempts.`;
    case 'custom_field.created':
      return `${who} added the ${recordName(details)} field "${target}".`;
    case 'custom_field.updated':
      return typeof details.from === 'string' && typeof details.to === 'string'
        ? `${who} renamed the ${recordName(details)} field "${details.from}" to "${details.to}".`
        : `${who} changed the ${recordName(details)} field "${target}" (${changedList(details)}).`;
    case 'custom_field.archived':
      return `${who} archived the ${recordName(details)} field "${target}".`;
    case 'custom_field.restored':
      return `${who} restored the ${recordName(details)} field "${target}".`;
    case 'custom_fields.reordered':
      return `${who} reordered the ${recordName(details)} fields.`;
    case 'contact.deleted':
      return typeof details.email === 'string'
        ? `${who} deleted the contact ${target} (${details.email}).`
        : `${who} deleted the contact ${target}.`;
    case 'company.deleted':
      return `${who} deleted the company ${target}.`;
    case 'team.created': {
      const members = names(details.members);
      return members
        ? `${who} created the team "${target}" with ${members}.`
        : `${who} created the team "${target}".`;
    }
    case 'team.updated':
      return `${who} changed the team "${target}": ${teamChanges(details)}.`;
    case 'team.deleted':
      return `${who} deleted the team "${target}".`;
    case 'ticket.deleted':
      return `${who} deleted the ticket ${target}.`;
    case 'ticket.restored':
      return `${who} restored the ticket ${target} from the trash.`;
    case 'ticket.merged': {
      const merged = Array.isArray(details.merged)
        ? details.merged.map((number) => `#${String(number)}`)
        : [];
      return `${who} merged ${names(merged) ?? 'tickets'} into ${target}${details.toldCustomers ? ', telling the customers' : ''}.`;
    }
    case 'rule.created':
      return `${who} added the rule "${target}".`;
    case 'rule.updated':
      if (details.enabled === true) return `${who} turned on the rule "${target}".`;
      if (details.enabled === false) return `${who} turned off the rule "${target}".`;
      return `${who} changed the rule "${target}".`;
    case 'rule.deleted':
      return `${who} deleted the rule "${target}".`;
    case 'rules.reordered':
      return `${who} changed the order of the rules.`;
    case 'sla_policy.created':
      return `${who} added the SLA policy "${target}".`;
    case 'sla_policy.updated':
      return `${who} changed the SLA policy "${target}" (${changedList(details)}).`;
    case 'sla_policy.deleted':
      return `${who} deleted the SLA policy "${target}".`;
    case 'sla_policies.reordered':
      return `${who} changed the order of the SLA policies.`;
  }
}

const BROWSERS: [marker: string, name: string][] = [
  ['Edg/', 'Edge'],
  ['OPR/', 'Opera'],
  ['Firefox/', 'Firefox'],
  ['Chrome/', 'Chrome'],
  ['Safari/', 'Safari'],
];
const SYSTEMS: [markers: string[], name: string][] = [
  [['Windows'], 'Windows'],
  [['Android'], 'Android'],
  [['iPhone', 'iPad', 'iPod'], 'iOS'],
  [['Mac OS X', 'Macintosh'], 'macOS'],
  [['Linux'], 'Linux'],
];

/** "Chrome on Windows", from a browser's User-Agent; enough to recognise a device. */
export function deviceSummary(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = BROWSERS.find(([marker]) => userAgent.includes(marker))?.[1];
  const system = SYSTEMS.find(([markers]) => markers.some((m) => userAgent.includes(m)))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}
