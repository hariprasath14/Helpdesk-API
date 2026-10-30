import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit, type AuditRecord } from '../audit/audit.service.js';
import {
  customFieldModels,
  type CustomFieldRecord,
  type FieldType,
  type RecordType,
  type RequiredRule,
} from './models.js';
import type { FieldDefinition } from './values.js';

/** Active fields allowed per record type, and choices per dropdown. */
export const MAX_ACTIVE_FIELDS = 50;
export const MAX_CHOICES = 200;

const CHOICE_TYPES = new Set<FieldType>(['dropdown', 'multi_select']);

export interface ChoiceView {
  id: string;
  label: string;
  removed: boolean;
  isDefault: boolean;
}

export interface FieldView {
  id: string;
  recordType: RecordType;
  key: string;
  label: string;
  helpText: string | null;
  type: FieldType;
  required: RequiredRule;
  archived: boolean;
  position: number;
  /** Checkbox default (true/false), or null. Dropdown defaults are marked on choices. */
  checkboxDefault: boolean | null;
  choices: ChoiceView[];
}

interface Deps {
  db: Database;
}

const defaultIds = (field: CustomFieldRecord): string[] => {
  const value = field.defaultValue;
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};

/** All of a record type's fields (archived too) with their choices, in order. */
async function readFields(
  deps: Deps,
  recordType: RecordType,
  transaction: Transaction,
): Promise<FieldView[]> {
  const { CustomField, CustomFieldChoice } = customFieldModels(deps.db.writer);
  const fields = await CustomField.findAll({
    where: { recordType },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
  const choices = await CustomFieldChoice.findAll({
    where: { fieldId: fields.map((field) => field.id) },
    order: [['position', 'ASC']],
    transaction,
  });
  return fields.map((field) => {
    const defaults = new Set(defaultIds(field));
    return {
      id: field.id,
      recordType: field.recordType,
      key: field.key,
      label: field.label,
      helpText: field.helpText,
      type: field.type,
      required: field.required,
      archived: field.archivedAt !== null,
      position: field.position,
      checkboxDefault: field.type === 'checkbox' ? (field.defaultValue as boolean | null) : null,
      choices: choices
        .filter((choice) => choice.fieldId === field.id)
        .map((choice) => ({
          id: choice.id,
          label: choice.label,
          removed: choice.removedAt !== null,
          isDefault: defaults.has(choice.id),
        })),
    };
  });
}

/**
 * A record type's fields for forms and settings (any signed-in member: everyone sees fields on
 * records). Reads the writer: the settings page reloads it right after each change.
 */
export async function listFields(
  deps: Deps,
  signedIn: SignedIn,
  recordType: RecordType,
): Promise<FieldView[]> {
  return withWorkspace(deps.db.writer, signedIn.workspace.id, (transaction) =>
    readFields(deps, recordType, transaction),
  );
}

/**
 * The definitions the value checks need, for a record type (F7 and F9 use this inside their own
 * workspace transaction before saving a record).
 */
export async function fieldDefinitions(
  deps: Deps,
  recordType: RecordType,
  transaction: Transaction,
): Promise<FieldDefinition[]> {
  const fields = await readFields(deps, recordType, transaction);
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    archived: field.archived,
    defaultValue:
      field.type === 'checkbox'
        ? field.checkboxDefault
        : field.type === 'dropdown'
          ? (field.choices.find((choice) => choice.isDefault && !choice.removed)?.id ?? null)
          : field.type === 'multi_select'
            ? field.choices.filter((choice) => choice.isDefault && !choice.removed).map((c) => c.id)
            : null,
    choices: field.choices.map((choice) => ({ id: choice.id, removed: choice.removed })),
  }));
}

