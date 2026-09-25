import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';

export interface ScanWebhookJobPayload {
  eventId: string;
  scanId: string;
  organizationId: string;
}

let queue: Queue | null = null;

export const getWebhookQueue = (): Queue => {
  if (!queue) {
    const connection = new Redis(config.redis.url || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    queue = new Queue('webhook-delivery', { connection });
    queue.on('error', (err) => {
      logger.error(`[QUEUE] webhook-delivery error: ${err.message}`);
    });
  }
  return queue;
};

export const enqueueScanWebhook = async (job: ScanWebhookJobPayload) => {
  if (!isRedisConfigured()) {
    logger.warn('[QUEUE] REDIS_URL not configured; webhook enqueue skipped');
    return null;
  }
  const q = getWebhookQueue();
  return q.add('scan-created', job, {
    jobId: job.eventId,
    attempts: config.webhook.retryLimit,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
};
