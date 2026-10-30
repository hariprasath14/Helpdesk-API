import { QueryTypes, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { memberActor, recordAudit } from '../audit/audit.service.js';
import { loadCalendar } from '../business-hours/business-hours.service.js';
import { evaluate, type RuleConditions } from '../rules/conditions.js';
import { factsOf } from '../rules/engine.js';
import { checkTicketConditions } from '../rules/rules.service.js';
import type { TicketPriority, TicketRecord, TicketStatus } from '../tickets/models.js';
import { accountModels } from '../accounts/models.js';
import {
  DEFAULT_ESCALATION,
  DEFAULT_TARGETS,
  dueTimes,
  nextAlertAt,
  nextDue,
  PAUSED_STATUS,
  type Escalation,
  type SlaTargets,
} from './clock.js';
import { slaModels, type SlaPolicyRecord } from './models.js';

interface Deps {
  db: Database;
}

/** Policies a workspace can have, the default included. */
export const MAX_POLICIES = 50;
export const DEFAULT_POLICY_NAME = 'Default policy';

const NO_CONDITIONS: RuleConditions = { match: 'all', items: [] };
const DONE: readonly TicketStatus[] = ['resolved', 'closed'];

export interface SlaPolicyView {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  conditions: RuleConditions;
  targets: SlaTargets;
  escalation: Escalation;
  createdAt: Date;
  updatedAt: Date;
}

/** JSON with its keys sorted: jsonb stores keys in its own order, so plain JSON can differ. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

const viewOf = (policy: SlaPolicyRecord): SlaPolicyView => ({
  id: policy.id,
  name: policy.name,
  isDefault: policy.isDefault,
  position: policy.position,
  conditions: policy.conditions,
  targets: policy.targets,
  escalation: policy.escalation,
  createdAt: policy.createdAt,
  updatedAt: policy.updatedAt,
});

/**
 * The workspace's default policy, added with the starting values the first time it is needed.
 * Two requests adding it at once end with one (the unique index on the default).
 */
async function defaultPolicy(
  deps: Deps,
  workspaceId: string,
  transaction: Transaction,
): Promise<SlaPolicyRecord> {
  const { SlaPolicy } = slaModels(deps.db.writer);
  const found = await SlaPolicy.findOne({ where: { isDefault: true }, transaction });
  if (found) return found;
  await deps.db.writer.query(
    `INSERT INTO sla_policies (id, workspace_id, name, is_default, position, conditions, targets)
     VALUES (:id, :workspaceId, :name, true, 0, :conditions, :targets)
     ON CONFLICT (workspace_id) WHERE is_default DO NOTHING`,
    {
      replacements: {
        id: newId(),
        workspaceId,
        name: DEFAULT_POLICY_NAME,
        conditions: JSON.stringify(NO_CONDITIONS),
        targets: JSON.stringify(DEFAULT_TARGETS),
      },
      type: QueryTypes.INSERT,
      transaction,
    },
  );
  const added = await SlaPolicy.findOne({ where: { isDefault: true }, transaction });
  if (!added) throw new Error('No default SLA policy');
  return added;
}

/** The extra policies in order, then the default. */
async function allPolicies(deps: Deps, workspaceId: string, transaction: Transaction) {
  const fallback = await defaultPolicy(deps, workspaceId, transaction);
  const extra = await slaModels(deps.db.writer).SlaPolicy.findAll({
    where: { isDefault: false },
    order: [
      ['position', 'ASC'],
      ['createdAt', 'ASC'],
    ],
    transaction,
  });
  return { extra, fallback };
}

/** The policy a ticket follows: the first extra policy whose conditions match, or the default. */
export async function choosePolicy(
  deps: Deps,
  ticket: TicketRecord,
  transaction: Transaction,
): Promise<SlaPolicyRecord> {
  const { extra, fallback } = await allPolicies(deps, ticket.workspaceId, transaction);
  if (extra.length === 0) return fallback;
  const facts = await factsOf(deps, ticket, transaction);
  return extra.find((policy) => evaluate(policy.conditions, facts).matched) ?? fallback;
}

/** How the ticket was before a change, for the clocks to follow it. */
export interface SlaBefore {
  status: TicketStatus;
  priority: TicketPriority;
  statusChangedAt: Date;
}

/**
 * Keeps a ticket's SLA current inside the caller's transaction (F23), after it is created
 * (`before` left out) or changed:
 * - leaving "Waiting on customer" ends a pause, which the clocks then leave out;
 * - reopening a resolved or closed ticket starts the resolve clock again from now;
 * - a new priority, or a change that makes another policy match, works the due times out again
 *   from creation.
 * Then the next running deadline is set. Saved without touching "last updated".
 */
export async function updateSla(
  deps: Deps,
  ticket: TicketRecord,
  transaction: Transaction,
  before?: SlaBefore,
): Promise<void> {
  const now = new Date();
  let recalculate = before === undefined;
  if (before) {
    if (before.status === PAUSED_STATUS && ticket.status !== PAUSED_STATUS) {
      ticket.slaPauses = [
        ...ticket.slaPauses,
        { from: before.statusChangedAt.toISOString(), to: now.toISOString() },
      ];
      recalculate = true;
    }
    if (DONE.includes(before.status) && !DONE.includes(ticket.status)) {
      ticket.slaResolveFrom = now;
      recalculate = true;
    }
    if (before.priority !== ticket.priority) recalculate = true;
  }
  const policy = await choosePolicy(deps, ticket, transaction);
  if (policy.id !== ticket.slaPolicyId) recalculate = true;
  if (recalculate) {
    const calendar = await loadCalendar(deps, ticket.workspaceId, transaction);
    const due = dueTimes(ticket, policy.targets[ticket.priority], calendar);
    ticket.set({ slaPolicyId: policy.id, slaReplyDueAt: due.reply, slaResolveDueAt: due.resolve });
  }
  ticket.slaDueAt = nextDue(ticket)?.at ?? null;
  ticket.slaAlertAt = nextAlertAt(ticket, policy.escalation.warnMinutes);
  if (ticket.changed()) await ticket.save({ transaction, silent: true });
}

// --- Settings → SLAs -----------------------------------------------------------------------------

/** The workspace's policies: the extra ones in order, then the default (admins). */
export async function listPolicies(deps: Deps, signedIn: SignedIn): Promise<SlaPolicyView[]> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const { extra, fallback } = await allPolicies(deps, signedIn.workspace.id, transaction);
    return [...extra, fallback].map(viewOf);
  });
}

