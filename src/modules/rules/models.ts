import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { RuleAction } from './actions.js';
import type { RuleConditions } from './conditions.js';

/** What starts a rule: a ticket created (F17), changed or answered by the customer (F19), time (F20). */
export const RULE_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'customer_replied',
  'time',
] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

function defineModels(sequelize: Sequelize) {
  /** Tenant table. Query it inside withWorkspace(). */
  class AutomationRule extends Model<
    InferAttributes<AutomationRule>,
    InferCreationAttributes<AutomationRule>
  > {
    declare id: string;
    declare workspaceId: string;
    declare name: string;
    declare event: RuleEvent;
    declare enabled: boolean;
    declare position: number;
    declare conditions: RuleConditions;
    declare actions: RuleAction[];
    declare stopAfter: boolean;
    declare createdByUserId: string | null;
    declare updatedByUserId: string | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  AutomationRule.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      event: { type: DataTypes.TEXT, allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false },
      conditions: { type: DataTypes.JSONB, allowNull: false },
      actions: { type: DataTypes.JSONB, allowNull: false },
      stopAfter: { type: DataTypes.BOOLEAN, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true },
      updatedByUserId: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'automation_rules', underscored: true },
  );
  return { AutomationRule };
}

export type RuleModels = ReturnType<typeof defineModels>;
export type RuleRecord = InstanceType<RuleModels['AutomationRule']>;

const cache = new WeakMap<Sequelize, RuleModels>();

/** The rule models bound to one connection (db.writer or db.reader), created once. */
export function ruleModels(sequelize: Sequelize): RuleModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
