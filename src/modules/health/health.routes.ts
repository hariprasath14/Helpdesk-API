import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { isReachable, type Database } from '../../db/index.js';
import { errorResponses } from '../../lib/schemas.js';

const CheckStatus = z.enum(['ok', 'error']);

const HealthResponseSchema = z
  .object({
    status: CheckStatus.describe('"ok" only when every check is ok'),
    version: z.string().describe('Running release (APP_VERSION)'),
    uptimeSeconds: z.number().int().nonnegative(),
    checks: z.object({
      databaseWriter: CheckStatus,
      databaseReader: CheckStatus,
    }),
  })
  .meta({ id: 'HealthResponse' });

// The load balancer calls /health every few seconds, so its routine request logs are skipped:
// the route logs at warn or above, but never below the configured LOG_LEVEL.
const QUIETER_THAN_WARN = new Set<Config['LOG_LEVEL']>(['error', 'fatal', 'silent']);

/**
 * Health check used by the AWS load balancer and ECS. Returns 503 when a dependency is down so
 * the task is replaced. Later steps add email and storage checks.
 */
export const healthRoutes: FastifyPluginCallbackZod<{ config: Config; db: Database }> = (
  app,
  { config, db },
  done,
) => {
  const logLevel = QUIETER_THAN_WARN.has(config.LOG_LEVEL) ? config.LOG_LEVEL : 'warn';

  app.get(
    '/health',
    {
      logLevel,
      schema: {
        tags: ['system'],
        summary: 'Service health',
        description: 'Checks both database connections. 503 when any check fails.',
        response: { ...errorResponses(), 200: HealthResponseSchema, 503: HealthResponseSchema },
      },
    },
    async (request, reply) => {
      const [writer, reader] = await Promise.all([isReachable(db.writer), isReachable(db.reader)]);
      const checks = {
        databaseWriter: writer ? ('ok' as const) : ('error' as const),
        databaseReader: reader ? ('ok' as const) : ('error' as const),
      };
      const healthy = Object.values(checks).every((status) => status === 'ok');
      if (!healthy) request.log.warn({ checks }, 'health check failed');

      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'error',
        version: config.APP_VERSION,
        uptimeSeconds: Math.round(process.uptime()),
        checks,
      });
    },
  );
  done();
};
