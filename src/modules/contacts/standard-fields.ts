import type { RecordType } from '../custom-fields/models.js';
import { MAX_DOMAINS } from './companies.service.js';
import { MAX_TAGS, SUBJECT_MAX } from '../tickets/tickets.service.js';
import { MAX_OTHER_EMAILS } from './contacts.service.js';

/** A built-in field: always on the record's form, above the custom fields, never edited by admins. */
export interface StandardField {
  /** The request and response property, for example "otherEmails". */
  key: string;
  label: string;
  /** What it holds, as Settings shows it. */
  description: string;
  /** The rule the API enforces, or null when optional. */
  rule: string | null;
}

const EMAIL_OR_PHONE = 'Email or phone required';

/**
 * The one definition of each record type's built-in fields. The API returns it with the custom
 * fields, so Settings shows the whole form; the texts use the same limits the checks use.
 * Admin changes to these fields (order, required) are "Form layouts", Release 2.
 */
const STANDARD_FIELDS = new Map<RecordType, StandardField[]>([
  [
    'ticket',
    [
      {
        key: 'contactId',
        label: 'Requester',
        description: 'Contact; a new one can be added by name and email or phone',
        rule: 'Required',
      },
      {
        key: 'subject',
        label: 'Subject',
        description: `Text, up to ${String(SUBJECT_MAX)} characters`,
        rule: 'Required',
      },
      {
        key: 'description',
        label: 'Description',
        description: 'The first message, plain text',
        rule: null,
      },
      {
        key: 'status',
        label: 'Status',
        description: 'Open, Pending, Waiting on customer, Resolved or Closed; starts Open',
        rule: 'Required',
      },
      {
        key: 'priority',
        label: 'Priority',
        description: 'Low, Medium, High or Urgent; starts Medium',
        rule: 'Required',
      },
      {
        key: 'type',
        label: 'Type',
        description: 'Question, Incident, Problem or Feature request',
        rule: null,
      },
      { key: 'teamId', label: 'Team', description: 'One of your teams', rule: null },
      {
        key: 'assigneeUserId',
        label: 'Assignee',
        description: 'An active member; agents can only take a ticket or give it back',
        rule: null,
      },
      {
        key: 'tags',
        label: 'Tags',
        description: `Up to ${String(MAX_TAGS)} free-text tags`,
        rule: null,
      },
    ],
  ],
  [
    'contact',
    [
      { key: 'name', label: 'Name', description: 'Text', rule: 'Required' },
      {
        key: 'email',
        label: 'Email',
        description: 'Email, unique in the workspace',
        rule: EMAIL_OR_PHONE,
      },
      { key: 'phone', label: 'Phone', description: 'Phone number', rule: EMAIL_OR_PHONE },
      {
        key: 'otherEmails',
        label: 'Other emails',
        description: `Up to ${String(MAX_OTHER_EMAILS)} more emails`,
        rule: null,
      },
      { key: 'jobTitle', label: 'Job title', description: 'Text', rule: null },
      {
        key: 'companyId',
        label: 'Company',
        description: 'Company, matched by email domain when left empty',
        rule: null,
      },
      { key: 'note', label: 'Note', description: 'Paragraph, seen only by your team', rule: null },
    ],
  ],
  [
    'company',
    [
      {
        key: 'name',
        label: 'Name',
        description: 'Text, unique in the workspace',
        rule: 'Required',
      },
      {
        key: 'domains',
        label: 'Email domains',
        description: `Up to ${String(MAX_DOMAINS)} domains; new contacts join by email`,
        rule: null,
      },
      { key: 'phone', label: 'Phone', description: 'Phone number', rule: null },
      { key: 'website', label: 'Website', description: 'Web address', rule: null },
      { key: 'note', label: 'Note', description: 'Paragraph, seen only by your team', rule: null },
    ],
  ],
]);

export const standardFieldsFor = (recordType: RecordType): StandardField[] =>
  STANDARD_FIELDS.get(recordType) ?? [];
