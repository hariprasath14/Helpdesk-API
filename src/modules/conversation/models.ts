import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

import { sendSignal } from '../live/signals.js';

export const MESSAGE_KINDS = ['reply', 'note', 'forward', 'customer'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type EmailStatus = 'queued' | 'sent' | 'failed';

function defineModels(sequelize: Sequelize) {
  /** Tenant table: one message on a ticket. Query it inside withWorkspace(). */
  class TicketMessage extends Model<
    InferAttributes<TicketMessage>,
    InferCreationAttributes<TicketMessage>
  > {
    declare id: string;
    declare workspaceId: string;
    declare ticketId: string;
    declare kind: MessageKind;
    declare bodyText: string;
    declare bodyHtml: string | null;
    declare authorUserId: string | null;
    declare authorContactId: string | null;
    /** Who wrote it when no member or contact did, such as a rule (F17). */
    declare authorName: CreationOptional<string | null>;
    declare toEmails: string[];
    declare ccEmails: string[];
    declare mentionedUserIds: string[];
    declare emailStatus: EmailStatus | null;
    /** The outgoing email's Message-ID, with angle brackets (F13); customer emails keep theirs (F14). */
    declare emailMessageId: CreationOptional<string | null>;
    declare emailSentAt: CreationOptional<Date | null>;
    declare emailAttempts: CreationOptional<number>;
    declare emailError: CreationOptional<string | null>;
    /** Moved in by a merge (F28): the ticket it came from, "From #41". */
    declare fromTicketNumber: CreationOptional<number | null>;
    declare createdAt: CreationOptional<Date>;
  }
  TicketMessage.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ticketId: { type: DataTypes.UUID, allowNull: false },
      kind: { type: DataTypes.TEXT, allowNull: false },
      bodyText: { type: DataTypes.TEXT, allowNull: false },
      bodyHtml: { type: DataTypes.TEXT, allowNull: true },
      authorUserId: { type: DataTypes.UUID, allowNull: true },
      authorContactId: { type: DataTypes.UUID, allowNull: true },
      authorName: { type: DataTypes.TEXT, allowNull: true },
      toEmails: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
      ccEmails: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
      mentionedUserIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false },
      emailStatus: { type: DataTypes.TEXT, allowNull: true },
      emailMessageId: { type: DataTypes.TEXT, allowNull: true },
      emailSentAt: { type: DataTypes.DATE, allowNull: true },
      emailAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      emailError: { type: DataTypes.TEXT, allowNull: true },
      fromTicketNumber: { type: DataTypes.INTEGER, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'ticket_messages', underscored: true, updatedAt: false },
  );

  /** Tenant table: a file uploaded for a message (message_id empty until the message is sent). */
  class TicketAttachment extends Model<
    InferAttributes<TicketAttachment>,
    InferCreationAttributes<TicketAttachment>
  > {
    declare id: string;
    declare workspaceId: string;
    declare ticketId: string | null;
    declare messageId: string | null;
    /** Null for files that came with an email (F14). */
    declare uploadedByUserId: string | null;
    declare fileName: string;
    declare contentType: string;
    declare sizeBytes: number;
    declare createdAt: CreationOptional<Date>;
  }
  TicketAttachment.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ticketId: { type: DataTypes.UUID, allowNull: true },
      messageId: { type: DataTypes.UUID, allowNull: true },
      uploadedByUserId: { type: DataTypes.UUID, allowNull: true },
      fileName: { type: DataTypes.TEXT, allowNull: false },
      contentType: { type: DataTypes.TEXT, allowNull: false },
      sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'ticket_attachments', underscored: true, updatedAt: false },
  );

  // Live updates (F26): a new message, or one whose email was sent or failed.
  const signal = async (
    message: { workspaceId: string; ticketId: string },
    options: { transaction?: Parameters<typeof sendSignal>[2] },
  ) => {
    await sendSignal(
      sequelize,
      { type: 'ticket', workspaceId: message.workspaceId, ticketId: message.ticketId },
      options.transaction,
    );
  };
  TicketMessage.afterCreate(signal);
  TicketMessage.afterUpdate(signal);

  return { TicketMessage, TicketAttachment };
}

export type ConversationModels = ReturnType<typeof defineModels>;
export type MessageRecord = InstanceType<ConversationModels['TicketMessage']>;
export type AttachmentRecord = InstanceType<ConversationModels['TicketAttachment']>;

const cache = new WeakMap<Sequelize, ConversationModels>();

/** The conversation models bound to one connection (db.writer or db.reader), created once. */
export function conversationModels(sequelize: Sequelize): ConversationModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
