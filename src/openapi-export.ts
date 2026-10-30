import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatSpec, generateOpenApiSpec, OPENAPI_FILE } from './openapi.js';

/**
 * Writes openapi.json at the repo root: npm run openapi. Run it after changing any route schema
 * and commit the file; a test fails while the committed file is out of date.
 */
generateOpenApiSpec().then(
  (spec) => {
    // A fixed path inside the repo, not user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(OPENAPI_FILE, formatSpec(spec));
    process.stdout.write(`wrote ${fileURLToPath(OPENAPI_FILE)}\n`);
  },
  (err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  },
);
