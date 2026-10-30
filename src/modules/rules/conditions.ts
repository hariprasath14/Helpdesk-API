import type { FieldType } from '../custom-fields/models.js';
import type { CustomFieldValues } from '../custom-fields/values.js';

/**
 * What a rule can look at (F17). Built-in fields by name; custom fields as "ticket.<key>",
 * "contact.<key>" (the requester) or "company.<key>" (the requester's company).
 */
export const BUILT_IN_FIELDS = {
  subject: 'text',
  description: 'text',
  subject_or_description: 'text',
  requester_email: 'text',
  status: 'choice',
  priority: 'choice',
  type: 'choice',
  source: 'choice',
  team: 'choice',
  assignee: 'choice',
  company: 'choice',
  tags: 'list',
  // Only for "a ticket is changed" (F19): what the change touched; and, also when the customer
  // replies, the status before.
  changed: 'list',
  previous_status: 'choice',
  // Only for "the customer replied" (F19): what they wrote.
  message: 'text',
  // Only for rules on a schedule (F20): how long, in hours.
  hours_in_status: 'hours',
  hours_since_created: 'hours',
  hours_since_updated: 'hours',
} as const satisfies Record<string, FieldKind>;
export type BuiltInField = keyof typeof BUILT_IN_FIELDS;

/** How a field is compared. */
export type FieldKind = 'text' | 'choice' | 'list' | 'checkbox' | 'value' | 'hours';

export const OPERATORS = {
  text: ['contains_any', 'contains_none', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  choice: ['is_any', 'is_none'],
  list: ['contains_any', 'contains_none', 'is_empty', 'is_not_empty'],
  checkbox: ['is_checked', 'is_unchecked'],
  value: ['is', 'is_not', 'is_empty', 'is_not_empty'],
  hours: ['at_least', 'less_than'],
} as const;
export type Operator = (typeof OPERATORS)[FieldKind][number];
/** Every operator, for the API schema. */
export const ALL_OPERATORS = [
  'contains_any',
  'contains_none',
  'is',
  'is_not',
  'is_empty',
  'is_not_empty',
  'is_any',
  'is_none',
  'is_checked',
  'is_unchecked',
  'at_least',
  'less_than',
] as const satisfies readonly Operator[];

/** Operators that take a list of values; is and is_not take one; the rest take none. */
export const LIST_OPERATORS: readonly Operator[] = [
  'contains_any',
  'contains_none',
  'is_any',
  'is_none',
];
export const SINGLE_OPERATORS: readonly Operator[] = ['is', 'is_not', 'at_least', 'less_than'];

/** In a choice list, this stands for "not set" (no team, nobody assigned, no type). */
export const NONE = 'none';

export interface RuleCondition {
  field: string;
  operator: Operator;
  value?: string | string[] | undefined;
}

export interface RuleConditions {
  /** all: every condition must match; any: at least one. No conditions match every ticket. */
  match: 'all' | 'any';
  items: RuleCondition[];
}

/** How a custom field of each type is compared. */
export function kindOfCustomField(type: FieldType): FieldKind {
  switch (type) {
    case 'text':
    case 'paragraph':
      return 'text';
    case 'dropdown':
      return 'choice';
    case 'multi_select':
      return 'list';
    case 'checkbox':
      return 'checkbox';
    default:
      return 'value';
  }
}

/** A ticket as rules see it, read once per run. */
export interface TicketFacts {
  subject: string;
  description: string;
  status: string;
  priority: string;
  type: string | null;
  source: string;
  teamId: string | null;
  assigneeUserId: string | null;
  companyId: string | null;
  requesterEmail: string | null;
  tags: string[];
  ticketFields: CustomFieldValues;
  contactFields: CustomFieldValues;
  companyFields: CustomFieldValues;
  /** For "a ticket is changed": changedFields() of the change; empty otherwise. */
  changed: string[];
  previousStatus: string | null;
  /** For "the customer replied": the text of their reply. */
  message: string;
  /** For time conditions (F20): when the ticket was created, last changed, reached its status. */
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date;
  /** The moment the rules run. */
  now: Date;
}

/** What the event that started the rules adds to the ticket's facts (F19). */
export interface EventContext {
  changed?: string[];
  previousStatus?: string;
  message?: string;
  /** For a scheduled run: its moment (tests pass a fixed one). */
  now?: Date;
}

/** What "changed" can name: the fields changedFields() reports. */
export const CHANGED_FIELDS = [
  'status',
  'priority',
  'type',
  'team',
  'assignee',
  'requester',
  'subject',
  'tags',
  'custom_fields',
] as const;

/** How each event reads in a sentence ("rules that run when a ticket is changed"). */
export const EVENT_LABELS = {
  ticket_created: 'when a ticket is created',
  ticket_updated: 'when a ticket is changed',
  customer_replied: 'when the customer replies',
  time: 'on a schedule',
} as const;

/** The fields only some events have: only those events' rules may use them. */
export const EVENT_FIELDS: Record<string, (keyof typeof EVENT_LABELS)[]> = {
  changed: ['ticket_updated'],
  previous_status: ['ticket_updated', 'customer_replied'],
  message: ['customer_replied'],
  hours_in_status: ['time'],
  hours_since_created: ['time'],
  hours_since_updated: ['time'],
};

const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : '');
/** A single value as text: numbers and dates compare as they are written. */
const asText = (value: unknown) =>
  typeof value === 'string' ? value.toLowerCase() : typeof value === 'number' ? String(value) : '';
