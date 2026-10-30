import { literal, Op, type OrderItem, type Sequelize, type WhereOptions } from 'sequelize';
import { ValidationError } from '../../lib/errors.js';
import { likePattern } from '../contacts/paging.js';
import type { TicketPriority, TicketStatus, TicketType } from './models.js';

/**
 * The list's orders: last update, newest, oldest, highest priority (then last update), and the
 * SLA deadline due soonest (F23; tickets without a running one last).
 */
export const TICKET_SORTS = ['updated', 'created', 'oldest', 'priority', 'due'] as const;
export type TicketSort = (typeof TICKET_SORTS)[number];

/** Statuses that count as not done yet ("unresolved"). */
/** Tickets matched by words in their text, at most (the list shows the newest first). */
const MAX_TEXT_MATCHES = 5000;

export const UNRESOLVED: readonly TicketStatus[] = ['open', 'pending', 'waiting_on_customer'];

/**
 * What a ticket list can be narrowed by. Lists hold alternatives ("any of"); `none` means "not
 * set" for type, team and assignee, and `me` is the signed-in person for assignee.
 */
export interface TicketFilters {
  status?: TicketStatus[] | undefined;
  priority?: TicketPriority[] | undefined;
  type?: (TicketType | 'none')[] | undefined;
  teamId?: string[] | undefined;
  assignee?: string[] | undefined;
  tag?: string[] | undefined;
  contactId?: string | undefined;
  companyId?: string | undefined;
  q?: string | undefined;
  /** Only tickets past an SLA deadline that is still running (F23). */
  overdue?: boolean | undefined;
  /** The trash instead of the normal list (admins). */
  deleted?: boolean | undefined;
}

interface SortSpec {
  /** Columns of the order, all in one direction, the id last. */
  columns: string[];
  direction: 'ASC' | 'DESC';
}

const SORTS: Record<TicketSort, SortSpec> = {
  updated: { columns: ['updated_at', 'id'], direction: 'DESC' },
  created: { columns: ['created_at', 'id'], direction: 'DESC' },
  oldest: { columns: ['created_at', 'id'], direction: 'ASC' },
  priority: { columns: ['priority_rank', 'updated_at', 'id'], direction: 'DESC' },
  due: { columns: ['sla_due_rank', 'id'], direction: 'ASC' },
};

// eslint-disable-next-line security/detect-object-injection -- a fixed table keyed by TicketSort
const specOf = (sort: TicketSort) => SORTS[sort];

/** The Sequelize order for a sort. */
export function orderFor(sort: TicketSort): OrderItem[] {
  const { columns, direction } = specOf(sort);
  return columns.map((column): OrderItem => [literal(`"Ticket"."${column}"`), direction]);
}

/** The extra attributes a page needs to make its cursor (generated columns are not attributes). */
export function cursorAttributes(sort: TicketSort): [ReturnType<typeof literal>, string][] {
  if (sort === 'priority') return [[literal('"Ticket"."priority_rank"'), 'priorityRank']];
  if (sort === 'due') return [[literal('"Ticket"."sla_due_rank"'), 'slaDueRank']];
  return [];
}

interface Cursor {
  sort: TicketSort;
  values: (string | number)[];
}

/** The cursor after this row: its sort values, in order. */
export function encodeCursor(
  sort: TicketSort,
  row: { id: string; createdAt: Date; updatedAt: Date; get: (key: string) => unknown },
): string {
  const values = specOf(sort).columns.map((column): string | number => {
    if (column === 'id') return row.id;
    if (column === 'created_at') return row.createdAt.toISOString();
    if (column === 'updated_at') return row.updatedAt.toISOString();
    if (column === 'sla_due_rank') return new Date(row.get('slaDueRank') as Date).toISOString();
    return Number(row.get('priorityRank'));
  });
  return Buffer.from(JSON.stringify({ sort, values } satisfies Cursor)).toString('base64url');
}

