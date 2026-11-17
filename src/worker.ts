import mongoose from 'mongoose';
import config from './config/config.js';
import { logger } from './config/logger.js';
import { setSystemErrorModel } from './utils/system-error.handler.js';
import { SystemError, SystemLog } from './models/index.js';
import { setSystemLogModel } from './utils/system-log.js';
import {
  startWebhookWorker,
  sweepWebhookBatches,
} from './queues/webhook.worker.js';
import { startSupportWorker } from './queues/support.worker.js';
import { startNotificationWorker } from './queues/notification.queue.js';
import { reconcileScanUsage } from './services/quota.service.js';
import { normalizeAllQueuePriorities } from './services/subscription.service.js';
import { getRedis, isRedisConfigured } from './queues/redis.js';
import { cronManager } from './cron/management/manager.js';

let worker: Awaited<ReturnType<typeof startWebhookWorker>> | null = null;
let supportWorker: Awaited<ReturnType<typeof startSupportWorker>> | null = null;
let notificationWorker: Awaited<
  ReturnType<typeof startNotificationWorker>
> | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
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

  // Boot maintenance (§12): repack queue priorities, then run a reconciliation
  // pass before the periodic loops take over. Product crons are owned by the
  // CronZivo scheduler below; the API process only persists their schedules.
  await normalizeAllQueuePriorities();
  await reconcile();
  reconcileTimer = setInterval(reconcile, 30_000);

  await cronManager.start();

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
  if (webhookBatchTimer) {
    clearInterval(webhookBatchTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  await cronManager.stop();
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
