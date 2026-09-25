import crypto from 'crypto';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import { WebhookConfig, WebhookDelivery, Scan } from '../models/index.js';

export interface ScanWebhookJobData {
  eventId: string;
  scanId: string;
  organizationId: string;
}

const buildSignature = (secret: string, body: string) =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

const processor = async (job: Job) => {
  const { eventId, scanId, organizationId } = job.data as ScanWebhookJobData;
  const attempt = job.attemptsMade + 1;

  const delivery = await WebhookDelivery.findOneAndUpdate(
    { eventId, status: 'pending' },
    {
      $set: {
        status: 'processing',
        attempts: attempt,
        lastAttemptAt: new Date(),
      },
    },
    { new: true },
  );
  if (!delivery) {
    logger.info(`[WEBHOOK] ${eventId} already handled; skipping`);
    return;
  }

  const configDoc = await WebhookConfig.findOne({
    organizationId,
    enabled: true,
  }).select('+secret');
  if (!configDoc) {
    delivery.status = 'failed';
    delivery.lastError = 'No enabled webhook config for organization';
    await delivery.save();
    logger.warn(`[WEBHOOK] ${eventId} failed: no enabled config`);
    return;
  }

  const scan = await Scan.findById(scanId);
  const payload = {
    eventId,
    scanId,
    organizationId,
    barcode: scan?.barcode,
    barcodeType: scan?.barcodeType ?? null,
    deviceId: scan?.deviceId ?? null,
    scannedAt: scan?.scannedAt ?? null,
  };
  const body = JSON.stringify(payload);
  const timeoutMs = configDoc.timeoutMs || config.webhook.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (configDoc.secret) {
      headers['x-scanflow-signature'] = buildSignature(configDoc.secret, body);
    }
    const res = await fetch(configDoc.endpointUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Webhook responded ${res.status}`);
    }
    delivery.status = 'delivered';
    delivery.deliveredAt = new Date();
    delivery.lastError = undefined;
    await delivery.save();
    logger.info(`[WEBHOOK] ${eventId} delivered`);
    return;
  } catch (err: any) {
    clearTimeout(timer);
    const message =
      err?.name === 'AbortError'
        ? 'Webhook timed out'
        : (err?.message ?? 'Webhook delivery failed');
    delivery.attempts = attempt;
    delivery.lastError = message;
    delivery.status = 'processing';
    await delivery.save();

    const maxAttempts = job.opts.attempts || 1;
    if (attempt >= maxAttempts) {
      delivery.status = 'failed';
      await delivery.save();
      logger.error(
        `[WEBHOOK] ${eventId} failed after ${attempt} attempts: ${message}`,
      );
    }
    throw err;
  }
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
