import type { Sequelize, Transaction } from 'sequelize';

/** The PostgreSQL channel that carries change signals to the API's live connections (F26). */
export const LIVE_CHANNEL = 'helpdesk_live';

/**
 * A short signal that something changed, never the data itself: the browser reloads what it shows
 * through the REST API, so permissions and workspace separation stay in one place.
 */
export type LiveSignal =
  /** A ticket, its conversation or its history changed; `created` for a new ticket. */
  | { type: 'ticket'; workspaceId: string; ticketId: string; created?: boolean }
  /** A member got a notification (F25). */
  | { type: 'notification'; workspaceId: string; userId: string }
  /** Sessions ended: one (sign-out), or all of a person's but one (password change). */
  | { type: 'session-ended'; tokenHash: string }
  | { type: 'sessions-ended'; userId: string; keepSessionId?: string | undefined }
  /** A member was deactivated in a workspace. */
  | { type: 'member-removed'; workspaceId: string; userId: string };

/**
 * Sends a signal with NOTIFY. Inside a transaction PostgreSQL delivers it only when the
 * transaction commits, so nobody is told about a change that was rolled back; identical signals
 * in one transaction arrive once. Works from the API and the worker alike.
 */
export async function sendSignal(
  sequelize: Sequelize,
  signal: LiveSignal,
  transaction?: Transaction | null,
): Promise<void> {
  await sequelize.query('SELECT pg_notify(:channel, :payload)', {
    replacements: { channel: LIVE_CHANNEL, payload: JSON.stringify(signal) },
    ...(transaction ? { transaction } : {}),
  });
}
