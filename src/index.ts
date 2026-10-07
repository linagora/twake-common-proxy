import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';

const config = loadConfig(process.env.CONFIG_FILE ?? 'config.yaml');
const logger = createLogger(config.logLevel);
const app = await buildServer({ config, logger });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

await app.listen({ host: config.server.host, port: config.server.port });
