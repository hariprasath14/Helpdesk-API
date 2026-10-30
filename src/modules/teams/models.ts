import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

// sort_name (lower(name)) is a generated column: it is never written, so it is not an attribute.

function defineModels(sequelize: Sequelize) {
  /** Tenant table. Query it inside withWorkspace(). */
  class Team extends Model<InferAttributes<Team>, InferCreationAttributes<Team>> {
    declare id: string;
    declare workspaceId: string;
    declare name: string;
    declare description: string | null;
    /** Who got the team's last ticket assigned in turn (F18). */
    declare roundRobinLastUserId: CreationOptional<string | null>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
    declare members?: NonAttribute<TeamMember[]>;
  }
  Team.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      roundRobinLastUserId: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'teams', underscored: true },
  );

  /** Tenant table: one member of one team, and whether they lead it. */
  class TeamMember extends Model<InferAttributes<TeamMember>, InferCreationAttributes<TeamMember>> {
    declare teamId: string;
    declare workspaceId: string;
    declare userId: string;
    declare isLead: boolean;
    declare createdAt: CreationOptional<Date>;
  }
  TeamMember.init(
    {
      teamId: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      userId: { type: DataTypes.UUID, primaryKey: true },
      isLead: { type: DataTypes.BOOLEAN, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'team_members', underscored: true, updatedAt: false },
  );

  /** Tenant table: a team an invited person joins when they accept. */
  class InvitationTeam extends Model<
    InferAttributes<InvitationTeam>,
    InferCreationAttributes<InvitationTeam>
  > {
    declare invitationId: string;
    declare teamId: string;
    declare workspaceId: string;
  }
  InvitationTeam.init(
    {
      invitationId: { type: DataTypes.UUID, primaryKey: true },
      teamId: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
    },
    { sequelize, tableName: 'invitation_teams', underscored: true, timestamps: false },
  );

  Team.hasMany(TeamMember, { foreignKey: 'teamId', as: 'members' });

  return { Team, TeamMember, InvitationTeam };
}

export type TeamModels = ReturnType<typeof defineModels>;
export type TeamRecord = InstanceType<TeamModels['Team']>;

const cache = new WeakMap<Sequelize, TeamModels>();

/** The team models bound to one connection (db.writer or db.reader), created once. */
export function teamModels(sequelize: Sequelize): TeamModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
