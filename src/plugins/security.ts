import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config/index.js';
import { AppError } from '../lib/errors.js';

/**
 * HTTP-level protection for every route: security headers, a CORS allowlist and a default rate
 * limit. Stricter per-route limits (login, 2FA, password reset) are added by those modules.
 */
export const securityPlugin = fp(
  async (app: FastifyInstance, { config }: { config: Config }) => {
    // The API only returns JSON, so the strictest Content-Security-Policy applies.
    await app.register(helmet, {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    });

    const allowedOrigins = new Set(config.CORS_ORIGINS);
    await app.register(cors, {
      // Requests without an Origin header (curl, server-to-server, health checks) are not CORS requests.
      origin: (origin, callback) => {
        callback(null, origin === undefined || allowedOrigins.has(origin));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: 600,
    });

    await app.register(rateLimit, {
      global: true,
      max: config.RATE_LIMIT_MAX,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      // The load balancer polls /health every few seconds; it must never be throttled.
      allowList: (request) => request.routeOptions.url === '/health',
      errorResponseBuilder: (_request, context) =>
        new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.', {
          retryAfterSeconds: Math.ceil(context.ttl / 1000),
        }),
    });
  },
  { name: 'security' },
);
