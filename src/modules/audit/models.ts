import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import type { Role } from '../accounts/models.js';

/** What each recorded action is about; the category is fixed per action. */
export const AUDIT_ACTIONS = {
  'workspace.created': 'settings',
  'workspace.two_factor_requirement_changed': 'settings',
  'workspace.email_sender_changed': 'settings',
  'workspace.customer_notifications_changed': 'settings',
  'workspace.web_form_changed': 'settings',
  'workspace.time_zone_changed': 'settings',
  'workspace.business_hours_changed': 'settings',
  'holiday.added': 'settings',
  'holiday.removed': 'settings',
  'member.invited': 'members',
  'invitation.resent': 'members',
  'invitation.revoked': 'members',
  'member.joined': 'members',
  'member.role_changed': 'members',
  'member.deactivated': 'members',
  'member.reactivated': 'members',
  'member.two_factor_reset': 'security',
  'password.changed': 'security',
  'password.reset': 'security',
  'two_factor.enabled': 'security',
  'two_factor.disabled': 'security',
  'two_factor.recovery_codes_regenerated': 'security',
  'sessions.signed_out_others': 'security',
  'sign_in.succeeded': 'sign_in',
  'sign_in.locked': 'sign_in',
  'custom_field.created': 'settings',
  'custom_field.updated': 'settings',
  'custom_field.archived': 'settings',
  'custom_field.restored': 'settings',
  'custom_fields.reordered': 'settings',
  'contact.deleted': 'contacts',
  'company.deleted': 'contacts',
  'team.created': 'settings',
  'team.updated': 'settings',
  'team.deleted': 'settings',
  'ticket.deleted': 'tickets',
  'ticket.restored': 'tickets',
  'ticket.merged': 'tickets',
  'rule.created': 'settings',
  'rule.updated': 'settings',
  'rule.deleted': 'settings',
  'rules.reordered': 'settings',
  'sla_policy.created': 'settings',
  'sla_policy.updated': 'settings',
  'sla_policy.deleted': 'settings',
  'sla_policies.reordered': 'settings',
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_CATEGORIES = [
  'members',
  'security',
  'settings',
  'sign_in',
  'contacts',
  'tickets',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type ActorType = 'member' | 'support' | 'system';

function defineModels(sequelize: Sequelize) {
  /** Tenant table, append-only for the app. Query it inside withWorkspace(). */
  class AuditEvent extends Model<InferAttributes<AuditEvent>, InferCreationAttributes<AuditEvent>> {
    declare id: string;
    declare workspaceId: string;
    declare actorType: ActorType;
    declare actorUserId: string | null;
    declare actorName: string;
    declare actorEmail: string | null;
    declare actorRole: Role | null;
    declare category: AuditCategory;
    declare action: AuditAction;
    declare targetType: string | null;
    declare targetId: string | null;
    declare targetLabel: string | null;
    declare details: Record<string, unknown>;
    declare ip: string | null;
    declare userAgent: string | null;
    declare createdAt: CreationOptional<Date>;
  }
  AuditEvent.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      actorType: { type: DataTypes.TEXT, allowNull: false },
      actorUserId: { type: DataTypes.UUID, allowNull: true },
      actorName: { type: DataTypes.TEXT, allowNull: false },
      actorEmail: { type: DataTypes.TEXT, allowNull: true },
      actorRole: { type: DataTypes.TEXT, allowNull: true },
      category: { type: DataTypes.TEXT, allowNull: false },
      action: { type: DataTypes.TEXT, allowNull: false },
      targetType: { type: DataTypes.TEXT, allowNull: true },
      targetId: { type: DataTypes.UUID, allowNull: true },
      targetLabel: { type: DataTypes.TEXT, allowNull: true },
      details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      ip: { type: DataTypes.TEXT, allowNull: true },
      userAgent: { type: DataTypes.TEXT, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'audit_events', underscored: true, updatedAt: false },
  );
  return { AuditEvent };
}

export type AuditModels = ReturnType<typeof defineModels>;
export type AuditEventRecord = InstanceType<AuditModels['AuditEvent']>;

const cache = new WeakMap<Sequelize, AuditModels>();

/** The audit model bound to one connection (db.writer or db.reader), created once. */
export function auditModels(sequelize: Sequelize): AuditModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
