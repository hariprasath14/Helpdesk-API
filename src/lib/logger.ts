import type { FastifyServerOptions } from 'fastify';
import type { Config } from '../config/index.js';

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

/**
 * Paths removed from every log line. Personal data and secrets must never reach the logs
 * (ENGINEERING_STANDARDS.md section 5). Extend this list when new sensitive fields appear.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.secret',
  '*.totpCode',
  '*.recoveryCode',
];

/**
 * Pino settings shared by the API and the worker. `pretty` output needs the pino-pretty dev
 * dependency, so it is for local development only; AWS always uses `json`.
 */
export function loggerOptions(config: Config, stream?: NodeJS.WritableStream): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    base: { service: 'helpdesk-api', version: config.APP_VERSION },
    ...(stream ? { stream } : {}),
    ...(config.LOG_FORMAT === 'pretty' && !stream
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
      : {}),
  };
}
