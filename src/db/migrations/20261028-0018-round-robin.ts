import type { QueryInterface } from 'sequelize';

// F18, assigning in turn (round-robin): teams.round_robin_last_user_id is the member who got the
// team's last ticket from a rule's "assign in turn" action, so the next one goes to the member
// after them. When that person leaves the team the turn simply starts again from the first.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query('ALTER TABLE teams ADD COLUMN round_robin_last_user_id uuid');
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  await context.sequelize.query('ALTER TABLE teams DROP COLUMN IF EXISTS round_robin_last_user_id');
}
