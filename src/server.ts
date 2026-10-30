import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config/index.js';
import { createDatabase } from './db/index.js';
import { startLive } from './modules/live/live.server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main() {
  const config = loadConfig();
  const db = createDatabase(config);
  const app = await buildApp(config, { db });
  // Live updates (F26) share the API's server and address (/socket.io).
  const live = await startLive(app.server, { config, db }, app.log);

  // ECS sends SIGTERM before stopping a task: finish in-flight requests, then exit.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      app.log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    live
      .close()
      .then(() => app.close())
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ err }, 'error during shutdown');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (bad config), so write directly to stderr.
  process.stderr.write(`${err instanceof ConfigError ? err.message : String(err)}\n`);
  if (!(err instanceof ConfigError) && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
