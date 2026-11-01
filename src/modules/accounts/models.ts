import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

/** Roles in a workspace. */
export type Role = 'admin' | 'supervisor' | 'agent';
export const ROLES: readonly Role[] = ['admin', 'supervisor', 'agent'];
export type MembershipStatus = 'active' | 'deactivated';

const timestamps = {
  createdAt: { type: DataTypes.DATE, allowNull: false },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
};

/** Settings → Web form: the public "Contact support" page (F16). */
export interface WebFormSettings {
  enabled: boolean;
  title: string;
  intro: string;
}

/** Settings → Email: which customer notification emails are on (F15). */
export interface CustomerNotificationSettings {
  received: boolean;
  resolved: boolean;
  agentCreated: boolean;
}

/** The colour themes a person can choose (the web app's brand packs). */
export const THEMES = ['forest', 'indigo'] as const;
export type Theme = (typeof THEMES)[number];

function defineModels(sequelize: Sequelize) {
  class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
    declare id: string;
    declare email: string;
    declare name: string;
    declare passwordHash: string;
    declare emailVerifiedAt: Date | null;
    /** The colour theme this person chose (Step 5b); null keeps the deployment's brand. */
    declare theme: CreationOptional<Theme | null>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  User.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      email: { type: DataTypes.CITEXT, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      passwordHash: { type: DataTypes.TEXT, allowNull: false },
      emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
      theme: { type: DataTypes.TEXT, allowNull: true },
      ...timestamps,
    },
    { sequelize, tableName: 'users', underscored: true },
  );

  class Workspace extends Model<InferAttributes<Workspace>, InferCreationAttributes<Workspace>> {
    declare id: string;
    declare name: string;
    declare subdomain: string;
    declare timezone: string;
    declare status: 'pending' | 'active';
    declare trialStartedAt: Date | null;
    declare requireTwoFactor: CreationOptional<boolean>;
    /** The name customers see on ticket email (F13); null means the workspace name. */
    declare emailSenderName: CreationOptional<string | null>;
    /** Which emails customers get about their tickets (F15). */
    declare customerNotifications: CreationOptional<CustomerNotificationSettings>;
    /** The public "Contact support" page (F16). */
    declare webForm: CreationOptional<WebFormSettings>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  Workspace.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      name: { type: DataTypes.TEXT, allowNull: false },
      subdomain: { type: DataTypes.TEXT, allowNull: false },
      timezone: { type: DataTypes.TEXT, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false },
      trialStartedAt: { type: DataTypes.DATE, allowNull: true },
      requireTwoFactor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      emailSenderName: { type: DataTypes.TEXT, allowNull: true },
      customerNotifications: {
        type: DataTypes.JSONB,
        allowNull: false,
        // The same as the column's default (customer-notifications migration).
        defaultValue: { received: true, resolved: true, agentCreated: false },
      },
      webForm: {
        type: DataTypes.JSONB,
        allowNull: false,
        // The same as the column's default (web-form migration).
        defaultValue: { enabled: false, title: 'Contact support', intro: '' },
      },
      ...timestamps,
    },
    { sequelize, tableName: 'workspaces', underscored: true },
  );

  /** Tenant table: row-level security by workspace_id. Query it inside withWorkspace(). */
  class Membership extends Model<InferAttributes<Membership>, InferCreationAttributes<Membership>> {
    declare id: string;
    declare workspaceId: string;
    declare userId: string;
    declare role: Role;
    declare isOwner: boolean;
    declare status: CreationOptional<MembershipStatus>;
    declare deactivatedAt: CreationOptional<Date | null>;
    declare invitedBy: CreationOptional<string | null>;
    /** Which notification kinds also come by email (F25), by kind; missing kinds use defaults. */
    declare notificationEmail: CreationOptional<Record<string, boolean>>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  Membership.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      role: { type: DataTypes.TEXT, allowNull: false },
      isOwner: { type: DataTypes.BOOLEAN, allowNull: false },
      status: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'active' },
      deactivatedAt: { type: DataTypes.DATE, allowNull: true },
      invitedBy: { type: DataTypes.UUID, allowNull: true },
      // The defaults live with the notifications (DEFAULT_EMAIL); an empty choice uses them.
      notificationEmail: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      ...timestamps,
    },
    { sequelize, tableName: 'memberships', underscored: true },
  );

  class EmailVerification extends Model<
    InferAttributes<EmailVerification>,
    InferCreationAttributes<EmailVerification>
  > {
    declare id: string;
    declare userId: string;
    declare workspaceId: string;
    declare tokenHash: string;
    declare expiresAt: Date;
    declare usedAt: Date | null;
    declare createdAt: CreationOptional<Date>;
  }
  EmailVerification.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'email_verifications', underscored: true, updatedAt: false },
  );

  class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
    declare id: string;
    declare tokenHash: string;
    declare userId: string;
    declare workspaceId: string;
    declare ip: string | null;
    declare userAgent: string | null;
    declare expiresAt: Date;
    declare lastSeenAt: CreationOptional<Date>;
    declare reauthenticatedAt: CreationOptional<Date | null>;
    declare createdAt: CreationOptional<Date>;
  }
  Session.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ip: { type: DataTypes.TEXT, allowNull: true },
      userAgent: { type: DataTypes.TEXT, allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      lastSeenAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      reauthenticatedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'sessions', underscored: true, updatedAt: false },
  );

  class PasswordHistory extends Model<
    InferAttributes<PasswordHistory>,
    InferCreationAttributes<PasswordHistory>
  > {
    declare id: string;
    declare userId: string;
    declare passwordHash: string;
    declare createdAt: CreationOptional<Date>;
  }
  PasswordHistory.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      passwordHash: { type: DataTypes.TEXT, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'password_history', underscored: true, updatedAt: false },
  );

  class PasswordReset extends Model<
    InferAttributes<PasswordReset>,
    InferCreationAttributes<PasswordReset>
  > {
    declare id: string;
    declare userId: string;
    declare workspaceId: string;
    declare tokenHash: string;
    declare expiresAt: Date;
    declare usedAt: Date | null;
    declare createdAt: CreationOptional<Date>;
  }
  PasswordReset.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'password_resets', underscored: true, updatedAt: false },
  );

  class LoginFailure extends Model<
    InferAttributes<LoginFailure>,
    InferCreationAttributes<LoginFailure>
  > {
    declare id: string;
    declare email: string;
    declare ip: string | null;
    declare createdAt: CreationOptional<Date>;
  }
  LoginFailure.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      email: { type: DataTypes.CITEXT, allowNull: false },
      ip: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'login_failures', underscored: true, updatedAt: false },
  );

  class UserTwoFactor extends Model<
    InferAttributes<UserTwoFactor>,
    InferCreationAttributes<UserTwoFactor>
  > {
    declare userId: string;
    declare secretEncrypted: string;
    declare keyId: string;
    declare enabledAt: Date | null;
    declare lastUsedStep: number | null;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  UserTwoFactor.init(
    {
      userId: { type: DataTypes.UUID, primaryKey: true },
      secretEncrypted: { type: DataTypes.TEXT, allowNull: false },
      keyId: { type: DataTypes.TEXT, allowNull: false },
      enabledAt: { type: DataTypes.DATE, allowNull: true },
      // bigint comes back from Postgres as a string; time steps fit comfortably in a JS number.
      lastUsedStep: {
        type: DataTypes.BIGINT,
        allowNull: true,
        get(this: UserTwoFactor) {
          const raw = this.getDataValue('lastUsedStep') as number | string | null;
          return raw === null ? null : Number(raw);
        },
      },
      ...timestamps,
    },
    { sequelize, tableName: 'user_two_factor', underscored: true },
  );

  class RecoveryCode extends Model<
    InferAttributes<RecoveryCode>,
    InferCreationAttributes<RecoveryCode>
  > {
    declare id: string;
    declare userId: string;
    declare codeHash: string;
    declare usedAt: Date | null;
    declare createdAt: CreationOptional<Date>;
  }
  RecoveryCode.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      codeHash: { type: DataTypes.TEXT, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'recovery_codes', underscored: true, updatedAt: false },
  );

  class LoginChallenge extends Model<
    InferAttributes<LoginChallenge>,
    InferCreationAttributes<LoginChallenge>
  > {
    declare id: string;
    declare tokenHash: string;
    declare userId: string;
    declare workspaceId: string;
    declare failedAttempts: CreationOptional<number>;
    declare expiresAt: Date;
    declare createdAt: CreationOptional<Date>;
  }
  LoginChallenge.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      failedAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'login_challenges', underscored: true, updatedAt: false },
  );

  class TrustedDevice extends Model<
    InferAttributes<TrustedDevice>,
    InferCreationAttributes<TrustedDevice>
  > {
    declare id: string;
    declare tokenHash: string;
    declare userId: string;
    declare userAgent: string | null;
    declare expiresAt: Date;
    declare createdAt: CreationOptional<Date>;
  }
  TrustedDevice.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      userAgent: { type: DataTypes.TEXT, allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'trusted_devices', underscored: true, updatedAt: false },
  );

  /** Tenant table: row-level security by workspace_id. Query it inside withWorkspace(). */
  class Invitation extends Model<InferAttributes<Invitation>, InferCreationAttributes<Invitation>> {
    declare id: string;
    declare workspaceId: string;
    declare email: string;
    declare role: Role;
    declare tokenHash: string;
    declare invitedBy: string | null;
    declare expiresAt: Date;
    declare acceptedAt: CreationOptional<Date | null>;
    declare revokedAt: CreationOptional<Date | null>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  Invitation.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      email: { type: DataTypes.CITEXT, allowNull: false },
      role: { type: DataTypes.TEXT, allowNull: false },
      tokenHash: { type: DataTypes.TEXT, allowNull: false },
      invitedBy: { type: DataTypes.UUID, allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      acceptedAt: { type: DataTypes.DATE, allowNull: true },
      revokedAt: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    },
    { sequelize, tableName: 'invitations', underscored: true },
  );

  return {
    Invitation,
    UserTwoFactor,
    RecoveryCode,
    LoginChallenge,
    TrustedDevice,
    User,
    Workspace,
    Membership,
    EmailVerification,
    Session,
    PasswordHistory,
    PasswordReset,
    LoginFailure,
  };
}

export type AccountModels = ReturnType<typeof defineModels>;
export type UserRecord = InstanceType<AccountModels['User']>;
export type WorkspaceRecord = InstanceType<AccountModels['Workspace']>;
export type SessionRecord = InstanceType<AccountModels['Session']>;

const cache = new WeakMap<Sequelize, AccountModels>();

/**
 * The account models bound to one connection (db.writer or db.reader). Sequelize models belong to
 * a single connection, so each pool gets its own set, created once.
 */
export function accountModels(sequelize: Sequelize): AccountModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
