import { z } from 'zod';

/**
 * Shared response schemas. Registering a schema with an `id` makes it a named component in the
 * OpenAPI spec, so the frontend's generated client gets one `ErrorResponse` type, not a copy per route.
 */

export const FieldErrorSchema = z
  .object({
    field: z.string().describe('Path of the invalid input, for example "email" or "items.0.name"'),
    message: z.string(),
  })
  .meta({ id: 'FieldError' });

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z
        .string()
        .describe('Stable machine-readable code, for example VALIDATION_ERROR or NOT_FOUND'),
      message: z.string().describe('Human-readable message, safe to show to the user'),
      details: z.unknown().optional().describe('Extra information, for example invalid fields'),
    }),
  })
  .meta({ id: 'ErrorResponse' });

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 503;
type AlwaysPossible = 400 | 429 | 500;

/**
 * The error responses a route can return, for its `schema.response`. Every route gets 400, 429
 * and 500; list any others it can produce, for example `errorResponses(401, 403, 404)`.
 */
export function errorResponses<S extends ErrorStatus = never>(
  ...statuses: S[]
): Record<AlwaysPossible | S, typeof ErrorResponseSchema> {
  const all = new Set<ErrorStatus>([400, 429, 500, ...statuses]);
  return Object.fromEntries([...all].map((status) => [status, ErrorResponseSchema])) as Record<
    AlwaysPossible | S,
    typeof ErrorResponseSchema
  >;
}
