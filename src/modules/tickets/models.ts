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
import { sendSignal } from '../live/signals.js';
import type { TicketFilters, TicketSort } from './ticket-list.js';

export const TICKET_STATUSES = [
  'open',
  'pending',
  'waiting_on_customer',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_TYPES = ['question', 'incident', 'problem', 'feature_request'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_SOURCES = ['agent', 'email', 'web_form'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

/** The filters a saved view keeps: the list's filters without the trash and per-record ones. */
export type ViewFilters = Omit<TicketFilters, 'deleted' | 'contactId' | 'companyId'>;

/** A finished stay in "Waiting on customer", which SLA clocks leave out (F23); ISO times. */
export interface SlaPause {
  from: string;
  to: string;
}

/** One changed property in a ticket's history: its key and the values before and after. */
export interface ActivityChange {
  field: string;
  /** The custom field's label at the time (customFields.<key> changes). */
  label?: string;
  from: unknown;
  to: unknown;
}

function defineModels(sequelize: Sequelize) {
  /** Tenant table. Query it inside withWorkspace(). */
  class Ticket extends Model<InferAttributes<Ticket>, InferCreationAttributes<Ticket>> {
    declare id: string;
    declare workspaceId: string;
    declare number: number;
    declare subject: string;
    declare description: string;
    declare contactId: string;
    declare companyId: string | null;
    declare status: TicketStatus;
    declare priority: TicketPriority;
    declare type: TicketType | null;
    declare teamId: string | null;
    declare assigneeUserId: string | null;
    declare source: TicketSource;
    declare customFields: CustomFieldValues;
    declare createdByUserId: string | null;
    declare resolvedAt: Date | null;
    declare closedAt: Date | null;
    declare firstResponseAt: CreationOptional<Date | null>;
    /** When it reached its current status (F20, "hours in this status"). */
    declare statusChangedAt: CreationOptional<Date>;
    declare deletedAt: Date | null;
    /** The Message-ID of the email that raised it (F14). */
    declare emailMessageId: CreationOptional<string | null>;
    /** SLA (F23): the policy followed, the due times and what the clocks leave out. */
    declare slaPolicyId: CreationOptional<string | null>;
    declare slaReplyDueAt: CreationOptional<Date | null>;
    declare slaResolveDueAt: CreationOptional<Date | null>;
    /** When the resolve clock started: creation, or the last reopening; null means creation. */
    declare slaResolveFrom: CreationOptional<Date | null>;
    declare slaPauses: CreationOptional<SlaPause[]>;
    /** The next deadline still running; null while paused, done or without a policy. */
    declare slaDueAt: CreationOptional<Date | null>;
    /** Merged into another ticket (F28): closed, read-only, email to it lands there. */
    declare mergedIntoId: CreationOptional<string | null>;
    /** Copied on every reply (F28: the requesters of tickets merged into it). */
    declare ccEmails: CreationOptional<string[]>;
    /** Warnings and escalations done (F24): "reply:warning" → the clock start they were for. */
    declare slaAlerts: CreationOptional<Record<string, string>>;
    /** When the next warning or escalation is due; null when none is. */
    declare slaAlertAt: CreationOptional<Date | null>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
    declare tags?: NonAttribute<TicketTag[]>;
  }
  Ticket.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      number: { type: DataTypes.INTEGER, allowNull: false },
      subject: { type: DataTypes.TEXT, allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false },
      contactId: { type: DataTypes.UUID, allowNull: false },
      companyId: { type: DataTypes.UUID, allowNull: true },
      status: { type: DataTypes.TEXT, allowNull: false },
      priority: { type: DataTypes.TEXT, allowNull: false },
      type: { type: DataTypes.TEXT, allowNull: true },
      teamId: { type: DataTypes.UUID, allowNull: true },
      assigneeUserId: { type: DataTypes.UUID, allowNull: true },
      source: { type: DataTypes.TEXT, allowNull: false },
      customFields: { type: DataTypes.JSONB, allowNull: false },
      createdByUserId: { type: DataTypes.UUID, allowNull: true },
      resolvedAt: { type: DataTypes.DATE, allowNull: true },
      closedAt: { type: DataTypes.DATE, allowNull: true },
      firstResponseAt: { type: DataTypes.DATE, allowNull: true },
      statusChangedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      deletedAt: { type: DataTypes.DATE, allowNull: true },
      emailMessageId: { type: DataTypes.TEXT, allowNull: true },
      slaPolicyId: { type: DataTypes.UUID, allowNull: true },
      slaReplyDueAt: { type: DataTypes.DATE, allowNull: true },
      slaResolveDueAt: { type: DataTypes.DATE, allowNull: true },
      slaResolveFrom: { type: DataTypes.DATE, allowNull: true },
      slaPauses: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      slaDueAt: { type: DataTypes.DATE, allowNull: true },
      slaAlerts: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      mergedIntoId: { type: DataTypes.UUID, allowNull: true },
      ccEmails: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false, defaultValue: [] },
      slaAlertAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'tickets', underscored: true },
  );

  /** Tenant table: one tag of one ticket, in lowercase. */
  class TicketTag extends Model<InferAttributes<TicketTag>, InferCreationAttributes<TicketTag>> {
    declare ticketId: string;
    declare workspaceId: string;
    declare tag: string;
  }
  TicketTag.init(
    {
      ticketId: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      tag: { type: DataTypes.TEXT, primaryKey: true },
    },
    { sequelize, tableName: 'ticket_tags', underscored: true, timestamps: false },
  );

  /** Tenant table: one entry in a ticket's history. */
  class TicketActivity extends Model<
    InferAttributes<TicketActivity>,
    InferCreationAttributes<TicketActivity>
  > {
    declare id: string;
    declare workspaceId: string;
    declare ticketId: string;
    declare actorUserId: string | null;
    declare actorName: string;
    declare action: 'created' | 'updated' | 'deleted' | 'restored';
    declare changes: ActivityChange[];
    declare createdAt: CreationOptional<Date>;
  }
  TicketActivity.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ticketId: { type: DataTypes.UUID, allowNull: false },
      actorUserId: { type: DataTypes.UUID, allowNull: true },
      actorName: { type: DataTypes.TEXT, allowNull: false },
      action: { type: DataTypes.TEXT, allowNull: false },
      changes: { type: DataTypes.JSONB, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'ticket_activities', underscored: true, updatedAt: false },
  );

  /** Tenant table: a saved ticket list view (F10), the owner's or shared with everyone. */
  class SavedView extends Model<InferAttributes<SavedView>, InferCreationAttributes<SavedView>> {
    declare id: string;
    declare workspaceId: string;
    declare ownerUserId: string;
    declare name: string;
    declare filters: ViewFilters;
    declare sort: TicketSort;
    declare shared: boolean;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }
  SavedView.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false },
      ownerUserId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.TEXT, allowNull: false },
      filters: { type: DataTypes.JSONB, allowNull: false },
      sort: { type: DataTypes.TEXT, allowNull: false },
      shared: { type: DataTypes.BOOLEAN, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    },
    { sequelize, tableName: 'ticket_views', underscored: true },
  );

  Ticket.hasMany(TicketTag, { foreignKey: 'ticketId', as: 'tags' });

  // Live updates (F26): every saved change to a ticket or its history is signalled, from the API
  // and the worker alike, when its transaction commits.
  Ticket.afterCreate(async (ticket, options) => {
    await sendSignal(
      sequelize,
      { type: 'ticket', workspaceId: ticket.workspaceId, ticketId: ticket.id, created: true },
      options.transaction,
    );
  });
  Ticket.afterUpdate(async (ticket, options) => {
    await sendSignal(
      sequelize,
      { type: 'ticket', workspaceId: ticket.workspaceId, ticketId: ticket.id },
      options.transaction,
    );
  });
  TicketActivity.afterCreate(async (activity, options) => {
    await sendSignal(
      sequelize,
      { type: 'ticket', workspaceId: activity.workspaceId, ticketId: activity.ticketId },
      options.transaction,
    );
  });

  return { Ticket, TicketTag, TicketActivity, SavedView };
}

export type TicketModels = ReturnType<typeof defineModels>;
export type TicketRecord = InstanceType<TicketModels['Ticket']>;
export type SavedViewRecord = InstanceType<TicketModels['SavedView']>;

const cache = new WeakMap<Sequelize, TicketModels>();

/** The ticket models bound to one connection (db.writer or db.reader), created once. */
export function ticketModels(sequelize: Sequelize): TicketModels {
  let models = cache.get(sequelize);
  if (!models) {
    models = defineModels(sequelize);
    cache.set(sequelize, models);
  }
  return models;
}
