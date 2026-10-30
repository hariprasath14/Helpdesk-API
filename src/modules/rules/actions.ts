import type { TicketPriority, TicketStatus, TicketType } from '../tickets/models.js';
import type { TicketInput } from '../tickets/tickets.service.js';
import { NONE } from './conditions.js';

/** What a rule can do to a ticket (F17). */
export const ACTION_TYPES = [
  'set_priority',
  'set_status',
  'set_type',
  'set_team',
  'set_assignee',
  'assign_in_turn',
  'add_tags',
  'remove_tags',
  'add_note',
  'email_requester',
  'email_assignee',
  'email_team',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * One action. value: the priority, status or type; a team or member id (or "none" to clear it);
 * for assign_in_turn the team whose members take turns (F18); the tags to add or remove; the text
 * of a private note, or of an email to the requester, the assignee or the team's leads (F19).
 */
export interface RuleAction {
  type: ActionType;
  value: string | string[];
}

/** Who a rule's email goes to (F19). */
export type EmailTarget = 'requester' | 'assignee' | 'team_leads';

const one = (value: RuleAction['value']) => (Array.isArray(value) ? (value[0] ?? '') : value);
const many = (value: RuleAction['value']) => (Array.isArray(value) ? value : [value]);
const orNull = (value: string) => (value === NONE ? null : value);

/**
 * A rule's actions as one ticket change, applied in order (a later action wins over an earlier
 * one on the same field), plus the private notes to add.
 */
export function changesFrom(
  actions: RuleAction[],
  currentTags: string[],
): { changes: TicketInput; notes: string[]; emails: { to: EmailTarget; text: string }[] } {
  const changes: TicketInput = {};
  const notes: string[] = [];
  const emails: { to: EmailTarget; text: string }[] = [];
  let tags = [...currentTags];
  let tagsChanged = false;
  for (const action of actions) {
    switch (action.type) {
      case 'set_priority':
        changes.priority = one(action.value) as TicketPriority;
        break;
      case 'set_status':
        changes.status = one(action.value) as TicketStatus;
        break;
      case 'set_type':
        changes.type = orNull(one(action.value)) as TicketType | null;
        break;
      case 'set_team':
        changes.teamId = orNull(one(action.value));
        break;
      case 'set_assignee':
        changes.assigneeUserId = orNull(one(action.value));
        break;
      case 'add_tags':
        tags = [...new Set([...tags, ...many(action.value).map((tag) => tag.toLowerCase())])];
        tagsChanged = true;
        break;
      case 'remove_tags': {
        const removed = new Set(many(action.value).map((tag) => tag.toLowerCase()));
        tags = tags.filter((tag) => !removed.has(tag));
        tagsChanged = true;
        break;
      }
      case 'add_note':
        notes.push(one(action.value));
        break;
      case 'email_requester':
        emails.push({ to: 'requester', text: one(action.value) });
        break;
      case 'email_assignee':
        emails.push({ to: 'assignee', text: one(action.value) });
        break;
      case 'email_team':
        emails.push({ to: 'team_leads', text: one(action.value) });
        break;
      case 'assign_in_turn':
        // The person comes from the team's turn (engine.ts); here only the team is known.
        changes.teamId = one(action.value);
        break;
    }
  }
  if (tagsChanged) changes.tags = tags;
  return { changes, notes, emails };
}