const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);
const listOf = (value: RuleCondition['value']) =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((item) =>
    item.toLowerCase(),
  );

/** Whole and part hours from one moment to another. */
const hoursBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

/** The value a condition looks at. */
function valueOf(field: string, facts: TicketFacts): unknown {
  switch (field) {
    case 'subject':
      return facts.subject;
    case 'description':
      return facts.description;
    case 'subject_or_description':
      return `${facts.subject}\n${facts.description}`;
    case 'requester_email':
      return facts.requesterEmail;
    case 'status':
      return facts.status;
    case 'priority':
      return facts.priority;
    case 'type':
      return facts.type;
    case 'source':
      return facts.source;
    case 'team':
      return facts.teamId;
    case 'assignee':
      return facts.assigneeUserId;
    case 'company':
      return facts.companyId;
    case 'tags':
      return facts.tags;
    case 'changed':
      return facts.changed;
    case 'previous_status':
      return facts.previousStatus;
    case 'message':
      return facts.message;
    case 'hours_in_status':
      return hoursBetween(facts.statusChangedAt, facts.now);
    case 'hours_since_created':
      return hoursBetween(facts.createdAt, facts.now);
    case 'hours_since_updated':
      return hoursBetween(facts.updatedAt, facts.now);
  }
  const [record, key = ''] = field.split('.', 2);
  const values =
    record === 'ticket'
      ? facts.ticketFields
      : record === 'contact'
        ? facts.contactFields
        : record === 'company'
          ? facts.companyFields
          : {};
  return new Map(Object.entries(values)).get(key);
}

/** Whether one condition matches. Text comparisons ignore case. */
export function conditionMatches(condition: RuleCondition, facts: TicketFacts): boolean {
  const actual = valueOf(condition.field, facts);
  const wanted = listOf(condition.value);
  switch (condition.operator) {
    case 'is_empty':
      return isEmpty(actual);
    case 'is_not_empty':
      return !isEmpty(actual);
    case 'at_least':
    case 'less_than': {
      const hours = Number(wanted[0]);
      if (typeof actual !== 'number' || !Number.isFinite(hours)) return false;
      return condition.operator === 'at_least' ? actual >= hours : actual < hours;
    }
    case 'is_checked':
      return actual === true;
    case 'is_unchecked':
      return actual !== true;
    case 'is':
      return asText(actual) === (wanted[0] ?? '');
    case 'is_not':
      return asText(actual) !== (wanted[0] ?? '');
    case 'is_any':
    case 'is_none': {
      const current = isEmpty(actual) ? NONE : lower(actual);
      const found = wanted.includes(current);
      return condition.operator === 'is_any' ? found : !found;
    }
    case 'contains_any':
    case 'contains_none': {
      const found = Array.isArray(actual)
        ? actual.some((item) => wanted.includes(lower(item)))
        : wanted.some((word) => word !== '' && lower(actual).includes(word));
      return condition.operator === 'contains_any' ? found : !found;
    }
  }
}

/** Whether a rule's conditions match a ticket, and which of them did. */
export function evaluate(
  conditions: RuleConditions,
  facts: TicketFacts,
): { matched: boolean; results: boolean[] } {
  const results = conditions.items.map((condition) => conditionMatches(condition, facts));
  const matched =
    results.length === 0 ||
    (conditions.match === 'all' ? results.every(Boolean) : results.some(Boolean));
  return { matched, results };
}
