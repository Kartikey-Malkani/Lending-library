import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port} (${config.nodeEnv})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    void prisma.$disconnect().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
