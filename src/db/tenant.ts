import type { Sequelize, Transaction } from 'sequelize';
import { ValidationError } from '../lib/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `work` in a transaction scoped to one workspace. Row-level security policies read
 * `app.workspace_id`, so every query inside sees and changes only that workspace's rows, even if
 * a `WHERE workspace_id = ...` is forgotten. The setting ends with the transaction.
 *
 * Use `db.writer` for anything that writes or must read its own writes; `db.reader` for read-only
 * lists and search.
 */
export async function withWorkspace<T>(
  sequelize: Sequelize,
  workspaceId: string,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(workspaceId)) {
    throw new ValidationError('Invalid workspace.');
  }
  return sequelize.transaction(async (transaction) => {
    // set_config(..., true) is SET LOCAL with a bound parameter (SET LOCAL itself cannot take one).
    await sequelize.query("SELECT set_config('app.workspace_id', :workspaceId, true)", {
      replacements: { workspaceId },
      transaction,
    });
    return work(transaction);
  });
}
