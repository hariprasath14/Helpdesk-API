import type { Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { contactModels } from '../contacts/models.js';
import { fieldDefinitions } from '../custom-fields/custom-fields.service.js';
import type { RecordType } from '../custom-fields/models.js';
import type { FieldDefinition } from '../custom-fields/values.js';
import { teamModels } from '../teams/models.js';
import {
  TICKET_PRIORITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  TICKET_TYPES,
  ticketModels,
} from '../tickets/models.js';
import { cleanTags, lockTicketForChange } from '../tickets/tickets.service.js';
import type { RuleAction } from './actions.js';
import {
  BUILT_IN_FIELDS,
  CHANGED_FIELDS,
  EVENT_FIELDS,
  EVENT_LABELS,
  evaluate,
  kindOfCustomField,
  LIST_OPERATORS,
  NONE,
  OPERATORS,
  SINGLE_OPERATORS,
  type FieldKind,
  type RuleCondition,
  type RuleConditions,
} from './conditions.js';
import { factsOf } from './engine.js';
import { ruleModels, type RuleEvent, type RuleRecord } from './models.js';

interface Deps {
  db: Database;
}

/** Rules a workspace can have. */
export const MAX_RULES = 100;
export const MAX_CONDITIONS = 20;
export const MAX_ACTIONS = 10;
const VALUE_MAX = 200;
const NOTE_MAX = 2000;

export interface RuleInput {
  name: string;
  event: RuleEvent;
  enabled?: boolean | undefined;
  conditions: RuleConditions;
  actions: RuleAction[];
  stopAfter?: boolean | undefined;
}

export interface RuleView {
  id: string;
  name: string;
  event: RuleEvent;
  enabled: boolean;
  position: number;
  conditions: RuleConditions;
  actions: RuleAction[];
  stopAfter: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const viewOf = (rule: RuleRecord): RuleView => ({
  id: rule.id,
  name: rule.name,
  event: rule.event,
  enabled: rule.enabled,
  position: rule.position,
  conditions: rule.conditions,
  actions: rule.actions,
  stopAfter: rule.stopAfter,
  createdAt: rule.createdAt,
  updatedAt: rule.updatedAt,
});

interface Problem {
  field: string;
  message: string;
}

/** The workspace's teams, members, companies and custom fields, for checking a rule. */
async function catalog(deps: Deps, transaction: Transaction) {
  const definitions = new Map<string, FieldDefinition>();
  for (const recordType of ['ticket', 'contact', 'company'] as RecordType[]) {
    for (const field of await fieldDefinitions(deps, recordType, transaction)) {
      definitions.set(`${recordType}.${field.key}`, field);
    }
  }
  const teams = await teamModels(deps.db.writer).Team.findAll({
    attributes: ['id'],
    transaction,
  });
  const members = await accountModels(deps.db.writer).Membership.findAll({
    attributes: ['userId', 'status'],
    transaction,
  });
  return {
    definitions,
    teams: new Set(teams.map((team) => team.id)),
    members: new Set(members.map((member) => member.userId)),
    activeMembers: new Set(
      members.filter((member) => member.status === 'active').map((member) => member.userId),
    ),
  };
}
type Catalog = Awaited<ReturnType<typeof catalog>>;

/** The values a choice field accepts ("none" for not set where a field can be empty). */
async function choicesFor(
  deps: Deps,
  field: string,
  known: Catalog,
  values: string[],
  transaction: Transaction,
): Promise<string[] | null> {
  switch (field) {
    case 'status':
      return [...TICKET_STATUSES];
    case 'priority':
      return [...TICKET_PRIORITIES];
    case 'type':
      return [...TICKET_TYPES, NONE];
    case 'source':
      return [...TICKET_SOURCES];
    case 'team':
      return [...known.teams, NONE];
    case 'assignee':
      return [...known.members, NONE];
    case 'changed':
      return [...CHANGED_FIELDS];
    case 'previous_status':
      return [...TICKET_STATUSES];
    case 'company': {
      const ids = values.filter((value) => value !== NONE && /^[0-9a-f-]{36}$/.test(value));
      const found = await contactModels(deps.db.writer).Company.findAll({
        attributes: ['id'],
        where: { id: ids },
        transaction,
      });
      return [...found.map((company) => company.id), NONE];
    }
  }
  const definition = known.definitions.get(field);
  return definition ? [...definition.choices.map((choice) => choice.id), NONE] : null;
}

function kindOf(field: string, known: Catalog): FieldKind | null {
  if (Object.hasOwn(BUILT_IN_FIELDS, field)) {
    return BUILT_IN_FIELDS[field as keyof typeof BUILT_IN_FIELDS];
  }
  const definition = known.definitions.get(field);
  return definition && !definition.archived ? kindOfCustomField(definition.type) : null;
}

async function checkCondition(
  deps: Deps,
  condition: RuleCondition,
  path: string,
  known: Catalog,
  transaction: Transaction,
  /** The rule's event; fields only some events have are refused for the others. */
  event?: RuleEvent,
): Promise<Problem[]> {
  const kind = kindOf(condition.field, known);
  if (!kind) return [{ field: `${path}.field`, message: 'This field does not exist.' }];
  const only = new Map(Object.entries(EVENT_FIELDS)).get(condition.field);
  if (event && only && !only.includes(event)) {
    return [
      {
        field: `${path}.field`,
        message: `This field is only for rules that run ${only.map((name) => new Map(Object.entries(EVENT_LABELS)).get(name) ?? name).join(' or ')}.`,
      },
    ];
  }
  if (
    !(new Map(Object.entries(OPERATORS)).get(kind) ?? []).some((op) => op === condition.operator)
  ) {
    return [{ field: `${path}.operator`, message: 'This comparison does not fit the field.' }];
  }
  const values = Array.isArray(condition.value)
    ? condition.value
    : condition.value === undefined
      ? []
      : [condition.value];
  if (LIST_OPERATORS.includes(condition.operator) && values.length === 0) {
    return [{ field: `${path}.value`, message: 'Add at least one value.' }];
  }
  if (SINGLE_OPERATORS.includes(condition.operator) && values.length !== 1) {
    return [{ field: `${path}.value`, message: 'Enter one value.' }];
  }
  if (kind === 'hours' && !/^\d{1,4}$/.test(values[0] ?? '')) {
    return [{ field: `${path}.value`, message: 'Enter whole hours, from 1 to 8760 (a year).' }];
  }
  if (kind === 'hours' && (Number(values[0]) < 1 || Number(values[0]) > 8760)) {
    return [{ field: `${path}.value`, message: 'Enter whole hours, from 1 to 8760 (a year).' }];
  }
  if (values.some((value) => value.trim() === '' || value.length > VALUE_MAX)) {
    return [
      {
        field: `${path}.value`,
        message: `Values can't be empty or longer than ${String(VALUE_MAX)} characters.`,
      },
    ];
  }
  if (kind === 'choice') {
    const allowed = await choicesFor(deps, condition.field, known, values, transaction);
    if (allowed && values.some((value) => !allowed.includes(value))) {
      return [{ field: `${path}.value`, message: 'Choose from the list.' }];
    }
  }
  return [];
}

function checkAction(action: RuleAction, path: string, known: Catalog): Problem[] {
  const value = Array.isArray(action.value) ? (action.value[0] ?? '') : action.value;
  const problem = (message: string) => [{ field: `${path}.value`, message }];
  switch (action.type) {
    case 'set_priority':
      return (TICKET_PRIORITIES as readonly string[]).includes(value)
        ? []
        : problem('Choose a priority.');
    case 'set_status':
      return (TICKET_STATUSES as readonly string[]).includes(value)
        ? []
        : problem('Choose a status.');
    case 'set_type':
      return [...TICKET_TYPES, NONE].includes(value) ? [] : problem('Choose a type.');
    case 'set_team':
      return value === NONE || known.teams.has(value) ? [] : problem('Choose a team.');
    case 'assign_in_turn':
      return known.teams.has(value) ? [] : problem('Choose a team.');
    case 'set_assignee':
      return value === NONE || known.activeMembers.has(value)
        ? []
        : problem('Choose an active member.');
    case 'add_tags':
    case 'remove_tags': {
      const tags = Array.isArray(action.value) ? action.value : [action.value];
      const cleaned = cleanTags(tags);
      if (cleaned.tags.length === 0) return problem('Add at least one tag.');
      return cleaned.problems.length > 0 ? problem(cleaned.problems[0]?.message ?? '') : [];
    }
    case 'add_note':
      return value.trim() === '' || value.length > NOTE_MAX
        ? problem(`Write a note of up to ${String(NOTE_MAX)} characters.`)
        : [];
    case 'email_requester':
    case 'email_assignee':
    case 'email_team':
      return value.trim() === '' || value.length > NOTE_MAX
        ? problem(`Write a message of up to ${String(NOTE_MAX)} characters.`)
        : [];
  }
}

/** Checks a rule against the workspace; tags are cleaned. Throws with every problem at once. */
async function checkRule(
  deps: Deps,
  input: RuleInput,
  transaction: Transaction,
): Promise<RuleInput> {
  const known = await catalog(deps, transaction);
  const problems: Problem[] = [];
  // A scheduled rule must wait for something, or it would act on every open ticket at once.
  const waits = input.conditions.items.some(
    (item) => item.operator === 'at_least' && kindOf(item.field, known) === 'hours',
  );
  if (input.event === 'time' && (!waits || input.conditions.match !== 'all')) {
    problems.push({
      field: 'conditions',
      message:
        'A scheduled rule needs a time condition such as "Hours in this status is at least 72", and all its conditions must match.',
    });
  }
  for (const [index, condition] of input.conditions.items.entries()) {
    problems.push(
      ...(await checkCondition(
        deps,
        condition,
        `conditions.items.${String(index)}`,
        known,
        transaction,
        input.event,
      )),
    );
  }
  if (input.actions.length === 0) {
    problems.push({ field: 'actions', message: 'Add at least one action.' });
  }
  for (const [index, action] of input.actions.entries()) {
    problems.push(...checkAction(action, `actions.${String(index)}`, known));
  }
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
  return {
    ...input,
    name: input.name.trim(),
    actions: input.actions.map((action) =>
      action.type === 'add_tags' || action.type === 'remove_tags'
        ? {
            ...action,
            value: cleanTags(Array.isArray(action.value) ? action.value : [action.value]).tags,
          }
        : action,
    ),
  };
}

/**
 * Checks conditions that look at a ticket as it stands, outside rules (SLA policies, F23): the
 * fields only some rule events have are refused. Throws with every problem at once.
 */
export async function checkTicketConditions(
  deps: Deps,
  conditions: RuleConditions,
  transaction: Transaction,
): Promise<void> {
  const known = await catalog(deps, transaction);
  const problems: Problem[] = [];
  for (const [index, condition] of conditions.items.entries()) {
    const path = `conditions.items.${String(index)}`;
    if (Object.hasOwn(EVENT_FIELDS, condition.field)) {
      problems.push({ field: `${path}.field`, message: 'This field can only be used in rules.' });
      continue;
    }
    problems.push(...(await checkCondition(deps, condition, path, known, transaction)));
  }
  if (problems.length > 0) {
    throw new ValidationError('Check the highlighted fields.', { fields: problems });
  }
}

/** The workspace's rules, in order (admins, settings.manage). */
export async function listRules(deps: Deps, signedIn: SignedIn): Promise<RuleView[]> {
  requirePermission(signedIn, 'settings.manage');
  const rules = await withWorkspace(deps.db.reader, signedIn.workspace.id, (transaction) =>
    ruleModels(deps.db.reader).AutomationRule.findAll({
      order: [
        ['position', 'ASC'],
        ['createdAt', 'ASC'],
      ],
      transaction,
    }),
  );
  return rules.map(viewOf);
}

const audit = (
  deps: Deps,
  signedIn: SignedIn,
  action: 'rule.created' | 'rule.updated' | 'rule.deleted' | 'rules.reordered',
  target: { id: string | null; label: string },
  details: Record<string, unknown>,
  transaction: Transaction,
) =>
  recordAudit(
    deps.db,
    {
      workspaceId: signedIn.workspace.id,
      actor: memberActor(signedIn.user, signedIn.role),
      action,
      target: { type: 'rule', ...target },
      details,
      meta: signedIn.meta,
    },
    transaction,
  );

/** Adds a rule at the end of the list. Audited. */
export async function createRule(
  deps: Deps,
  signedIn: SignedIn,
  input: RuleInput,
): Promise<RuleView> {
  requirePermission(signedIn, 'settings.manage');
  const { AutomationRule } = ruleModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const checked = await checkRule(deps, input, transaction);
    const count = await AutomationRule.count({ transaction });
    if (count >= MAX_RULES) {
      throw new ConflictError(`A workspace can have up to ${String(MAX_RULES)} rules.`);
    }
    const last = await AutomationRule.max<number | null, RuleRecord>('position', { transaction });
    const rule = await AutomationRule.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        name: checked.name,
        event: checked.event,
        enabled: checked.enabled ?? true,
        position: (last ?? 0) + 1,
        conditions: checked.conditions,
        actions: checked.actions,
        stopAfter: checked.stopAfter ?? false,
        createdByUserId: signedIn.user.id,
        updatedByUserId: signedIn.user.id,
      },
      { transaction },
    );
    await audit(deps, signedIn, 'rule.created', { id: rule.id, label: rule.name }, {}, transaction);
    return viewOf(rule);
  });
}