type AuditAction =
  'sla_policy.created' | 'sla_policy.updated' | 'sla_policy.deleted' | 'sla_policies.reordered';

const audit = (
  deps: Deps,
  signedIn: SignedIn,
  action: AuditAction,
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
      target: { type: 'sla_policy', ...target },
      details,
      meta: signedIn.meta,
    },
    transaction,
  );

export interface PolicyInput {
  name: string;
  conditions: RuleConditions;
  targets: SlaTargets;
  escalation?: Escalation | undefined;
}

/** The escalation as saved: a chosen person must be an active member; others need none. */
async function checkEscalation(
  deps: Deps,
  escalation: Escalation,
  transaction: Transaction,
): Promise<Escalation> {
  if (escalation.reassign !== 'person') return { ...escalation, reassignUserId: null };
  const member = escalation.reassignUserId
    ? await accountModels(deps.db.writer).Membership.findOne({
        attributes: ['userId'],
        where: { userId: escalation.reassignUserId, status: 'active' },
        transaction,
      })
    : null;
  if (!member) {
    throw new ValidationError('Check the highlighted fields.', {
      fields: [{ field: 'escalation.reassignUserId', message: 'Choose an active member.' }],
    });
  }
  return escalation;
}

/** Adds a policy with conditions, before the default and after the other policies. Audited. */
export async function createPolicy(
  deps: Deps,
  signedIn: SignedIn,
  input: PolicyInput,
): Promise<SlaPolicyView> {
  requirePermission(signedIn, 'settings.manage');
  const { SlaPolicy } = slaModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    await checkTicketConditions(deps, input.conditions, transaction);
    const escalation = await checkEscalation(
      deps,
      input.escalation ?? DEFAULT_ESCALATION,
      transaction,
    );
    await defaultPolicy(deps, signedIn.workspace.id, transaction);
    if ((await SlaPolicy.count({ transaction })) >= MAX_POLICIES) {
      throw new ConflictError(`A workspace can have up to ${String(MAX_POLICIES)} SLA policies.`);
    }
    const last = await SlaPolicy.max<number | null, SlaPolicyRecord>('position', {
      where: { isDefault: false },
      transaction,
    });
    const policy = await SlaPolicy.create(
      {
        id: newId(),
        workspaceId: signedIn.workspace.id,
        name: input.name.trim(),
        isDefault: false,
        position: (last ?? 0) + 1,
        conditions: input.conditions,
        targets: input.targets,
        escalation,
        createdByUserId: signedIn.user.id,
        updatedByUserId: signedIn.user.id,
      },
      { transaction },
    );
    await audit(
      deps,
      signedIn,
      'sla_policy.created',
      { id: policy.id, label: policy.name },
      {},
      transaction,
    );
    return viewOf(policy);
  });
}

