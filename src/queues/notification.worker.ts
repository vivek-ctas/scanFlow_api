import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import {
  dispatchAppNotification,
  type AppNotificationJob,
} from './notification.queue.js';

const processor = async (job: Job<AppNotificationJob>) => {
  const data = job.data as AppNotificationJob;
  try {
    await dispatchAppNotification(data);
    logger.info(`[NOTIFICATION] job ${job.id} processed`);
  } catch (err: any) {
    logger.error(`[NOTIFICATION] job ${job.id} failed: ${err.message}`);
    throw err;
  }
};

/**
 * BullMQ worker for `app-notifications` (plan §5.1): concurrency 5, retries and
 * backoff are set on the producer side when the job is added.
 */
export const startNotificationWorker = async () => {
  if (!isRedisConfigured()) {
    logger.warn(
      '[WORKER] REDIS_URL not configured; notification worker disabled',
    );
    return null;
  }

  const connection = new Redis(config.redis.url!, {
    maxRetriesPerRequest: null,
  });
  const worker = new Worker('app-notifications', processor as any, {
    connection,
    concurrency: 5,
  });

  worker.on('failed', (job: any, err: Error) => {
    logger.error(`[NOTIFICATION] job ${job?.id ?? '?'} failed: ${err.message}`);
  });
  worker.on('error', (err: Error) => {
    logger.error(`[NOTIFICATION] worker error: ${err.message}`);
  });

  return worker;
};
