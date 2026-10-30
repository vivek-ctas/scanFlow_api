import { Worker, Job } from 'bullmq';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
interface NotificationJob {
  user_id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  action_url?: string;
  dedupe_key?: string;
}

const processor = async (job: Job<NotificationJob>) => {
  const data = job.data as NotificationJob;
  try {
    await mongoose.model('tbl_notification').create({
      user_id: new mongoose.Types.ObjectId(data.user_id),
      type: data.type,
      severity: data.severity,
      title: data.title,
      message: data.message,
      action_url: data.action_url,
      dedupe_key: data.dedupe_key,
      expires_at: new Date(Date.now() + 90 * 86400000),
      is_read: false,
    });
    logger.info(
      `[NOTIFICATION] job ${job.id} created notification for user ${data.user_id}`,
    );
  } catch (err: any) {
    logger.error(`[NOTIFICATION] job ${job.id} failed: ${err.message}`);
    throw err;
  }
};

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
