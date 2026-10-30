import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ForbiddenError } from '../lib/errors.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Blocks cross-site requests that change data (CSRF). The app calls the API on its own address
 * (/api on the workspace's host), so a browser request from any other site is refused when it says
 * so (Sec-Fetch-Site) or its Origin does not match. Together with SameSite cookies and JSON-only
 * bodies this stops forged requests. Non-browser clients send neither header and are unaffected.
 */
export const sameOriginPlugin = fp(
  (app: FastifyInstance) => {
    app.addHook('onRequest', (request, _reply, done) => {
      if (!STATE_CHANGING.has(request.method)) {
        done();
        return;
      }
      const origin = request.headers.origin;
      const crossSite =
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin !== undefined && (!URL.canParse(origin) || new URL(origin).host !== request.host));
      done(
        crossSite ? new ForbiddenError('Requests from other sites are not allowed.') : undefined,
      );
    });
  },
  { name: 'same-origin' },
);
