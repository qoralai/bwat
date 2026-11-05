import { buildApp } from './app.ts';
import { loadConfig, PORT } from './config.ts';

const app = buildApp({ config: loadConfig(), logStream: process.stdout, checkPluginsAtStart: true });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: '0.0.0.0', port: PORT });