/** "Contract value (₹)" → "contract_value"; unique within the record type. */
export function keyFromLabel(label: string, taken: Set<string>): string {
  let base = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!/^[a-z]/.test(base)) base = `field_${base}`.replace(/_+$/, '');
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${String(n)}`;
  return key;
}

export interface ChoiceInput {
  id?: string | undefined;
  label: string;
  isDefault?: boolean | undefined;
}

function checkChoices(type: FieldType, choices: ChoiceInput[] | undefined): ChoiceInput[] {
  if (!CHOICE_TYPES.has(type)) {
    if (choices && choices.length > 0) {
      throw new ValidationError('Only dropdown and multi-select fields have choices.');
    }
    return [];
  }
  const list = (choices ?? []).map((choice) => ({ ...choice, label: choice.label.trim() }));
  const problems: { field: string; message: string }[] = [];
  if (list.length === 0) problems.push({ field: 'choices', message: 'Add at least one choice.' });
  if (list.length > MAX_CHOICES) {
    problems.push({ field: 'choices', message: `Use at most ${String(MAX_CHOICES)} choices.` });
  }
  const seen = new Set<string>();
  list.forEach((choice, index) => {
    const name = choice.label.toLowerCase();
    if (!choice.label)
      problems.push({ field: `choices.${String(index)}`, message: 'Enter a choice.' });
    else if (seen.has(name)) {
      problems.push({
        field: `choices.${String(index)}`,
        message: 'This choice is already in the list.',
      });
    }
    seen.add(name);
  });
  if (type === 'dropdown' && list.filter((choice) => choice.isDefault).length > 1) {
    problems.push({ field: 'choices', message: 'Pick at most one default choice.' });
  }
  if (problems.length > 0) throw new ValidationError('Check the choices.', { fields: problems });
  return list;
}

function checkRequired(recordType: RecordType, required: RequiredRule) {
  if (required === 'on_resolve' && recordType !== 'ticket') {
    throw new ValidationError('"Required when resolving" is for ticket fields only.', {
      fields: [
        { field: 'required', message: 'Only ticket fields can be required when resolving.' },
      ],
    });
  }
}

async function activeCount(deps: Deps, recordType: RecordType, transaction: Transaction) {
  const { CustomField } = customFieldModels(deps.db.writer);
  return CustomField.count({ where: { recordType, archivedAt: null }, transaction });
}

function tooMany() {
  return new ConflictError(
    `A record type can have at most ${String(MAX_ACTIVE_FIELDS)} active fields. Archive one first.`,
  );
}

/** Trimmed text, or null when blank. */
const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
};

function audit(
  deps: Deps,
  signedIn: SignedIn,
  field: { id: string; label: string; recordType: RecordType },
  action: AuditRecord['action'],
  details: Record<string, unknown>,
  transaction: Transaction,
) {
  return recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action,
      target: { type: 'custom_field', id: field.id, label: field.label },
      details: { recordType: field.recordType, ...details },
      meta: signedIn.meta,
    },
    transaction,
  );
}

/** Saves a dropdown's choices in order and returns the default as stored on the field. */
async function saveChoices(
  deps: Deps,
  signedIn: SignedIn,
  field: CustomFieldRecord,
  choices: ChoiceInput[],
  transaction: Transaction,
): Promise<unknown> {
  const { CustomFieldChoice } = customFieldModels(deps.db.writer);
  const existing = await CustomFieldChoice.findAll({ where: { fieldId: field.id }, transaction });
  const byId = new Map(existing.map((choice) => [choice.id, choice]));
  const kept = new Set<string>();
  const defaults: string[] = [];

  for (const [position, input] of choices.entries()) {
    const current = input.id ? byId.get(input.id) : undefined;
    if (input.id && !current) {
      throw new ValidationError('A choice in the list no longer exists. Reload and try again.');
    }
    let id = current?.id;
    if (current) {
      await current.update({ label: input.label, position, removedAt: null }, { transaction });
    } else {
      id = newId();
      await CustomFieldChoice.create(
        {
          id,
          workspaceId: signedIn.workspace.id,
          fieldId: field.id,
          label: input.label,
          position,
          removedAt: null,
        },
        { transaction },
      );
    }
    kept.add(id ?? '');
    if (input.isDefault) defaults.push(id ?? '');
  }
  // Choices left out are removed, not deleted: records that have them still show them.
  for (const choice of existing) {
    if (!kept.has(choice.id) && !choice.removedAt) {
      await choice.update(
        { removedAt: new Date(), position: choice.position + choices.length },
        {
          transaction,
        },
      );
    }
  }
  if (field.type === 'dropdown') return defaults[0] ?? null;
  return defaults.length > 0 ? defaults : null;
}

export interface NewFieldInput {
  recordType: RecordType;
  label: string;
  helpText?: string | undefined;
  type: FieldType;
  required: RequiredRule;
  checkboxDefault?: boolean | undefined;
  choices?: ChoiceInput[] | undefined;
}

/** Adds a field at the end of the record type's list (admins). Returns the updated list. */
export async function createField(
  deps: Deps,
  signedIn: SignedIn,
  input: NewFieldInput,
): Promise<FieldView[]> {
  requirePermission(signedIn, 'settings.manage');
  checkRequired(input.recordType, input.required);
  const choices = checkChoices(input.type, input.choices);
  const { CustomField } = customFieldModels(deps.db.writer);

  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    if ((await activeCount(deps, input.recordType, transaction)) >= MAX_ACTIVE_FIELDS) {
      throw tooMany();
    }
    const others = await CustomField.findAll({
      attributes: ['key', 'position'],
      where: { recordType: input.recordType },
      transaction,
    });
    const field = await CustomField.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        recordType: input.recordType,
        key: keyFromLabel(input.label, new Set(others.map((row) => row.key))),
        label: input.label.trim(),
        helpText: blankToNull(input.helpText),
        type: input.type,
        required: input.required,
        defaultValue: input.type === 'checkbox' ? (input.checkboxDefault ?? null) : null,
        position: Math.max(-1, ...others.map((row) => row.position)) + 1,
        archivedAt: null,
      },
      { transaction },
    );
    if (choices.length > 0) {
      const defaultValue = await saveChoices(deps, signedIn, field, choices, transaction);
      await field.update({ defaultValue }, { transaction });
    }
    await audit(
      deps,
      signedIn,
      field,
      'custom_field.created',
      { key: field.key, type: field.type },
      transaction,
    );
    return readFields(deps, input.recordType, transaction);
  });
}

export interface FieldChanges {
  label?: string | undefined;
  helpText?: string | null | undefined;
  required?: RequiredRule | undefined;
  checkboxDefault?: boolean | null | undefined;
  choices?: ChoiceInput[] | undefined;
}

async function lockedField(deps: Deps, fieldId: string, transaction: Transaction) {
  const { CustomField } = customFieldModels(deps.db.writer);
  const field = await CustomField.findByPk(fieldId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!field) throw new NotFoundError('This field does not exist.');
  return field;
}

/**
 * Changes a field's label, help text, required rule, default or choices (admins). The key and
 * type never change. Returns the updated list.
 */
export async function updateField(
  deps: Deps,
  signedIn: SignedIn,
  fieldId: string,
  changes: FieldChanges,
): Promise<FieldView[]> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const field = await lockedField(deps, fieldId, transaction);
    const changed: string[] = [];
    const update: Partial<{
      label: string;
      helpText: string | null;
      required: RequiredRule;
      defaultValue: unknown;
    }> = {};
    const before = field.label;

    if (changes.label !== undefined && changes.label.trim() !== field.label) {
      update.label = changes.label.trim();
      changed.push('label');
    }
    if (changes.helpText !== undefined && blankToNull(changes.helpText) !== field.helpText) {
      update.helpText = blankToNull(changes.helpText);
      changed.push('help text');
    }
    if (changes.required !== undefined && changes.required !== field.required) {
      checkRequired(field.recordType, changes.required);
      update.required = changes.required;
      changed.push('required');
    }
    if (changes.checkboxDefault !== undefined) {
      if (field.type !== 'checkbox') {
        throw new ValidationError('Only checkbox fields have a yes/no default.');
      }
      if (changes.checkboxDefault !== field.defaultValue) {
        update.defaultValue = changes.checkboxDefault;
        changed.push('default');
      }
    }
    if (changes.choices !== undefined) {
      const choices = checkChoices(field.type, changes.choices);
      update.defaultValue = await saveChoices(deps, signedIn, field, choices, transaction);
      changed.push('choices');
    }

    if (changed.length > 0) {
      await field.update(update, { transaction });
      await audit(
        deps,
        signedIn,
        field,
        'custom_field.updated',
        { changed, ...(update.label ? { from: before, to: update.label } : {}) },
        transaction,
      );
    }
    return readFields(deps, field.recordType, transaction);
  });
}

/** Hides a field from forms; its values stay on records (admins). */
export async function archiveField(
  deps: Deps,
  signedIn: SignedIn,
  fieldId: string,
): Promise<FieldView[]> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const field = await lockedField(deps, fieldId, transaction);
    if (!field.archivedAt) {
      await field.update({ archivedAt: new Date() }, { transaction });
      await audit(deps, signedIn, field, 'custom_field.archived', {}, transaction);
    }
    return readFields(deps, field.recordType, transaction);
  });
}

/** Brings an archived field back, at the end of the list (admins). */
export async function restoreField(
  deps: Deps,
  signedIn: SignedIn,
  fieldId: string,
): Promise<FieldView[]> {
  requirePermission(signedIn, 'settings.manage');
  const { CustomField } = customFieldModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const field = await lockedField(deps, fieldId, transaction);
    if (field.archivedAt) {
      if ((await activeCount(deps, field.recordType, transaction)) >= MAX_ACTIVE_FIELDS) {
        throw tooMany();
      }
      const last = await CustomField.max<number | null, CustomFieldRecord>('position', {
        where: { recordType: field.recordType },
        transaction,
      });
      await field.update({ archivedAt: null, position: (last ?? -1) + 1 }, { transaction });
      await audit(deps, signedIn, field, 'custom_field.restored', {}, transaction);
    }
    return readFields(deps, field.recordType, transaction);
  });
}

/**
 * Sets the order of a record type's active fields (admins). `fieldIds` must list every active field
 * once; archived fields keep their place after them.
 */
export async function reorderFields(
  deps: Deps,
  signedIn: SignedIn,
  recordType: RecordType,
  fieldIds: string[],
): Promise<FieldView[]> {
  requirePermission(signedIn, 'settings.manage');
  const { CustomField } = customFieldModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const active = await CustomField.findAll({
      where: { recordType, archivedAt: null },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const ids = new Set(active.map((field) => field.id));
    if (
      fieldIds.length !== ids.size ||
      new Set(fieldIds).size !== ids.size ||
      fieldIds.some((id) => !ids.has(id))
    ) {
      throw new ConflictError('The list of fields has changed. Reload and try again.');
    }
    const byId = new Map(active.map((field) => [field.id, field]));
    let changed = false;
    for (const [position, id] of fieldIds.entries()) {
      const field = byId.get(id);
      if (field && field.position !== position) {
        await field.update({ position }, { transaction });
        changed = true;
      }
    }
    if (changed) {
      await recordAudit(
        deps.db,
        {
          workspaceId: signedIn.workspace.id,
          actor: memberActor(signedIn.user, signedIn.role),
          action: 'custom_fields.reordered',
          details: { recordType },
          meta: signedIn.meta,
        },
        transaction,
      );
    }
    return readFields(deps, recordType, transaction);
  });
}
