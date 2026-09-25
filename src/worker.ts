import mongoose from 'mongoose';
import config from './config/config.js';
import { logger } from './config/logger.js';
import { setSystemErrorModel } from './utils/system-error.handler.js';
import { SystemError } from './models/index.js';
import { startWebhookWorker } from './queues/webhook.worker.js';
import { reconcileScanUsage } from './services/quota.service.js';

let worker: Awaited<ReturnType<typeof startWebhookWorker>> | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

const reconcile = async () => {
  try {
    const results = await reconcileScanUsage();
    logger.info(`[RECONCILE] updated ${results.length} organizations`);
  } catch (err: any) {
    logger.error(`[RECONCILE] failed: ${err.message}`);
  }
};

const start = async () => {
  setSystemErrorModel(SystemError);
  mongoose.set('strictQuery', false);
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  logger.info('Worker connected to MongoDB');

  worker = await startWebhookWorker();
  logger.info('Webhook worker ready');

  await reconcile();
  reconcileTimer = setInterval(reconcile, 30_000);
};

const shutdown = async () => {
  logger.info('Shutting down worker');
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
  }
  if (worker) {
    await worker.close();
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  process.exit(0);
};

process.on('SIGTERM', () => {
  shutdown();
});
process.on('SIGINT', () => {
  shutdown();
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  shutdown();
});
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', err as any);
  shutdown();
});

start().catch((err) => {
  logger.error('Worker failed to start', err);
  process.exit(1);
});
