import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { describeRequest, type TestRequest } from './tenant-isolation.js';

/**
 * The standard read-after-write test for an endpoint that creates or changes data
 * (ENGINEERING_STANDARDS.md 1). Build `app` with the `LAGGING_READER` override: its reader
 * never sees new writes, like an Aurora reader that is a moment behind. The endpoint must still
 * answer with the data it just wrote, which it can only do by reading from the writer.
 *
 * `expectInResponse` lists values the response must contain (for example the new subject line).
 * Returns the response for further checks.
 */
export async function expectReadAfterWrite(
  app: FastifyInstance,
  request: TestRequest,
  expectInResponse: string[],
): Promise<LightMyRequestResponse> {
  const response = await app.inject(request);
  const name = describeRequest(request);

  if (response.statusCode >= 400) {
    throw new Error(
      `Read-after-write failed: ${name} returned ${response.statusCode} with a lagging reader. ` +
        'Does it read its own result from db.reader? Use db.writer for that read.\n' +
        response.body,
    );
  }
  const missing = expectInResponse.filter((value) => !response.body.includes(value));
  if (missing.length > 0) {
    throw new Error(
      `Read-after-write failed: ${name} did not return ${missing.map((v) => `"${v}"`).join(', ')} ` +
        'with a lagging reader. Read the result from db.writer.',
    );
  }
  return response;
}