async function findRule(deps: Deps, ruleId: string, transaction: Transaction) {
  const rule = await ruleModels(deps.db.writer).AutomationRule.findByPk(ruleId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!rule) throw new NotFoundError('This rule does not exist.');
  return rule;
}

/** Changes a rule; only what is given changes. Audited with what changed. */
export async function updateRule(
  deps: Deps,
  signedIn: SignedIn,
  ruleId: string,
  input: Partial<RuleInput>,
): Promise<RuleView> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const rule = await findRule(deps, ruleId, transaction);
    const checked = await checkRule(
      deps,
      {
        name: input.name ?? rule.name,
        event: input.event ?? rule.event,
        enabled: input.enabled ?? rule.enabled,
        conditions: input.conditions ?? rule.conditions,
        actions: input.actions ?? rule.actions,
        stopAfter: input.stopAfter ?? rule.stopAfter,
      },
      transaction,
    );
    const next = {
      name: checked.name,
      event: checked.event,
      enabled: checked.enabled ?? rule.enabled,
      conditions: checked.conditions,
      actions: checked.actions,
      stopAfter: checked.stopAfter ?? rule.stopAfter,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      // The keys come from the object above, not from the request.
      // eslint-disable-next-line security/detect-object-injection
      (key) => JSON.stringify(next[key]) !== JSON.stringify(rule[key]),
    );
    if (changed.length === 0) return viewOf(rule);
    await rule.update({ ...next, updatedByUserId: signedIn.user.id }, { transaction });
    await audit(
      deps,
      signedIn,
      'rule.updated',
      { id: rule.id, label: rule.name },
      { changed, ...(changed.includes('enabled') ? { enabled: next.enabled } : {}) },
      transaction,
    );
    return viewOf(rule);
  });
}