async function findPolicy(deps: Deps, policyId: string, transaction: Transaction) {
  const policy = await slaModels(deps.db.writer).SlaPolicy.findByPk(policyId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!policy) throw new NotFoundError('This SLA policy does not exist.');
  return policy;
}

/**
 * Changes a policy; only what is given changes. The default has no conditions. New due times use
 * it from now on; tickets keep the ones already worked out until their priority changes. Audited.
 */
export async function updatePolicy(
  deps: Deps,
  signedIn: SignedIn,
  policyId: string,
  input: Partial<PolicyInput>,
): Promise<SlaPolicyView> {
  requirePermission(signedIn, 'settings.manage');
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const policy = await findPolicy(deps, policyId, transaction);
    if (policy.isDefault && input.conditions && input.conditions.items.length > 0) {
      throw new ValidationError('Check the highlighted fields.', {
        fields: [
          {
            field: 'conditions',
            message: 'The default policy covers every ticket no other policy matches.',
          },
        ],
      });
    }
    if (input.conditions && !policy.isDefault) {
      await checkTicketConditions(deps, input.conditions, transaction);
    }
    const next = {
      name: input.name?.trim() ?? policy.name,
      conditions: policy.isDefault ? policy.conditions : (input.conditions ?? policy.conditions),
      targets: input.targets ?? policy.targets,
      escalation: input.escalation
        ? await checkEscalation(deps, input.escalation, transaction)
        : policy.escalation,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
      // The keys come from the object above, not from the request.
      // eslint-disable-next-line security/detect-object-injection
      (key) => canonical(next[key]) !== canonical(policy[key]),
    );
    if (changed.length === 0) return viewOf(policy);
    const label = policy.name;
    await policy.update({ ...next, updatedByUserId: signedIn.user.id }, { transaction });
    await audit(
      deps,
      signedIn,
      'sla_policy.updated',
      { id: policy.id, label },
      { changed },
      transaction,
    );
    return viewOf(policy);
  });
}

/**
 * Deletes a policy with conditions (the default stays). Its tickets keep their due times; their
 * next change picks a policy again. Audited.
 */
export async function deletePolicy(
  deps: Deps,
  signedIn: SignedIn,
  policyId: string,
): Promise<void> {
  requirePermission(signedIn, 'settings.manage');
  await withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const policy = await findPolicy(deps, policyId, transaction);
    if (policy.isDefault) throw new ConflictError('The default policy cannot be deleted.');
    await policy.destroy({ transaction });
    await audit(
      deps,
      signedIn,
      'sla_policy.deleted',
      { id: policy.id, label: policy.name },
      {},
      transaction,
    );
  });
}

/** Puts the policies with conditions in this order (each id once); the default stays last. */
export async function reorderPolicies(
  deps: Deps,
  signedIn: SignedIn,
  policyIds: string[],
): Promise<SlaPolicyView[]> {
  requirePermission(signedIn, 'settings.manage');
  const { SlaPolicy } = slaModels(deps.db.writer);
  return withWorkspace(deps.db.writer, signedIn.workspace.id, async (transaction) => {
    const extra = await SlaPolicy.findAll({
      where: { isDefault: false },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const ids = new Set(extra.map((policy) => policy.id));
    if (
      policyIds.length !== ids.size ||
      new Set(policyIds).size !== ids.size ||
      policyIds.some((id) => !ids.has(id))
    ) {
      throw new ConflictError('The policies changed meanwhile. Reload the page and try again.');
    }
    for (const [index, id] of policyIds.entries()) {
      const policy = extra.find((item) => item.id === id);
      if (policy && policy.position !== index + 1) {
        await policy.update({ position: index + 1 }, { transaction });
      }
    }
    await audit(
      deps,
      signedIn,
      'sla_policies.reordered',
      { id: null, label: 'SLA policies' },
      {},
      transaction,
    );
    const { extra: ordered, fallback } = await allPolicies(
      deps,
      signedIn.workspace.id,
      transaction,
    );
    return [...ordered, fallback].map(viewOf);
  });
}
