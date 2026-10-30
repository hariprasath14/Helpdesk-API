import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { sendSignal } from '../live/signals.js';

/** What a member can be told about (F25). */
export const NOTIFICATION_KINDS = [
  'assigned',
  'mention',
  'sla_warning',
  'sla_breach',
  'customer_reply',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Which kinds also come by email until a member changes it: all but customer replies. */
export const DEFAULT_EMAIL: Record<NotificationKind, boolean> = {
  assigned: true,
  mention: true,
  sla_warning: true,
  sla_breach: true,
  customer_reply: false,
};

function defineModels(sequelize: Sequelize) {
  /** Tenant table: one thing a member was told about a ticket (F25). */
  class Notification extends Model<
    InferAttributes<Notification>,
    InferCreationAttributes<Notification>
  > {
    declare id: string;
    declare workspaceId: string;
    declare userId: string;
    declare kind: NotificationKind;
    declare ticketId: string | null;
    declare title: string;
    declare body: string;
    declare readAt: Date | null;
    declare createdAt: CreationOptional<Date>;
  }
  Notification.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      ticketId: { type: DataTypes.UUID, allowNull: true },
      title: { type: DataTypes.TEXT, allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      readAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'notifications', underscored: true, updatedAt: false },
  );
  // Live updates (F26): each person's bell updates when their notifications are added.
  Notification.afterBulkCreate(async (rows, options) => {
    for (const row of rows) {
      await sendSignal(
        sequelize,
        { type: 'notification', workspaceId: row.workspaceId, userId: row.userId },
        options.transaction,
      );
    }
  });

  return { Notification };
}

export type NotificationModels = ReturnType<typeof defineModels>;

const cache = new WeakMap<Sequelize, NotificationModels>();

/** The notification models bound to one connection (db.writer or db.reader), created once. */
export function notificationModels(sequelize: Sequelize): NotificationModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
