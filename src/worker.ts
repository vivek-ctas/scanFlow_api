import mongoose from 'mongoose';
import config from './config/config.js';
import { logger } from './config/logger.js';
import { setSystemErrorModel } from './utils/system-error.handler.js';
import { SystemError, SystemLog, Usage } from './models/index.js';
import { setSystemLogModel } from './utils/system-log.js';
import {
  startWebhookWorker,
  sweepWebhookBatches,
} from './queues/webhook.worker.js';
import { startSupportWorker } from './queues/support.worker.js';
import { startNotificationWorker } from './queues/notification.queue.js';
import { runAutoCloseJob } from './services/support.service.js';
import { withCronRun } from './cron/cron-runner.js';
import { reconcileScanUsage } from './services/quota.service.js';
import { normalizeAllQueuePriorities } from './services/subscription.service.js';
import { getRedis, isRedisConfigured } from './queues/redis.js';
import {
  runSubscriptionExpiryJob,
  runSubscriptionReminderJob,
} from './cron/subscription/index.js';

let worker: Awaited<ReturnType<typeof startWebhookWorker>> | null = null;
let supportWorker: Awaited<ReturnType<typeof startSupportWorker>> | null = null;
let notificationWorker: Awaited<
  ReturnType<typeof startNotificationWorker>
> | null = null;
let supportAutoCloseTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let activationTimer: NodeJS.Timeout | null = null;
let reminderTimer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let webhookBatchTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

const reconcile = async () => {
  try {
    const results = await reconcileScanUsage();
    logger.info(`[RECONCILE] updated ${results.length} organizations`);
  } catch (err: any) {
    logger.error(`[RECONCILE] failed: ${err.message}`);
  }
};

/** Dashboard liveness signal read by the API's /dashboard/system endpoint. */
const writeHeartbeat = async () => {
  if (!isRedisConfigured()) {
    return;
  }
  try {
    await getRedis().set('worker:heartbeat', String(Date.now()), 'EX', 90);
  } catch (err: any) {
    logger.error(`[HEARTBEAT] failed: ${err.message}`);
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

const autoCloseSupport = async () => {
  try {
    const closed = await withCronRun('support-auto-close', () =>
      runAutoCloseJob(),
    );
    if (closed) {
      logger.info(`[SUPPORT] auto-closed ${closed} resolved ticket(s)`);
    }
  } catch (err: any) {
    logger.error(`[SUPPORT] auto-close failed: ${err.message}`);
  }
};

const start = async () => {
  setSystemErrorModel(SystemError);
  setSystemLogModel(SystemLog);
  mongoose.set('strictQuery', false);
  await mongoose.connect(config.mongoose.url, config.mongoose.options);
  logger.info('Worker connected to MongoDB');

  worker = await startWebhookWorker();
  logger.info('Webhook worker ready');

  supportWorker = await startSupportWorker();
  logger.info('Support worker ready');

  notificationWorker = await startNotificationWorker();
  logger.info('Notification worker ready');

  // Signal liveness immediately and independently of the reconcile loop, so a
  // slow or hung maintenance pass can never suppress the dashboard heartbeat.
  await writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, 30_000);

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
  await autoCloseSupport();
  supportAutoCloseTimer = setInterval(autoCloseSupport, 3_600_000);
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
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (supportAutoCloseTimer) {
    clearInterval(supportAutoCloseTimer);
  }
  if (worker) {
    await worker.close();
  }
  if (supportWorker) {
    await supportWorker.close();
  }
  if (notificationWorker) {
    await notificationWorker.close();
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
