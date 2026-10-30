import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import { standardFieldsFor } from '../contacts/standard-fields.js';
import {
  archiveField,
  createField,
  listFields,
  MAX_CHOICES,
  reorderFields,
  restoreField,
  updateField,
} from './custom-fields.service.js';
import { FIELD_TYPES, RECORD_TYPES, REQUIRED_RULES, type RecordType } from './models.js';

const recordType = z.enum(RECORD_TYPES);
const label = z.string().trim().min(1, 'Enter a label.').max(80, 'Use at most 80 characters.');
const helpText = z.string().trim().max(200, 'Use at most 200 characters.');
const choiceInput = z.object({
  id: z.uuid().optional().describe('An existing choice; leave out for a new one'),
  label: z.string().trim().min(1, 'Enter a choice.').max(100, 'Use at most 100 characters.'),
  isDefault: z.boolean().optional(),
});
const choices = z
  .array(choiceInput)
  .max(MAX_CHOICES)
  .describe('The full list in order; existing choices left out are removed (kept on old records)');

const ChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  removed: z.boolean().describe('Still shown on records that have it, not offered for new ones'),
  isDefault: z.boolean(),
});

const CustomFieldSchema = z
  .object({
    id: z.string(),
    recordType,
    key: z.string().describe('Permanent internal name, used by rules, the API and exports'),
    label: z.string(),
    helpText: z.string().nullable(),
    type: z.enum(FIELD_TYPES),
    required: z.enum(REQUIRED_RULES),
    archived: z.boolean(),
    position: z.number().int(),
    checkboxDefault: z.boolean().nullable(),
    choices: z.array(ChoiceSchema),
  })
  .meta({ id: 'CustomField' });

const StandardFieldSchema = z
  .object({
    key: z.string().describe('The request and response property, for example "otherEmails"'),
    label: z.string(),
    description: z.string().describe('What it holds'),
    rule: z.string().nullable().describe('The rule the API enforces; null when optional'),
  })
  .meta({ id: 'StandardField' });

const FieldListSchema = z
  .object({
    standardFields: z
      .array(StandardFieldSchema)
      .describe('Built-in fields, always on the form above the custom fields; not editable'),
    fields: z.array(CustomFieldSchema),
  })
  .meta({ id: 'CustomFieldList' });

const CreateFieldSchema = z
  .object({
    recordType,
    label,
    helpText: helpText.optional(),
    type: z.enum(FIELD_TYPES),
    required: z.enum(REQUIRED_RULES).default('never'),
    checkboxDefault: z.boolean().optional(),
    choices: choices.optional(),
  })
  .meta({ id: 'CreateCustomFieldRequest' });

const UpdateFieldSchema = z
  .object({
    label: label.optional(),
    helpText: helpText.nullable().optional(),
    required: z.enum(REQUIRED_RULES).optional(),
    checkboxDefault: z.boolean().nullable().optional(),
    choices: choices.optional(),
  })
  .meta({ id: 'UpdateCustomFieldRequest' });

const ReorderSchema = z
  .object({
    recordType,
    fieldIds: z
      .array(z.uuid())
      .max(100)
      .describe('Every active field of the record type, in order'),
  })
  .meta({ id: 'ReorderCustomFieldsRequest' });

const FieldIdParams = z.object({ fieldId: z.uuid() });
const adminsOnly = 'Admins only (settings.manage). Returns the record type’s updated list.';

/** Custom field definitions: everyone reads them (for forms); admins manage them. */
export const customFieldsRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);
  // Every answer carries the record type's built-in fields too, so a page can replace its list.
  // A change's list always holds the changed field, so its record type is known from it.
  const list = async (
    fields: Promise<Awaited<ReturnType<typeof listFields>>>,
    recordType?: RecordType,
  ) => {
    const all = await fields;
    const type = recordType ?? all[0]?.recordType;
    return { standardFields: type ? standardFieldsFor(type) : [], fields: all };
  };

  app.get(
    '/custom-fields',
    {
      schema: {
        tags: ['custom-fields'],
        summary: "A record type's custom fields, in order (archived ones too)",
        querystring: z.object({ recordType }),
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      list(
        listFields(deps, await signedIn(request), request.query.recordType),
        request.query.recordType,
      ),
  );

  app.post(
    '/custom-fields',
    {
      schema: {
        tags: ['custom-fields'],
        summary: 'Add a custom field',
        description: `${adminsOnly} Dropdown and multi-select fields need at least one choice. "on_resolve" is for ticket fields only. At most 50 active fields per record type (409).`,
        body: CreateFieldSchema,
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      list(createField(deps, await signedIn(request), request.body), request.body.recordType),
  );

  app.patch(
    '/custom-fields/:fieldId',
    {
      schema: {
        tags: ['custom-fields'],
        summary: "Change a field's label, help text, required rule, default or choices",
        description: `${adminsOnly} The key and type never change.`,
        params: FieldIdParams,
        body: UpdateFieldSchema,
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) =>
      list(updateField(deps, await signedIn(request), request.params.fieldId, request.body)),
  );

  app.post(
    '/custom-fields/:fieldId/archive',
    {
      schema: {
        tags: ['custom-fields'],
        summary: 'Archive a field (hidden from forms; values kept)',
        description: adminsOnly,
        params: FieldIdParams,
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => list(archiveField(deps, await signedIn(request), request.params.fieldId)),
  );

  app.post(
    '/custom-fields/:fieldId/restore',
    {
      schema: {
        tags: ['custom-fields'],
        summary: 'Restore an archived field (added at the end)',
        description: `${adminsOnly} Refused (409) when the record type already has 50 active fields.`,
        params: FieldIdParams,
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => list(restoreField(deps, await signedIn(request), request.params.fieldId)),
  );

  app.put(
    '/custom-fields/order',
    {
      schema: {
        tags: ['custom-fields'],
        summary: 'Set the order of a record type’s active fields',
        description: `${adminsOnly} 409 when the list no longer matches the active fields.`,
        body: ReorderSchema,
        response: { 200: FieldListSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) =>
      list(
        reorderFields(
          deps,
          await signedIn(request),
          request.body.recordType,
          request.body.fieldIds,
        ),
        request.body.recordType,
      ),
  );

  done();
};
