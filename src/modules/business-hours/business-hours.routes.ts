import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import type { Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';
import { isTimeZone } from '../accounts/schemas.js';
import { requireSignedIn } from '../accounts/request-context.js';
import {
  addHoliday,
  getBusinessHours,
  MAX_HOLIDAYS,
  removeHoliday,
  TIME_PATTERN,
  updateBusinessHours,
  WEEKDAYS,
} from './business-hours.service.js';

const time = z.string().regex(TIME_PATTERN, 'Enter a time such as 09:00.');

const DaySchema = z
  .object({
    day: z.enum(WEEKDAYS),
    open: z.boolean().describe('A working day'),
    start: time.describe('"HH:MM" in the workspace time zone'),
    end: time.describe('"HH:MM"; 24:00 is the end of the day'),
  })
  .meta({ id: 'BusinessDay' });

const HolidaySchema = z
  .object({
    id: z.string(),
    date: z.string().describe('"2026-12-25"'),
    name: z.string(),
  })
  .meta({ id: 'Holiday' });

const BusinessHoursSchema = z
  .object({
    timeZone: z.string().describe("The workspace's time zone"),
    alwaysOpen: z.boolean().describe('24×7: every hour counts and holidays do not apply'),
    days: z.array(DaySchema).describe('Monday to Sunday'),
    holidays: z.array(HolidaySchema).describe('Earliest first'),
    openNow: z.boolean().describe('Whether it is working time right now'),
    saved: z.boolean().describe('Saved once; until then Monday to Friday, 09:00 to 18:00 apply'),
  })
  .meta({ id: 'BusinessHours' });

const UpdateBusinessHoursSchema = z
  .object({
    timeZone: z.string().refine(isTimeZone, 'Choose a time zone from the list.'),
    alwaysOpen: z.boolean(),
    days: z.array(DaySchema).length(7, 'List the days from Monday to Sunday.'),
  })
  .meta({ id: 'UpdateBusinessHoursRequest' });

const AddHolidaySchema = z
  .object({
    date: z.iso.date('Choose a date.'),
    name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use at most 80 characters.'),
  })
  .meta({ id: 'AddHolidayRequest' });

const HolidayParams = z.object({ holidayId: z.uuid() });

/**
 * Business hours and holidays (F22): when the team works, in the workspace's time zone, for SLA
 * clocks (F23). Admins only (settings.manage).
 */
export const businessHoursRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  deps,
  done,
) => {
  const signedIn = (request: Parameters<typeof requireSignedIn>[2]) =>
    requireSignedIn(deps.config, deps.db, request);

  app.get(
    '/workspace/business-hours',
    {
      schema: {
        tags: ['business-hours'],
        summary: 'The time zone, working hours and holidays',
        response: { 200: BusinessHoursSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => getBusinessHours(deps, await signedIn(request)),
  );

  app.put(
    '/workspace/business-hours',
    {
      schema: {
        tags: ['business-hours'],
        summary: 'Save the time zone and working hours',
        description:
          'Each working day has one stretch of hours. At least one working day unless 24×7.',
        body: UpdateBusinessHoursSchema,
        response: { 200: BusinessHoursSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => updateBusinessHours(deps, await signedIn(request), request.body),
  );

  app.post(
    '/workspace/holidays',
    {
      schema: {
        tags: ['business-hours'],
        summary: 'Add a holiday',
        description: `One per date; up to ${String(MAX_HOLIDAYS)} per workspace (409).`,
        body: AddHolidaySchema,
        response: { 200: BusinessHoursSchema, ...errorResponses(401, 403, 404, 409) },
      },
    },
    async (request) => addHoliday(deps, await signedIn(request), request.body),
  );

  app.delete(
    '/workspace/holidays/:holidayId',
    {
      schema: {
        tags: ['business-hours'],
        summary: 'Remove a holiday',
        params: HolidayParams,
        response: { 200: BusinessHoursSchema, ...errorResponses(401, 403, 404) },
      },
    },
    async (request) => removeHoliday(deps, await signedIn(request), request.params.holidayId),
  );

  done();
};
