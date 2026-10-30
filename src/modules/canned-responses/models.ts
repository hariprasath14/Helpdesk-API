import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

function defineModels(sequelize: Sequelize) {
  /** Tenant table: a saved reply (F21). No owner means shared with the whole workspace. */
  class CannedResponse extends Model<
    InferAttributes<CannedResponse>,
    InferCreationAttributes<CannedResponse>
  > {
    declare id: string;
    declare workspaceId: string;
    declare ownerUserId: string | null;
    declare title: string;
    declare body: string;
    declare createdByUserId: string | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  CannedResponse.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ownerUserId: { type: DataTypes.UUID, allowNull: true },
      title: { type: DataTypes.TEXT, allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'canned_responses', underscored: true },
  );
  return { CannedResponse };
}

export type CannedResponseModels = ReturnType<typeof defineModels>;
export type CannedResponseRecord = InstanceType<CannedResponseModels['CannedResponse']>;

const cache = new WeakMap<Sequelize, CannedResponseModels>();

/** The canned response models bound to one connection (db.writer or db.reader), created once. */
export function cannedResponseModels(sequelize: Sequelize): CannedResponseModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
