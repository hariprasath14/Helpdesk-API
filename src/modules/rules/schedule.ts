import { Op, QueryTypes, type Transaction } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import type { JobQueue } from '../../jobs/queue.js';
import { ticketModels, type TicketRecord } from '../tickets/models.js';
import { evaluate } from './conditions.js';
import { applyRule, factsOf, rulesFor } from './engine.js';
import type { RuleRecord } from './models.js';

interface Deps {
  db: Database;
  jobs: Pick<JobQueue, 'enqueue'>;
}

/** Tickets one workspace's scheduled rules look at per run, longest in their status first. */
export const MAX_TICKETS_PER_RUN = 1000;

/**
 * Records that a rule ran for a ticket in its current stay in a status; false when it already had
 * (also when another worker just did it).
 */
async function firstRun(
  deps: Deps,
  rule: RuleRecord,
  ticket: TicketRecord,
  transaction: Transaction,
): Promise<boolean> {
  const rows = await deps.db.writer.query(
    `INSERT INTO automation_rule_runs (rule_id, ticket_id, workspace_id, anchor)
     VALUES (:ruleId, :ticketId, :workspaceId, :anchor)
     ON CONFLICT DO NOTHING
     RETURNING rule_id`,
    {
      replacements: {
        ruleId: rule.id,
        ticketId: ticket.id,
        workspaceId: ticket.workspaceId,
        anchor: ticket.statusChangedAt,
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return rows.length > 0;
}

/** One ticket against the workspace's scheduled rules, in its own transaction. */
async function runForTicket(
  deps: Deps,
  workspaceId: string,
  ticketId: string,
  rules: RuleRecord[],
  now: Date,
): Promise<number> {
  return withWorkspace(deps.db.writer, workspaceId, async (transaction) => {
    const ticket = await ticketModels(deps.db.writer).Ticket.findByPk(ticketId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!ticket || ticket.deletedAt || ticket.status === 'closed') return 0;
    let applied = 0;
    for (const rule of rules) {
      const facts = await factsOf(deps, ticket, transaction, { now });
      if (!evaluate(rule.conditions, facts).matched) continue;
      if (!(await firstRun(deps, rule, ticket, transaction))) continue;
      await applyRule(deps, rule, ticket, facts.tags, transaction);
      applied += 1;
      if (rule.stopAfter) break;
    }
    return applied;
  });
}

/**
 * The scheduled run (the worker's time-rules job, every 15 minutes, F20). For each workspace with
 * scheduled rules turned on, it checks the tickets that are not closed or deleted against those
 * rules, in order. A rule runs at most once for a ticket while it stays in the same status, so
 * "3 days waiting: send a reminder" sends one reminder, not one every 15 minutes; when the ticket
 * comes back to that status later, it can run again. Changes made here start no other rules.
 * Returns how many times a rule was applied.
 */
export async function runTimeRules(deps: Deps, now: Date = new Date()): Promise<number> {
  const workspaces = await deps.db.writer.query<{ id: string }>(
    'SELECT workspaces_with_time_rules AS id FROM workspaces_with_time_rules()',
    { type: QueryTypes.SELECT },
  );
  let applied = 0;
  for (const { id: workspaceId } of workspaces) {
    const { rules, tickets } = await withWorkspace(
      deps.db.writer,
      workspaceId,
      async (transaction) => ({
        rules: await rulesFor(deps, 'time', transaction),
        tickets: await ticketModels(deps.db.writer).Ticket.findAll({
          attributes: ['id'],
          where: { deletedAt: null, status: { [Op.ne]: 'closed' } },
          order: [['statusChangedAt', 'ASC']],
          limit: MAX_TICKETS_PER_RUN,
          transaction,
        }),
      }),
    );
    for (const ticket of tickets) {
      applied += await runForTicket(deps, workspaceId, ticket.id, rules, now);
    }
  }
  return applied;
}
