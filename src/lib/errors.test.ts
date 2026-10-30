import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

describe('typed errors', () => {
  it.each([
    [new ValidationError(), 400, 'VALIDATION_ERROR', 'The request is invalid.'],
    [new UnauthorizedError(), 401, 'UNAUTHORIZED', 'You need to sign in.'],
    [new ForbiddenError(), 403, 'FORBIDDEN', 'You do not have permission to do this.'],
    [new NotFoundError(), 404, 'NOT_FOUND', 'Not found.'],
    [new ConflictError(), 409, 'CONFLICT', 'This conflicts with the current state.'],
  ])(
    '%s has status %i and code %s with a friendly default message',
    (error, status, code, message) => {
      expect(error).toBeInstanceOf(AppError);
      expect(error.statusCode).toBe(status);
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
    },
  );

  it('keeps the subclass name for logs', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
  });

  it('carries details for validation and conflict errors', () => {
    expect(new ValidationError('Bad email.', { field: 'email' }).details).toEqual({
      field: 'email',
    });
    expect(new ConflictError('Taken.', { field: 'subdomain' }).details).toEqual({
      field: 'subdomain',
    });
  });
});
