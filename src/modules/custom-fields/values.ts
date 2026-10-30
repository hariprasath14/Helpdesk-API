import { ValidationError } from '../../lib/errors.js';
import type { FieldType, RequiredRule } from './models.js';

/** A field as the value checks need it: its rules and its choices. */
export interface FieldDefinition {
  key: string;
  label: string;
  type: FieldType;
  required: RequiredRule;
  archived: boolean;
  defaultValue: unknown;
  choices: { id: string; removed: boolean }[];
}

/** A record's custom field values, by field key. Dropdowns hold choice ids. */
export type CustomFieldValues = Record<string, unknown>;

export const TEXT_MAX = 255;
export const PARAGRAPH_MAX = 5000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/**
 * Checks one value against its field. Returns the value to store, or an error message. A removed
 * choice is accepted only when the record already has it (it is shown as "(removed)").
 */
function checkValue(field: FieldDefinition, value: unknown, existing: unknown): unknown {
  const usable = (id: unknown, kept: boolean) =>
    typeof id === 'string' &&
    field.choices.some((choice) => choice.id === id && (!choice.removed || kept));

  switch (field.type) {
    case 'text':
    case 'paragraph': {
      const max = field.type === 'text' ? TEXT_MAX : PARAGRAPH_MAX;
      if (typeof value !== 'string') return new Error('Enter text.');
      const text = field.type === 'text' ? value.trim() : value;
      if (text.length > max) return new Error(`Use at most ${String(max)} characters.`);
      return text;
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return new Error('Enter a whole number.');
      }
      return value;
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) return new Error('Enter a number.');
      return value;
    case 'date':
      if (typeof value !== 'string' || !isRealDate(value)) {
        return new Error('Enter a date like 2026-10-25.');
      }
      return value;
    case 'checkbox':
      if (typeof value !== 'boolean') return new Error('Choose yes or no.');
      return value;
    case 'dropdown':
      if (!usable(value, value === existing)) return new Error('Choose one of the options.');
      return value;
    case 'multi_select': {
      if (!Array.isArray(value)) return new Error('Choose from the options.');
      const before = Array.isArray(existing) ? existing : [];
      const ids = [...new Set(value)];
      if (ids.some((id) => !usable(id, before.includes(id)))) {
        return new Error('Choose from the options.');
      }
      return ids;
    }
  }
}

export interface CheckOptions {
  /** The record's current values (when changing a record). */
  existing?: CustomFieldValues;
  /** A new record: fields with a default get it when no value is given. */
  creating?: boolean;
  /** The ticket is being resolved: "required when resolving" fields must have a value. */
  resolving?: boolean;
  /**
   * Nobody is there to fill required fields (a ticket or contact created from an email, F14):
   * defaults apply, and required fields are asked for when a member next saves the record.
   */
  skipRequired?: boolean;
}

/**
 * Checks and merges custom field values for a record against the workspace's definitions. `input`
 * holds only the fields being set; null clears one. Unknown fields, archived fields being changed,
 * wrong types, unknown choices and missing required values are all refused together, each under
 * `customFields.<key>`. Returns the full set of values to store.
 */
export function checkCustomFieldValues(
  definitions: FieldDefinition[],
  input: CustomFieldValues | undefined,
  options: CheckOptions = {},
): CustomFieldValues {
  // Maps, not plain objects: keys come from requests ("__proto__" must be just an unknown key).
  const existing = new Map(Object.entries(options.existing ?? {}));
  const byKey = new Map(definitions.map((field) => [field.key, field]));
  const values = new Map(existing);
  const problems: { field: string; message: string }[] = [];
  const problem = (key: string, message: string) => {
    problems.push({ field: `customFields.${key}`, message });
  };

  for (const [key, value] of Object.entries(input ?? {})) {
    const field = byKey.get(key);
    if (!field) {
      problem(key, 'This field does not exist.');
      continue;
    }
    if (field.archived) {
      if (value !== existing.get(key)) {
        problem(key, `${field.label} is archived and can't be changed.`);
      }
      continue;
    }
    if (isEmpty(value)) {
      values.delete(key);
      continue;
    }
    const checked = checkValue(field, value, existing.get(key));
    if (checked instanceof Error) problem(key, checked.message);
    else values.set(key, checked);
  }

  for (const field of definitions) {
    if (field.archived) continue;
    if (options.creating && isEmpty(values.get(field.key)) && !isEmpty(field.defaultValue)) {
      values.set(field.key, field.defaultValue);
    }
    const needed =
      !options.skipRequired &&
      (field.required === 'always' || (field.required === 'on_resolve' && options.resolving));
    if (
      needed &&
      isEmpty(values.get(field.key)) &&
      !problems.some((p) => p.field === `customFields.${field.key}`)
    ) {
      problem(field.key, `${field.label} is required.`);
    }
  }

  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
  return Object.fromEntries(values);
}