function decodeCursor(text: string, sort: TicketSort): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
    const columns = specOf(sort).columns;
    if (
      parsed.sort === sort &&
      Array.isArray(parsed.values) &&
      parsed.values.length === columns.length &&
      parsed.values.every((value, index) =>
        // eslint-disable-next-line security/detect-object-injection -- index into a fixed list
        columns[index] === 'priority_rank'
          ? Number.isInteger(value)
          : typeof value === 'string' &&
            // eslint-disable-next-line security/detect-object-injection -- index into a fixed list
            (columns[index] === 'id' || !Number.isNaN(Date.parse(value))),
      )
    ) {
      return { sort, values: parsed.values };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ValidationError('This page link is not valid. Reload the list.');
}

/** "After the cursor" for the sort: a row comparison, since every column goes one way. */
export function afterCursor(sequelize: Sequelize, sort: TicketSort, cursor: string) {
  const { columns, direction } = specOf(sort);
  const { values } = decodeCursor(cursor, sort);
  const left = columns.map((column) => `"Ticket"."${column}"`).join(', ');
  const right = values.map((value) => sequelize.escape(value)).join(', ');
  return literal(`(${left}) ${direction === 'DESC' ? '<' : '>'} (${right})`);
}

/** The where conditions for the filters, for the signed-in person `me`. */
export function filterConditions(
  sequelize: Sequelize,
  filters: TicketFilters,
  me: string,
): WhereOptions[] {
  const conditions: WhereOptions[] = [{ deletedAt: filters.deleted ? { [Op.ne]: null } : null }];
  const withNone = (values: string[] | undefined, column: string) => {
    if (!values || values.length === 0) return;
    const set = values.filter((value) => value !== 'none');
    const options: WhereOptions[] = [];
    if (set.length > 0) options.push({ [column]: set });
    if (values.includes('none')) options.push({ [column]: null });
    conditions.push({ [Op.or]: options });
  };
  if (filters.status?.length) conditions.push({ status: filters.status });
  if (filters.priority?.length) conditions.push({ priority: filters.priority });
  withNone(filters.type, 'type');
  withNone(filters.teamId, 'teamId');
  withNone(
    filters.assignee?.map((value) => (value === 'me' ? me : value)),
    'assigneeUserId',
  );
  // sla_due_rank is the running deadline, or far in the future without one (its index).
  if (filters.overdue) conditions.push(literal('"Ticket"."sla_due_rank" < now()'));
  if (filters.contactId) conditions.push({ contactId: filters.contactId });
  if (filters.companyId) conditions.push({ companyId: filters.companyId });
  if (filters.tag?.length) {
    const tags = filters.tag.map((tag) => sequelize.escape(tag.trim().toLowerCase())).join(', ');
    conditions.push(
      literal(`"Ticket"."id" IN (SELECT ticket_id FROM ticket_tags WHERE tag IN (${tags}))`),
    );
  }
  const q = filters.q?.trim();
  if (q) {
    // Subject, requester name and any of their emails, an exact tag, the ticket number ("#42"),
    // or words in the subject, description or any message (F14, through search_ticket_ids()).
    const pattern = sequelize.escape(likePattern(q));
    const options: WhereOptions[] = [
      { subject: { [Op.iLike]: likePattern(q) } },
      literal(
        `"Ticket"."contact_id" IN (SELECT id FROM contacts WHERE name ILIKE ${pattern}
           UNION SELECT contact_id FROM contact_emails WHERE email ILIKE ${pattern})`,
      ),
      literal(
        `"Ticket"."id" IN (SELECT ticket_id FROM ticket_tags WHERE tag = ${sequelize.escape(q.toLowerCase())})`,
      ),
    ];
    const number = /^#?(\d{1,9})$/.exec(q)?.[1];
    if (number) options.push({ number: Number(number) });
    // The function splits the words itself, with the same parser as its indexes.
    if (/[\p{L}\p{N}]/u.test(q)) {
      options.push(
        literal(
          `"Ticket"."id" IN (SELECT search_ticket_ids(${sequelize.escape(q)}, ${String(MAX_TEXT_MATCHES)}))`,
        ),
      );
    }
    conditions.push({ [Op.or]: options });
  }
  return conditions;
}
