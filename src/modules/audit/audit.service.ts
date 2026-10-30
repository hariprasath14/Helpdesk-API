import { Op, type Transaction, type WhereOptions } from 'sequelize';
import type { Database } from '../../db/index.js';
import { withWorkspace } from '../../db/tenant.js';
import { ValidationError } from '../../lib/errors.js';
import { newId } from '../../lib/tokens.js';
import { accountModels, type Role } from '../accounts/models.js';
import { requirePermission } from '../accounts/permissions.js';
import type { SignedIn } from '../accounts/request-context.js';
import { describeAuditEvent, deviceSummary } from './describe.js';
import {
  AUDIT_ACTIONS,
  auditModels,
  type ActorType,
  type AuditAction,
  type AuditCategory,
  type AuditEventRecord,
} from './models.js';
import { PRODUCT_NAME } from '../../product.js';

export interface AuditActor {
  type: ActorType;
  userId?: string | null;
  name: string;
  email?: string | null;
  role?: Role | null;
}

export const memberActor = (
  user: { id: string; name: string; email: string },
  role: Role | null,
): AuditActor => ({ type: 'member', userId: user.id, name: user.name, email: user.email, role });

export const SYSTEM_ACTOR: AuditActor = { type: 'system', name: PRODUCT_NAME };

export interface AuditRecord {
  workspaceId: string;
  actor: AuditActor;
  action: AuditAction;
  target?: {
    type:
      | 'member'
      | 'invitation'
      | 'workspace'
      | 'custom_field'
      | 'contact'
      | 'company'
      | 'team'
      | 'ticket'
      | 'rule'
      | 'sla_policy';
    id?: string | null;
    label: string;
  };
  details?: Record<string, unknown>;
  meta?: { ip?: string | undefined; userAgent?: string | undefined };
}

/**
 * Records one audit entry inside the caller's transaction, so the change and its entry are saved
 * together or not at all. Row-level security needs the entry's workspace set; the previous
 * setting is put back afterwards, so the rest of the transaction is unaffected.
 */
export async function recordAudit(
  db: Database,
  record: AuditRecord,
  transaction: Transaction,
): Promise<void> {
  const { AuditEvent } = auditModels(db.writer);
  const [rows] = await db.writer.query(
    "SELECT current_setting('app.workspace_id', true) AS current",
    { transaction },
  );
  const previous = (rows as { current: string | null }[])[0]?.current ?? '';
  const setWorkspace = (id: string) =>
    db.writer.query("SELECT set_config('app.workspace_id', :id, true)", {
      replacements: { id },
      transaction,
    });

  await setWorkspace(record.workspaceId);
  await AuditEvent.create(
    {
      id: newId(),
      workspaceId: record.workspaceId,
      actorType: record.actor.type,
      actorUserId: record.actor.userId ?? null,
      actorName: record.actor.name,
      actorEmail: record.actor.email ?? null,
      actorRole: record.actor.role ?? null,
      // A fixed table keyed by the AuditAction type.
      category: AUDIT_ACTIONS[record.action],
      action: record.action,
      targetType: record.target?.type ?? null,
      targetId: record.target?.id ?? null,
      targetLabel: record.target?.label ?? null,
      details: record.details ?? {},
      ip: record.meta?.ip ?? null,
      userAgent: record.meta?.userAgent?.slice(0, 500) ?? null,
    },
    { transaction },
  );
  await setWorkspace(previous);
}

/**
 * The active workspaces a person belongs to, with their role in each: their own security events
 * (password, two-step verification) are recorded in every one, so each admin sees them. Reads
 * memberships through the own_memberships policy.
 */
export async function personWorkspaces(
  db: Database,
  userId: string,
): Promise<{ workspaceId: string; role: Role }[]> {
  const { Membership, Workspace } = accountModels(db.writer);
  const memberships = await db.writer.transaction(async (transaction) => {
    await db.writer.query("SELECT set_config('app.user_id', :id, true)", {
      replacements: { id: userId },
      transaction,
    });
    return Membership.findAll({
      attributes: ['workspaceId', 'role'],
      where: { userId, status: 'active' },
      transaction,
    });
  });
  const active = await Workspace.findAll({
    attributes: ['id'],
    where: { id: memberships.map((row) => row.workspaceId), status: 'active' },
  });
  const activeIds = new Set(active.map((row) => row.id));
  return memberships
    .filter((row) => activeIds.has(row.workspaceId))
    .map((row) => ({ workspaceId: row.workspaceId, role: row.role }));
}

/** Records a person's own security event in each of their workspaces (see personWorkspaces). */
export async function recordForPerson(
  db: Database,
  person: { id: string; name: string; email: string },
  workspaces: { workspaceId: string; role: Role }[],
  record: Omit<AuditRecord, 'workspaceId' | 'actor'>,
  transaction: Transaction,
): Promise<void> {
  for (const { workspaceId, role } of workspaces) {
    await recordAudit(
      db,
      { ...record, workspaceId, actor: memberActor(person, role) },
      transaction,
    );
  }
}

// --- Reading -------------------------------------------------------------------------------------

export interface AuditFilters {
  from?: Date | undefined;
  to?: Date | undefined;
  actorId?: string | undefined;
  category?: AuditCategory | undefined;
  q?: string | undefined;
}

