import { createGateway, loadConfig } from '@codexapp/host-gateway';

const config = loadConfig();
const app = await createGateway(config);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exitCode = 0;
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await app.listen({ host: config.host, port: config.port });
