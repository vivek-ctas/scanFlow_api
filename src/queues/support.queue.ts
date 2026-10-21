import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';

export type SupportNotificationEvent =
  | 'ticket_created'
  | 'customer_replied'
  | 'staff_replied'
  | 'status_changed';

export interface SupportNotificationJob {
  event: SupportNotificationEvent;
  ticket_id: string;
  message_id?: string | null;
  /** For `status_changed`: the new status, used to select the recipient. */
  status?: string | null;
}

let queue: Queue | null = null;

export const getSupportQueue = (): Queue => {
  if (!queue) {
    const connection = new Redis(config.redis.url || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    queue = new Queue('support-notifications', { connection });
    queue.on('error', (err) => {
      logger.error(`[QUEUE] support-notifications error: ${err.message}`);
    });
  }
  return queue;
};

/**
 * Enqueue a support notification. Mirrors the webhook enqueue: if Redis is not
 * configured it logs and skips, because the ticket/message is always saved
 * first and an email failure must never fail a request.
 */
export const enqueueSupportNotification = async (
  job: SupportNotificationJob,
) => {
  if (!isRedisConfigured()) {
    logger.warn('[QUEUE] REDIS_URL not configured; support enqueue skipped');
    return null;
  }
  const q = getSupportQueue();
  const suffix = job.message_id || job.status || 'status';
  return q.add(job.event, job, {
    jobId: `${job.event}:${job.ticket_id}:${suffix}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
};
