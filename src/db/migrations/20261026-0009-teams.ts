import type { QueryInterface } from 'sequelize';
import { disableTenantIsolation, enableTenantIsolation } from '../rls.js';

// F8, teams: groups of members that tickets are routed to (F9 onward).
//
// - teams: name (unique in a workspace, ignoring case) and an optional description. sort_name
//   keeps the A to Z order index-friendly.
// - team_members: who is in each team, and who leads it (the escalation contact, F24). A person
//   can be in several teams. The foreign key to memberships (workspace_id, user_id) makes sure a
//   team member is a member of the same workspace. Deactivated members stay in their teams.
// - invitation_teams: the teams an invited person joins when they accept the invitation.
// Team changes are recorded in the audit log under "settings". All three are tenant tables with
// row-level security.

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    const run = (sql: string) => q.query(sql, { transaction });

    await run(`
      CREATE TABLE teams (
        id uuid PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
        sort_name text GENERATED ALWAYS AS (lower(name)) STORED,
        description text CHECK (char_length(description) <= 500),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await run('CREATE UNIQUE INDEX teams_workspace_name_key ON teams (workspace_id, sort_name)');
    await enableTenantIsolation(context, 'teams', transaction);

    await run(`
      CREATE TABLE team_members (
        team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL,
        user_id uuid NOT NULL,
        is_lead boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, user_id),
        FOREIGN KEY (workspace_id, user_id) REFERENCES memberships (workspace_id, user_id)
          ON DELETE CASCADE
      )`);
    // A member's teams (members page, round-robin later).
    await run(
      'CREATE INDEX team_members_workspace_user_idx ON team_members (workspace_id, user_id)',
    );
    await enableTenantIsolation(context, 'team_members', transaction);

    await run(`
      CREATE TABLE invitation_teams (
        invitation_id uuid NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
        team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
        workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        PRIMARY KEY (invitation_id, team_id)
      )`);
    await run('CREATE INDEX invitation_teams_team_idx ON invitation_teams (team_id)');
    await run(
      'CREATE INDEX invitation_teams_workspace_idx ON invitation_teams (workspace_id, invitation_id)',
    );
    await enableTenantIsolation(context, 'invitation_teams', transaction);
  });
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.transaction(async (transaction) => {
    await q.query("DELETE FROM audit_events WHERE action LIKE 'team.%'", { transaction });
    for (const table of ['invitation_teams', 'team_members', 'teams']) {
      await disableTenantIsolation(context, table, transaction);
      await q.query(`DROP TABLE IF EXISTS ${table}`, { transaction });
    }
  });
}
