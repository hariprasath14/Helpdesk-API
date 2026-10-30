import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['src/test/global-setup.ts'],
    // Tests run against a real database and sign real workspaces up; on a busy machine with every
    // file in parallel 5 seconds is too tight.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entry points are exercised by running them; migrations by the up/down round trip in global setup.
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/server.ts',
        'src/worker.ts',
        'src/db/migrate.ts',
        'src/openapi-export.ts',
        'src/db/migrations/**',
      ],
      // The pipeline fails if coverage drops below these. Raise them as the codebase grows; never lower them.
      thresholds: { statements: 90, branches: 75, functions: 90, lines: 90 },
    },
  },
});
