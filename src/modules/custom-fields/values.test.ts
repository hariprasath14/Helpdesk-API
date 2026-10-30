import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../lib/errors.js';
import type { FieldType } from './models.js';
import { checkCustomFieldValues, type FieldDefinition } from './values.js';

const field = (
  key: string,
  type: FieldType,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition => ({
  key,
  label: key.toUpperCase(),
  type,
  required: 'never',
  archived: false,
  defaultValue: null,
  choices: [],
  ...overrides,
});

const plan = field('plan', 'dropdown', {
  choices: [
    { id: 'basic', removed: false },
    { id: 'premium', removed: false },
    { id: 'legacy', removed: true },
  ],
});
const modules = field('modules', 'multi_select', {
  choices: [
    { id: 'hr', removed: false },
    { id: 'pay', removed: false },
    { id: 'old', removed: true },
  ],
});
const ALL = [
  field('code', 'text'),
  field('notes', 'paragraph'),
  field('users', 'integer'),
  field('value', 'decimal'),
  field('renewal', 'date'),
  field('vip', 'checkbox'),
  plan,
  modules,
];

function problems(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof ValidationError) {
      const { fields } = error.details as { fields: { field: string; message: string }[] };
      return Object.fromEntries(fields.map((f) => [f.field, f.message]));
    }
    throw error;
  }
  throw new Error('expected a validation error');
}

describe('custom field values', () => {
  it('accepts a valid value of every type, trimming one-line text', () => {
    expect(
      checkCustomFieldValues(ALL, {
        code: '  EMP-42 ',
        notes: 'Line one\nLine two',
        users: 25,
        value: 1999.5,
        renewal: '2026-12-31',
        vip: false,
        plan: 'premium',
        modules: ['hr', 'pay', 'hr'],
      }),
    ).toEqual({
      code: 'EMP-42',
      notes: 'Line one\nLine two',
      users: 25,
      value: 1999.5,
      renewal: '2026-12-31',
      vip: false,
      plan: 'premium',
      modules: ['hr', 'pay'],
    });
  });

  it('refuses wrong values with a message per field', () => {
    expect(
      problems(() =>
        checkCustomFieldValues(ALL, {
          code: 'x'.repeat(256),
          users: 2.5,
          value: 'lots',
          renewal: '2026-02-30',
          vip: 'yes',
          plan: 'gold',
          modules: ['hr', 'nope'],
        }),
      ),
    ).toEqual({
      'customFields.code': 'Use at most 255 characters.',
      'customFields.users': 'Enter a whole number.',
      'customFields.value': 'Enter a number.',
      'customFields.renewal': 'Enter a date like 2026-10-25.',
      'customFields.vip': 'Choose yes or no.',
      'customFields.plan': 'Choose one of the options.',
      'customFields.modules': 'Choose from the options.',
    });
  });

  it('refuses unknown fields, including object property tricks', () => {
    expect(
      problems(() =>
        checkCustomFieldValues(ALL, JSON.parse('{"nope": 1, "__proto__": {"x": 1}}') as never),
      ),
    ).toEqual({
      'customFields.nope': 'This field does not exist.',
      'customFields.__proto__': 'This field does not exist.',
    });
  });

  it('clears a value with null or an empty value, and keeps the others', () => {
    expect(
      checkCustomFieldValues(
        ALL,
        { code: null, modules: [] },
        {
          existing: { code: 'A', modules: ['hr'], users: 3 },
        },
      ),
    ).toEqual({ users: 3 });
  });

  it('keeps a removed choice a record already has, but never offers it for a new value', () => {
    const existing = { plan: 'legacy', modules: ['old'] };
    expect(
      checkCustomFieldValues(ALL, { plan: 'legacy', modules: ['old', 'hr'] }, { existing }),
    ).toEqual({
      plan: 'legacy',
      modules: ['old', 'hr'],
    });
    expect(problems(() => checkCustomFieldValues(ALL, { plan: 'legacy' }))).toEqual({
      'customFields.plan': 'Choose one of the options.',
    });
  });

  it('keeps archived fields as they are and refuses changes to them', () => {
    const fields = [field('old', 'text', { archived: true, required: 'always' })];
    expect(checkCustomFieldValues(fields, { old: 'same' }, { existing: { old: 'same' } })).toEqual({
      old: 'same',
    });
    expect(
      problems(() => checkCustomFieldValues(fields, { old: 'new' }, { existing: { old: 'same' } })),
    ).toEqual({ 'customFields.old': "OLD is archived and can't be changed." });
  });

  it('fills defaults for new records only', () => {
    const fields = [
      field('vip', 'checkbox', { defaultValue: true }),
      { ...plan, defaultValue: 'basic' },
    ];
    expect(checkCustomFieldValues(fields, {}, { creating: true })).toEqual({
      vip: true,
      plan: 'basic',
    });
    expect(checkCustomFieldValues(fields, { plan: 'premium' }, { creating: true })).toEqual({
      vip: true,
      plan: 'premium',
    });
    expect(checkCustomFieldValues(fields, {})).toEqual({});
  });

  it('requires "always" fields every time and "when resolving" fields only when resolving', () => {
    const fields = [
      field('code', 'text', { required: 'always' }),
      field('cause', 'dropdown', {
        required: 'on_resolve',
        choices: [{ id: 'bug', removed: false }],
      }),
      field('vip', 'checkbox', { required: 'always' }),
    ];
    expect(problems(() => checkCustomFieldValues(fields, { vip: false }))).toEqual({
      'customFields.code': 'CODE is required.',
    });
    expect(checkCustomFieldValues(fields, { code: 'A', vip: false })).toEqual({
      code: 'A',
      vip: false,
    });
    expect(
      problems(() => checkCustomFieldValues(fields, { code: 'A', vip: true }, { resolving: true })),
    ).toEqual({ 'customFields.cause': 'CAUSE is required.' });
    expect(problems(() => checkCustomFieldValues(fields, { code: '   ', vip: false }))).toEqual({
      'customFields.code': 'CODE is required.',
    });
  });
});
