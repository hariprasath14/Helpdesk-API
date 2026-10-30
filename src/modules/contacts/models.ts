import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { CustomFieldValues } from '../custom-fields/values.js';

const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

// sort_name (lower(name)) is a generated column: it is never written, so it is not an attribute.
// Queries order and page by it with col('sort_name').

function defineModels(sequelize: Sequelize) {
  /** Tenant table. Query it inside withWorkspace(). */
  class Company extends Model<InferAttributes<Company>, InferCreationAttributes<Company>> {
    declare id: string;
    declare workspaceId: string;
    declare name: string;
    declare phone: string | null;
    declare website: string | null;
    declare note: string | null;
    declare customFields: CustomFieldValues;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
    declare domains?: NonAttribute<CompanyDomain[]>;
  }
  Company.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      phone: { type: DataTypes.TEXT, allowNull: true },
      website: { type: DataTypes.TEXT, allowNull: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      customFields: { type: DataTypes.JSONB, allowNull: false },
      ...timestamps,
    },
    { sequelize, tableName: 'companies', underscored: true },
  );

  /** Tenant table: a company's email domains, in lowercase, one company per domain. */
  class CompanyDomain extends Model<
    InferAttributes<CompanyDomain>,
    InferCreationAttributes<CompanyDomain>
  > {
    declare id: string;
    declare workspaceId: string;
    declare companyId: string;
    declare domain: string;
  }
  CompanyDomain.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      companyId: { type: DataTypes.UUID, allowNull: false },
      domain: { type: DataTypes.TEXT, allowNull: false },
    },
    { sequelize, tableName: 'company_domains', underscored: true, timestamps: false },
  );

  /** Tenant table. `email` is the primary email; contact_emails holds it too. */
  class Contact extends Model<InferAttributes<Contact>, InferCreationAttributes<Contact>> {
    declare id: string;
    declare workspaceId: string;
    declare name: string;
    declare email: string | null;
    declare phone: string | null;
    declare jobTitle: string | null;
    declare companyId: string | null;
    declare note: string | null;
    declare customFields: CustomFieldValues;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
    declare company?: NonAttribute<Company | null>;
    declare emails?: NonAttribute<ContactEmail[]>;
  }
  Contact.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      email: { type: DataTypes.TEXT, allowNull: true },
      phone: { type: DataTypes.TEXT, allowNull: true },
      jobTitle: { type: DataTypes.TEXT, allowNull: true },
      companyId: { type: DataTypes.UUID, allowNull: true },
      note: { type: DataTypes.TEXT, allowNull: true },
      customFields: { type: DataTypes.JSONB, allowNull: false },
      ...timestamps,
    },
    { sequelize, tableName: 'contacts', underscored: true },
  );

  /** Tenant table: every email of every contact (primary included), in lowercase. */
  class ContactEmail extends Model<
    InferAttributes<ContactEmail>,
    InferCreationAttributes<ContactEmail>
  > {
    declare id: string;
    declare workspaceId: string;
    declare contactId: string;
    declare email: string;
    declare isPrimary: boolean;
  }
  ContactEmail.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      contactId: { type: DataTypes.UUID, allowNull: false },
      email: { type: DataTypes.TEXT, allowNull: false },
      isPrimary: { type: DataTypes.BOOLEAN, allowNull: false },
    },
    { sequelize, tableName: 'contact_emails', underscored: true, timestamps: false },
  );

  Company.hasMany(CompanyDomain, { foreignKey: 'companyId', as: 'domains' });
  Contact.belongsTo(Company, { foreignKey: 'companyId', as: 'company' });
  Contact.hasMany(ContactEmail, { foreignKey: 'contactId', as: 'emails' });

  return { Company, CompanyDomain, Contact, ContactEmail };
}

export type ContactModels = ReturnType<typeof defineModels>;
export type CompanyRecord = InstanceType<ContactModels['Company']>;
export type ContactRecord = InstanceType<ContactModels['Contact']>;

const cache = new WeakMap<Sequelize, ContactModels>();

/** The contact and company models bound to one connection (db.writer or db.reader), created once. */
export function contactModels(sequelize: Sequelize): ContactModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
