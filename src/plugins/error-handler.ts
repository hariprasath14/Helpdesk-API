import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

const VALIDATION_CONTEXT: Record<string, string> = {
  body: 'request body',
  querystring: 'query string',
  params: 'URL',
  headers: 'request headers',
};

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

// Fastify's own client errors (bad JSON, body too large, wrong content type) carry a 4xx statusCode and a code.
const FASTIFY_CLIENT_ERRORS: Record<string, { code: string; message: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    message: 'The request body is too large.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'This content type is not supported.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: { code: 'VALIDATION_ERROR', message: 'The request body is empty.' },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: 'VALIDATION_ERROR',
    message: 'The request body is not valid JSON.',
  },
};

/**
 * One place that turns every error into the standard `{ error: { code, message, details? } }`
 * shape. Unexpected errors are logged in full but the client only sees a generic message.
 */
export const errorHandlerPlugin = fp(
  (app: FastifyInstance) => {
    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(body(error.code, error.message, error.details));
      }

      if (error.validation) {
        const where = VALIDATION_CONTEXT[error.validationContext ?? ''] ?? 'request';
        const fields = error.validation.map((issue) => ({
          field: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          message: issue.message ?? 'Invalid value',
        }));
        return reply
          .status(400)
          .send(body('VALIDATION_ERROR', `The ${where} is invalid.`, { fields }));
      }

      // A response that does not match its own schema is our bug, never the client's.
      if (isResponseSerializationError(error)) {
        request.log.error(
          { err: error, issues: error.cause.issues },
          'response does not match its schema',
        );
        return reply
          .status(500)
          .send(body('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
      }

      if (error.statusCode === 429) {
        return reply
          .status(429)
          .send(body('RATE_LIMITED', 'Too many requests. Please wait and try again.'));
      }

      const known = FASTIFY_CLIENT_ERRORS[error.code];
      if (known && error.statusCode !== undefined && error.statusCode < 500) {
        return reply.status(error.statusCode).send(body(known.code, known.message));
      }

      if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
        request.log.warn({ err: error }, 'client error');
        return reply
          .status(error.statusCode)
          .send(body('BAD_REQUEST', 'The request could not be processed.'));
      }

      request.log.error({ err: error }, 'unhandled error');
      return reply
        .status(500)
        .send(body('INTERNAL_ERROR', 'Something went wrong on our side. Please try again.'));
    });

    app.setNotFoundHandler((_request, reply) => {
      return reply.status(404).send(body('NOT_FOUND', 'This endpoint does not exist.'));
    });
  },
  { name: 'error-handler' },
);
