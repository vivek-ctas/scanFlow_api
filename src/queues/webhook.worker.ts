import crypto from 'crypto';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import { WebhookConfig, WebhookDelivery, Scan } from '../models/index.js';

export interface ScanWebhookJobData {
  event_id: string;
  scan_id: string;
  organization_id: string;
}

const buildSignature = (secret: string, body: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

// Batched re-delivery backoff between attempts (first attempt uses the debounce
// window); retryLimit comes from the webhook config / config.defaults.
const BATCH_BACKOFF_MS = 8000;

let lockClient: Redis | null = null;

const getLockClient = (): Redis => {
  if (!lockClient) {
    lockClient = new Redis(config.redis.url!, {
      maxRetriesPerRequest: null,
    });
  }
  return lockClient;
};

const acquireOrgBatchLock = async (
  organizationId: string,
): Promise<boolean> => {
  try {
    const result = await getLockClient().set(
      `webhook-batch:lock:${organizationId}`,
      '1',
      'PX',
      1500,
      'NX',
    );
    return result === 'OK';
  } catch (err: any) {
    logger.error(
      `[WEBHOOK] lock acquire failed for ${organizationId}: ${err.message}`,
    );
    return true; // fail open; the pending-status claim still prevents double-sends
  }
};

const isBatchDue = (
  pending: any[],
  batchSize: number,
  debounceMs: number,
  now: number,
): boolean => {
  if (!pending.length) {
    return false;
  }
  if (pending.length >= batchSize) {
    return true;
  }
  let waitUntil = 0;
  for (const row of pending) {
    const anchor =
      row.retry_count > 0 && row.last_attempt_at
        ? row.last_attempt_at.getTime()
        : row.created_at.getTime();
    waitUntil = Math.max(
      waitUntil,
      anchor + (row.retry_count > 0 ? BATCH_BACKOFF_MS : debounceMs),
    );
  }
  return now >= waitUntil;
};

/** Claims up to one batch of pending deliveries for an org (atomic on status). */
const claimPendingBatch = async (
  organizationId: string,
  batchSize: number,
): Promise<any[]> => {
  const pending = await WebhookDelivery.find({
    organization_id: organizationId,
    status: 'pending',
  })
    .sort({ created_at: 1 })
    .limit(batchSize);
  if (!pending.length) {
    return [];
  }
  if (
    !isBatchDue(pending, batchSize, config.webhook.batchDebounceMs, Date.now())
  ) {
    return [];
  }
  const ids = pending.map((row) => row._id);
  await WebhookDelivery.updateMany(
    { _id: { $in: ids }, status: 'pending' },
    {
      $set: { status: 'processing', last_attempt_at: new Date() },
      $inc: { retry_count: 1 },
    },
  );
  return WebhookDelivery.find({ _id: { $in: ids }, status: 'processing' });
};

const markDelivered = async (ids: any[]) => {
  await WebhookDelivery.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        status: 'delivered',
        delivered_at: new Date(),
        last_error: undefined,
      },
    },
  );
};

const markBatchFailed = async (rows: any[], retryLimit: number) => {
  for (const row of rows) {
    if (row.retry_count >= retryLimit) {
      row.status = 'failed';
      await row.save();
    } else {
      row.status = 'pending'; // backoff is enforced via last_attempt_at on the next pass
      await row.save();
    }
  }
};

