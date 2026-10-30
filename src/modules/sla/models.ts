import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { RuleConditions } from '../rules/conditions.js';
import type { Escalation, SlaTargets } from './clock.js';

function defineModels(sequelize: Sequelize) {
  /** Tenant table: an SLA policy (F23). One default per workspace; others match by conditions. */
  class SlaPolicy extends Model<InferAttributes<SlaPolicy>, InferCreationAttributes<SlaPolicy>> {
    declare id: string;
    declare workspaceId: string;
    declare name: string;
    declare isDefault: boolean;
    declare position: number;
    declare conditions: RuleConditions;
    declare targets: SlaTargets;
    declare escalation: CreationOptional<Escalation>;
    declare createdByUserId: string | null;
    declare updatedByUserId: string | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  SlaPolicy.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false },
      conditions: { type: DataTypes.JSONB, allowNull: false },
      targets: { type: DataTypes.JSONB, allowNull: false },
      escalation: { type: DataTypes.JSONB, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true },
      updatedByUserId: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'sla_policies', underscored: true },
  );
  return { SlaPolicy };
}

export type SlaModels = ReturnType<typeof defineModels>;
export type SlaPolicyRecord = InstanceType<SlaModels['SlaPolicy']>;

const cache = new WeakMap<Sequelize, SlaModels>();

/** The SLA models bound to one connection (db.writer or db.reader), created once. */
export function slaModels(sequelize: Sequelize): SlaModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
