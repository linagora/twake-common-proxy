import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env.CONFIG_FILE ?? 'config.yaml');
const logger = createLogger(config.logLevel);
const app = await buildServer({ config, logger });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    app.drain();
    // Kubernetes keeps routing to a terminating pod until its endpoints update.
    sleep(config.server.shutdownDelaySeconds * 1000)
      .then(() => app.close())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}

await app.listen({ host: config.server.host, port: config.server.port });