export interface AuditEntryView {
  id: string;
  occurredAt: Date;
  actor: {
    type: ActorType;
    userId: string | null;
    name: string;
    email: string | null;
    role: Role | null;
  };
  category: AuditCategory;
  action: AuditAction;
  summary: string;
  target: { type: string; id: string | null; label: string } | null;
  details: Record<string, unknown>;
  ip: string | null;
  device: string;
}

function toView(event: AuditEventRecord): AuditEntryView {
  return {
    id: event.id,
    occurredAt: event.createdAt,
    actor: {
      type: event.actorType,
      userId: event.actorUserId,
      name: event.actorName,
      email: event.actorEmail,
      role: event.actorRole,
    },
    category: event.category,
    action: event.action,
    summary: describeAuditEvent(event),
    target:
      event.targetType && event.targetLabel
        ? { type: event.targetType, id: event.targetId, label: event.targetLabel }
        : null,
    details: event.details,
    ip: event.ip,
    device: deviceSummary(event.userAgent),
  };
}

/** Escapes LIKE wildcards so a search for "50%" means the text "50%". */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

function whereFor(filters: AuditFilters): WhereOptions[] {
  const where: WhereOptions[] = [];
  if (filters.from) where.push({ createdAt: { [Op.gte]: filters.from } });
  if (filters.to) where.push({ createdAt: { [Op.lt]: filters.to } });
  if (filters.actorId) where.push({ actorUserId: filters.actorId });
  if (filters.category) where.push({ category: filters.category });
  const q = filters.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    where.push({
      [Op.or]: [
        { targetLabel: { [Op.iLike]: pattern } },
        { actorName: { [Op.iLike]: pattern } },
        { actorEmail: { [Op.iLike]: pattern } },
        { 'details.email': { [Op.iLike]: pattern } },
      ],
    });
  }
  return where;
}

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (event: AuditEventRecord) =>
  Buffer.from(JSON.stringify({ at: event.createdAt.toISOString(), id: event.id })).toString(
    'base64url',
  );

function decodeCursor(cursor: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof parsed.at === 'string' &&
      typeof parsed.id === 'string' &&
      !Number.isNaN(Date.parse(parsed.at))
    ) {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ValidationError('This page link is not valid. Reload the audit log.');
}

/**
 * One page of the workspace's audit log, newest first (admins). Reads the reader: the log is a
 * read-only list. `nextCursor` asks for the following page; null at the end.
 */
export async function listAudit(
  deps: { db: Database },
  signedIn: SignedIn,
  filters: AuditFilters,
  page: { cursor?: string | undefined; limit: number },
): Promise<{ entries: AuditEntryView[]; nextCursor: string | null }> {
  requirePermission(signedIn, 'audit_log.view');
  const { AuditEvent } = auditModels(deps.db.reader);
  const where = whereFor(filters);
  if (page.cursor) {
    const cursor = decodeCursor(page.cursor);
    const at = new Date(cursor.at);
    where.push({
      [Op.or]: [{ createdAt: { [Op.lt]: at } }, { createdAt: at, id: { [Op.lt]: cursor.id } }],
    });
  }
  const rows = await withWorkspace(deps.db.reader, signedIn.workspace.id, (transaction) =>
    AuditEvent.findAll({
      where: { [Op.and]: where },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: page.limit + 1,
      transaction,
    }),
  );
  const entries = rows.slice(0, page.limit);
  const last = entries.at(-1);
  return {
    entries: entries.map(toView),
    nextCursor: rows.length > page.limit && last ? encodeCursor(last) : null,
  };
}

/** The most rows one export holds; narrow the dates for more. */
export const EXPORT_LIMIT = 10_000;

/**
 * A cell for the CSV: quoted when needed, and a leading = + - @ (or tab/return) is prefixed with
 * an apostrophe so a spreadsheet never runs it as a formula (CSV injection).
 */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** "2026-10-25 17:30:05" in the workspace's time zone. */
function localTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''} ${parts.hour ?? ''}:${parts.minute ?? ''}:${parts.second ?? ''}`;
}

const CATEGORY_NAMES: Record<AuditCategory, string> = {
  members: 'Members',
  security: 'Security',
  settings: 'Settings',
  sign_in: 'Sign-in',
  contacts: 'Contacts',
  tickets: 'Tickets',
};

/** The filtered log as CSV (up to EXPORT_LIMIT rows), times in the workspace's time zone. */
export async function exportAuditCsv(
  deps: { db: Database },
  signedIn: SignedIn,
  filters: AuditFilters,
): Promise<string> {
  const { entries } = await listAudit(deps, signedIn, filters, { limit: EXPORT_LIMIT });
  const zone = signedIn.workspace.timezone;
  const header = [
    `Time (${zone})`,
    'Time (UTC)',
    'Who',
    'Email',
    'Role',
    'Category',
    'What happened',
    'Affected',
    'IP address',
    'Device',
  ];
  const lines = entries.map((entry) =>
    [
      localTime(entry.occurredAt, zone),
      entry.occurredAt.toISOString(),
      entry.actor.name,
      entry.actor.email,
      entry.actor.role,
      CATEGORY_NAMES[entry.category],
      entry.summary,
      entry.target?.label,
      entry.ip,
      entry.device,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}