/** Deletes a rule. Audited. */
export async function deleteRule(deps: Deps, signedIn: SignedIn, ruleId: string): Promise<void> {
  requirePermission(signedIn, 'settings.manage');
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const rule = await findRule(deps, ruleId, transaction);
    await rule.destroy({ transaction });
    await audit(deps, signedIn, 'rule.deleted', { id: rule.id, label: rule.name }, {}, transaction);
  });
}

/** Puts the rules in this order (every rule's id, once). Audited. */
export async function reorderRules(
  deps: Deps,
  signedIn: SignedIn,
  ruleIds: string[],
): Promise<RuleView[]> {
  requirePermission(signedIn, 'settings.manage');
  const { AutomationRule } = ruleModels(deps.db.writer);
  const rules = await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const all = await AutomationRule.findAll({ transaction, lock: transaction.LOCK.UPDATE });
    const ids = new Set(all.map((rule) => rule.id));
    if (ruleIds.length !== ids.size || new Set(ruleIds).size !== ids.size) {
      throw new ConflictError('The rules changed meanwhile. Reload the page and try again.');
    }
    if (ruleIds.some((id) => !ids.has(id))) {
      throw new ConflictError('The rules changed meanwhile. Reload the page and try again.');
    }
    for (const [index, id] of ruleIds.entries()) {
      const rule = all.find((item) => item.id === id);
      if (rule && rule.position !== index + 1) {
        await rule.update({ position: index + 1 }, { transaction });
      }
    }
    await audit(deps, signedIn, 'rules.reordered', { id: null, label: 'Rules' }, {}, transaction);
    return AutomationRule.findAll({
      order: [
        ['position', 'ASC'],
        ['createdAt', 'ASC'],
      ],
      transaction,
    });
  });
  return rules.map(viewOf);
}

/**
 * Whether a rule (saved or not) would match a ticket now, and which conditions did. Changes
 * nothing. For "Test on a ticket" in the rule editor.
 */
export async function testRule(
  deps: Deps,
  signedIn: SignedIn,
  input: { conditions: RuleConditions; ticketNumber: number },
): Promise<{ matched: boolean; results: boolean[] }> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const known = await catalog(deps, transaction);
    const problems: Problem[] = [];
    for (const [index, condition] of input.conditions.items.entries()) {
      problems.push(
        ...(await checkCondition(
          deps,
          condition,
          `conditions.items.${String(index)}`,
          known,
          transaction,
        )),
      );
    }
    if (problems.length > 0) {
      throw new ValidationError('Check the highlighted fields.', { fields: problems });
    }
    const ticket = await lockTicketForChange(
      ticketModels(deps.db.writer),
      input.ticketNumber,
      transaction,
    );
    return evaluate(input.conditions, await factsOf(deps, ticket, transaction));
  });
}
