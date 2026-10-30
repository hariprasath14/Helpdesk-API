import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** One weekday's working hours, "HH:MM" in the workspace's time zone ("24:00" ends at midnight). */
export interface DayHours {
  open: boolean;
  start: string;
  end: string;
}

function defineModels(sequelize: Sequelize) {
  /** Tenant table: the workspace's working hours (F22), one row; none means the default. */
  class BusinessHours extends Model<
    InferAttributes<BusinessHours>,
    InferCreationAttributes<BusinessHours>
  > {
    declare workspaceId: string;
    declare alwaysOpen: boolean;
    /** Monday first, seven days. */
    declare days: DayHours[];
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  BusinessHours.init(
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true },
      alwaysOpen: { type: DataTypes.BOOLEAN, allowNull: false },
      days: { type: DataTypes.JSONB, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'business_hours', underscored: true },
  );

  /** Tenant table: a day off (F22). */
  class Holiday extends Model<InferAttributes<Holiday>, InferCreationAttributes<Holiday>> {
    declare id: string;
    declare workspaceId: string;
    /** "2026-12-25". */
    declare date: string;
    declare name: string;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  Holiday.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'holidays', underscored: true },
  );

  return { BusinessHours, Holiday };
}

export type BusinessHoursModels = ReturnType<typeof defineModels>;

const cache = new WeakMap<Sequelize, BusinessHoursModels>();

/** The business hours models bound to one connection (db.writer or db.reader), created once. */
export function businessHoursModels(sequelize: Sequelize): BusinessHoursModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
