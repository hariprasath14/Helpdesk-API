import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export const RECORD_TYPES = ['ticket', 'contact', 'company'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const FIELD_TYPES = [
  'text',
  'paragraph',
  'integer',
  'decimal',
  'date',
  'dropdown',
  'multi_select',
  'checkbox',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** "When resolving" applies to ticket fields only. */
export const REQUIRED_RULES = ['never', 'always', 'on_resolve'] as const;
export type RequiredRule = (typeof REQUIRED_RULES)[number];

const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

function defineModels(sequelize: Sequelize) {
  /** Tenant table: row-level security by workspace_id. Query it inside withWorkspace(). */
  class CustomField extends Model<
    InferAttributes<CustomField>,
    InferCreationAttributes<CustomField>
  > {
    declare id: string;
    declare workspaceId: string;
    declare recordType: RecordType;
    declare key: string;
    declare label: string;
    declare helpText: string | null;
    declare type: FieldType;
    declare required: RequiredRule;
    declare defaultValue: unknown;
    declare position: number;
    declare archivedAt: Date | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  CustomField.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      recordType: { type: DataTypes.TEXT, allowNull: false },
      key: { type: DataTypes.TEXT, allowNull: false },
      label: { type: DataTypes.TEXT, allowNull: false },
      helpText: { type: DataTypes.TEXT, allowNull: true },
      type: { type: DataTypes.TEXT, allowNull: false },
      required: { type: DataTypes.TEXT, allowNull: false },
      defaultValue: { type: DataTypes.JSONB, allowNull: true },
      position: { type: DataTypes.INTEGER, allowNull: false },
      archivedAt: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    },
    { sequelize, tableName: 'custom_fields', underscored: true },
  );

  /** Tenant table: dropdown and multi-select choices. */
  class CustomFieldChoice extends Model<
    InferAttributes<CustomFieldChoice>,
    InferCreationAttributes<CustomFieldChoice>
  > {
    declare id: string;
    declare workspaceId: string;
    declare fieldId: string;
    declare label: string;
    declare position: number;
    declare removedAt: Date | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  CustomFieldChoice.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      fieldId: { type: DataTypes.UUID, allowNull: false },
      label: { type: DataTypes.TEXT, allowNull: false },
      position: { type: DataTypes.INTEGER, allowNull: false },
      removedAt: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    },
    { sequelize, tableName: 'custom_field_choices', underscored: true },
  );

  return { CustomField, CustomFieldChoice };
}

export type CustomFieldModels = ReturnType<typeof defineModels>;
export type CustomFieldRecord = InstanceType<CustomFieldModels['CustomField']>;

const cache = new WeakMap<Sequelize, CustomFieldModels>();

/** The custom field models bound to one connection (db.writer or db.reader), created once. */
export function customFieldModels(sequelize: Sequelize): CustomFieldModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
