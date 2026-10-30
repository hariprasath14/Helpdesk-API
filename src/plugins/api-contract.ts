import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from '../config/index.js';
import { pruneUnusedSchemas } from '../lib/openapi.js';

/**
 * Makes Zod the single source of truth for every route's input and output:
 * - requests are validated against the route's Zod schemas (400 VALIDATION_ERROR otherwise);
 * - responses are serialized through the route's response schema, so fields not in the schema
 *   (for example a password hash on a user row) never leave the API;
 * - the same schemas generate the OpenAPI spec that helpdesk-web builds its typed client from.
 */
export const apiContractPlugin = fp(
  async (app: FastifyInstance, { config }: { config: Config }) => {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Help desk API',
          description:
            'Backend API for the help desk. Errors always use the ErrorResponse shape. ' +
            'Generated from the route schemas; do not edit by hand.',
          version: config.APP_VERSION,
        },
        tags: [{ name: 'system', description: 'Health and service information' }],
      },
      transform: jsonSchemaTransform,
      transformObject: (document) => pruneUnusedSchemas(jsonSchemaTransformObject(document)),
    });

    // The interactive docs page and /docs/json are a setting: on locally and in dev, off in prod.
    if (config.API_DOCS_ENABLED) {
      await app.register(swaggerUi, {
        routePrefix: '/docs',
        // The page needs scripts and styles, so it sets its own Content-Security-Policy instead of
        // the API's `default-src 'none'`.
        staticCSP: true,
        uiConfig: { docExpansion: 'list', deepLinking: true },
      });
    }
  },
  { name: 'api-contract' },
);