const sendBatchForOrg = async (organizationId: string, claimed: any[]) => {
  const configDoc = await WebhookConfig.findOne({
    organization_id: organizationId,
    enabled: true,
  }).select('+secret');
  if (!configDoc) {
    for (const row of claimed) {
      row.status = 'failed';
      row.last_error = 'No enabled webhook config for organization';
      await row.save();
    }
    logger.warn(
      `[WEBHOOK] batch for ${organizationId} failed: no enabled config (${claimed.length} events)`,
    );
    return;
  }

  const scanIds = claimed.map((row) => row.scan_id);
  const scans = await Scan.find({ _id: { $in: scanIds } });
  const byId = new Map(scans.map((s) => [String(s._id), s]));

  const events = claimed.map((row) => {
    const scan = byId.get(String(row.scan_id));
    return {
      event_id: row.event_id,
      scan_id: String(row.scan_id),
      organization_id: String(organizationId),
      barcode: scan?.barcode ?? null,
      barcode_type: scan?.barcode_type ?? null,
      device_id: scan?.device_id ?? null,
      scanned_at: scan?.scanned_at ?? null,
    };
  });
  const body = JSON.stringify({ events });
  const timeoutMs = configDoc.timeout_ms || config.webhook.timeoutMs;
  const retryLimit = configDoc.retry_limit || config.webhook.retryLimit;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (configDoc.secret) {
      headers['x-scanflow-signature'] = buildSignature(configDoc.secret, body);
    }
    const res = await fetch(configDoc.endpoint_url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Webhook responded ${res.status}`);
    }
    await markDelivered(claimed.map((row) => row._id));
    logger.info(
      `[WEBHOOK] delivered batch of ${claimed.length} events to ${organizationId}`,
    );
  } catch (err: any) {
    clearTimeout(timer);
    const message =
      err?.name === 'AbortError'
        ? 'Webhook timed out'
        : (err?.message ?? 'Webhook delivery failed');
    for (const row of claimed) {
      row.last_error = message;
    }
    await markBatchFailed(claimed, retryLimit);
    logger.error(
      `[WEBHOOK] batch for ${organizationId} failed (${claimed.length} events): ${message}`,
    );
  }
};

/**
 * One batch flush for an org (debounce + batchSize gated). Used both by the
 * per-event BullMQ jobs and the periodic sweep. Only one actor at a time wins
 * the org lock; the others no-op.
 */
export const flushOrgBatches = async (organizationId: string) => {
  if (!isRedisConfigured()) {
    logger.warn('[WEBHOOK] REDIS_URL not configured; batch delivery disabled');
    return;
  }
  if (!(await acquireOrgBatchLock(organizationId))) {
    return;
  }
  try {
    const configDoc = await WebhookConfig.findOne({
      organization_id: organizationId,
      enabled: true,
    }).select('+secret');
    const batchSize = configDoc?.batch_size || config.webhook.batchSize || 100;
    const claimed = await claimPendingBatch(organizationId, batchSize);
    if (!claimed.length) {
      return;
    }
    await sendBatchForOrg(organizationId, claimed);
  } finally {
    try {
      await getLockClient().del(`webhook-batch:lock:${organizationId}`);
    } catch {
      // lock expiry guards the rare release failure
    }
  }
};

/** Periodic sweep: every org with pending deliveries gets a flush attempt. */
export const sweepWebhookBatches = async () => {
  const orgIds = await WebhookDelivery.distinct('organization_id', {
    status: 'pending',
  });
  for (const orgId of orgIds) {
    await flushOrgBatches(String(orgId));
  }
};

const processor = async (job: Job) => {
  const { organization_id } = job.data as ScanWebhookJobData;
  await flushOrgBatches(organization_id);
};

export const startWebhookWorker = async () => {
  if (!isRedisConfigured()) {
    logger.warn('[WORKER] REDIS_URL not configured; webhook worker disabled');
    return null;
  }

  const connection = new Redis(config.redis.url!, {
    maxRetriesPerRequest: null,
  });
  const worker = new Worker('webhook-delivery', processor as any, {
    connection,
    concurrency: config.webhook.workerConcurrency,
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[WEBHOOK] job ${job?.id ?? '?'} failed: ${err.message}`);
  });
  worker.on('completed', (job: Job) => {
    logger.info(`[WEBHOOK] job ${job.id} completed`);
  });
  worker.on('error', (err) => {
    logger.error(`[WEBHOOK] worker error: ${err.message}`);
  });

  return worker;
};
