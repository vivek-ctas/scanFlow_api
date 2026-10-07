import mongoose from 'mongoose';
import config from './config/config.js';
import { logger } from './config/logger.js';
import { setSystemErrorModel } from './utils/system-error.handler.js';
import { SystemError, Usage } from './models/index.js';
import {
  startWebhookWorker,
  sweepWebhookBatches,
} from './queues/webhook.worker.js';
import { reconcileScanUsage } from './services/quota.service.js';
import { normalizeAllQueuePriorities } from './services/subscription.service.js';
import {
  runSubscriptionExpiryJob,
  runSubscriptionReminderJob,
} from './cron/subscription/index.js';

let worker: Awaited<ReturnType<typeof startWebhookWorker>> | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let activationTimer: NodeJS.Timeout | null = null;
let reminderTimer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let webhookBatchTimer: NodeJS.Timeout | null = null;

const reconcile = async () => {
  try {
    const results = await reconcileScanUsage();
    logger.info(`[RECONCILE] updated ${results.length} organizations`);
  } catch (err: any) {
    logger.error(`[RECONCILE] failed: ${err.message}`);
  }
};

const everyMinute = async () => {
  await runSubscriptionExpiryJob();
};

const everyHalfHour = async () => {
  await runSubscriptionReminderJob();
};

const everyHour = async () => {
  try {
    const expired = await Usage.deleteMany({
      purge_after: { $lte: new Date() },
    });
    logger.info(
      `[PURGE] removed ${expired.deletedCount} usage rows past retention`,
    );
  } catch (err: any) {
    logger.error(`[PURGE] usage purge failed: ${err.message}`);
  }
};

const start = async () => {
  setSystemErrorModel(SystemError);
  mongoose.set('strictQuery', false);
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  logger.info('Worker connected to MongoDB');

  worker = await startWebhookWorker();
  logger.info('Webhook worker ready');

  // Boot maintenance (§12): repack queue priorities, then run an activation +
  // reconciliation pass before the periodic loops take over.
  await normalizeAllQueuePriorities();
  await everyMinute();
  await reconcile();
  await everyHalfHour();
  reconcileTimer = setInterval(reconcile, 30_000);
  activationTimer = setInterval(everyMinute, 60_000);
  reminderTimer = setInterval(everyHalfHour, 1_800_000);
  purgeTimer = setInterval(everyHour, 3_600_000);
  webhookBatchTimer = setInterval(
    () =>
      sweepWebhookBatches().catch((err: any) =>
        logger.error(`[WEBHOOK] batch sweep failed: ${err.message}`),
      ),
    1000,
  );
};

const shutdown = async () => {
  logger.info('Shutting down worker');
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
  }
  if (activationTimer) {
    clearInterval(activationTimer);
  }
  if (reminderTimer) {
    clearInterval(reminderTimer);
  }
  if (purgeTimer) {
    clearInterval(purgeTimer);
  }
  if (webhookBatchTimer) {
    clearInterval(webhookBatchTimer);
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
