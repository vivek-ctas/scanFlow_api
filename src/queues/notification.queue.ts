import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import {
  SupportTicket,
  Organization,
  User,
  Notification,
} from '../models/index.js';
import * as notificationService from '../services/notification.service.js';

export type SupportAppNotificationEvent =
  'ticket_created' | 'customer_replied' | 'staff_replied' | 'status_changed';

export interface SupportAppNotificationJob {
  source: 'support';
  event: SupportAppNotificationEvent;
  ticket_id: string;
  message_id?: string | null;
  status?: string | null;
}

export interface DirectAppNotificationJob {
  source?: 'direct';
  user_ids: string[];
  type: string;
  severity: string;
  title: string;
  message: string;
  action_url?: string;
  dedupe_key?: string;
}

/**
 * Organization daily-limit alert. The scan path only enqueues this small job;
 * the worker resolves the active organization admins and writes the in-app
 * notification. Keeping recipient resolution in the worker means a scan never
 * performs an extra Mongo query.
 */
export interface DailyQuotaAlertJob {
  source: 'daily_quota';
  organization_id: string;
  level: 'near' | 'limit';
  day_key: string;
  used: number;
  limit: number;
  reset_at: string;
  timezone: string;
}

export type AppNotificationJob =
  SupportAppNotificationJob | DirectAppNotificationJob | DailyQuotaAlertJob;

const activeUserIds = async (
  filter: Record<string, any>,
): Promise<string[]> => {
  const users = await User.find({ ...filter, status: 1 })
    .select('_id')
    .lean();
  return users.map((user: any) => String(user._id));
};

/**
 * Pick the in-app recipients for a support event. Mirrors the recipients the
 * email worker already uses, but resolves user ids instead of email addresses.
 */
const resolveSupportRecipients = async (
  job: SupportAppNotificationJob,
  ticket: any,
): Promise<string[]> => {
  if (job.event === 'ticket_created') {
    return activeUserIds({ role: 'SUPER_ADMIN' });
  }

  if (job.event === 'customer_replied') {
    if (ticket.assigned_to) {
      const assignee = await User.findOne({
        _id: ticket.assigned_to,
        status: 1,
      })
        .select('_id')
        .lean();
      if (assignee) return [String((assignee as any)._id)];
    }
    return activeUserIds({ role: 'SUPER_ADMIN' });
  }

  // staff_replied / status_changed → notify the ticket creator.
  if (!ticket.created_by) return [];
  const creator = await User.findOne({ _id: ticket.created_by, status: 1 })
    .select('_id')
    .lean();
  return creator ? [String((creator as any)._id)] : [];
};

interface SupportNotificationContent {
  title: string;
  message: string;
  dedupe_key: string;
}

const buildSupportContent = async (
  job: SupportAppNotificationJob,
  ticket: any,
): Promise<SupportNotificationContent> => {
  const ticketId = String(ticket._id);
  const ticketNo = ticket.ticket_no;
  const subject = String(ticket.subject || '').slice(0, 200);

  let organizationName = 'ScanFlow';
  if (ticket.organization_id) {
    const organization = await Organization.findById(ticket.organization_id)
      .select('company_name')
      .lean();
    if (organization?.company_name) {
      organizationName = organization.company_name;
    }
  }

  switch (job.event) {
    case 'ticket_created':
      return {
        title: `New support ticket ${ticketNo}`,
        message: `${organizationName}: ${subject}`,
        dedupe_key: `support:${ticketId}`,
      };
    case 'customer_replied':
      return {
        title: `New reply on ${ticketNo}`,
        message: `${organizationName}: ${subject}`,
        dedupe_key: `support:${ticketId}`,
      };
    case 'staff_replied':
      return {
        title: 'ScanFlow Support replied',
        message: `New reply on ${ticketNo}: ${subject}`,
        dedupe_key: `support:${ticketId}`,
      };
    case 'status_changed': {
      const status = job.status || ticket.status;
      const resolved = status === 'resolved';
      return {
        title: `Ticket ${ticketNo} ${resolved ? 'resolved' : 'closed'}`,
        message: resolved
          ? `Your ticket ${ticketNo} has been resolved.`
          : `Your ticket ${ticketNo} has been closed.`,
        dedupe_key: `support:${ticketId}:status:${status}`,
      };
    }
  }
};

/** Formats the next business midnight in the alert's timezone ("12:00 AM IST"). */
export const formatDailyResetLabel = (
  resetAt: string,
  timezone: string,
): string => {
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const parts = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
    timeZoneName: 'short',
  }).formatToParts(date);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const period = value('dayPeriod').toUpperCase();
  return `${value('hour')}:${value('minute')} ${period} ${value('timeZoneName')}`.trim();
};

const buildDailyQuotaContent = (
  job: DailyQuotaAlertJob,
): { title: string; message: string } => {
  const resetLabel = formatDailyResetLabel(job.reset_at, job.timezone);
  const suchThat = resetLabel
    ? ` until ${resetLabel}`
    : ' until the limit resets';
  if (job.level === 'limit') {
    return {
      title: 'Daily scan limit reached',
      message:
        `Your organization has reached its daily scan limit (${job.used} of ` +
        `${job.limit} scans today). New scans are rejected${suchThat}.`,
    };
  }
  const pct = job.limit > 0 ? Math.round((job.used / job.limit) * 100) : 100;
  return {
    title: 'Daily scan limit nearly reached',
    message:
      `Your organization has used ${job.used} of ${job.limit} scans today ` +
      `(${pct}%). Scanning stops when the daily limit is reached.` +
      (resetLabel ? ` Resets at ${resetLabel}.` : ''),
  };
};

const dispatchDailyQuotaAlert = async (
  job: DailyQuotaAlertJob,
): Promise<any[]> => {
  const admins = await User.find({
    role: 'ORGANIZATION_ADMIN',
    organization_id: job.organization_id,
    status: 1,
  })
    .select('_id')
    .lean();

  if (!admins.length) {
    logger.warn(
      `[NOTIFICATION] no active organization admins for ${job.organization_id}; daily alert skipped`,
    );
    return [];
  }

  const content = buildDailyQuotaContent(job);

  return notificationService.createForUsers({
    user_ids: admins.map((admin: any) => String(admin._id)),
    organization_id: job.organization_id,
    type: 'quota_alert',
    severity: job.level === 'limit' ? 'critical' : 'warning',
    title: content.title,
    message: content.message,
    action_url: '/',
    // Date + level: one alert per level per day per organization.
    dedupe_key: `daily:${job.organization_id}:${job.day_key}:${job.level}`,
  });
};

/**
 * Resolve and write an app notification immediately. This is called by the
 * producers (and by the worker) so a database row is guaranteed even when the
 * separate worker process is not running.
 */
export const dispatchAppNotification = async (
  job: AppNotificationJob,
): Promise<any[]> => {
  if ('source' in job && job.source === 'daily_quota') {
    return dispatchDailyQuotaAlert(job);
  }

  if (!('source' in job) || job.source !== 'support') {
    return notificationService.createForUsers({
      user_ids: job.user_ids,
      type: job.type as any,
      severity: job.severity as any,
      title: job.title,
      message: job.message,
      action_url: job.action_url,
      dedupe_key: job.dedupe_key,
    });
  }

  const ticket = await SupportTicket.findById(job.ticket_id).lean();
  if (!ticket) {
    logger.warn(
      `[NOTIFICATION] support ticket ${job.ticket_id} not found; skipping`,
    );
    return [];
  }

  const userIds = await resolveSupportRecipients(job, ticket);
  if (!userIds.length) {
    logger.warn(
      `[NOTIFICATION] no active recipients for ${job.event} on ticket ${job.ticket_id}`,
    );
    return [];
  }

  const content = await buildSupportContent(job, ticket);

  return notificationService.createForUsers({
    user_ids: userIds,
    type: 'support_ticket',
    severity: 'info',
    title: content.title,
    message: content.message,
    action_url: `/support/${String(ticket._id)}`,
    dedupe_key: content.dedupe_key,
  });
};

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

let queue: Queue | null = null;

/**
 * Returns the BullMQ Queue instance for app-notifications.
 * Creates it once and reuses it (singleton pattern, matching support.queue.ts).
 */
export const getNotificationQueue = (): Queue => {
  if (!queue) {
    const connection = new Redis(config.redis.url || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    queue = new Queue('app-notifications', { connection });
    queue.on('error', (err) => {
      logger.error(`[QUEUE] app-notifications error: ${err.message}`);
    });
  }
  return queue;
};

/** Enqueue an app-notification job (retry/backoff for the worker). */
export const enqueueAppNotification = async (
  job: AppNotificationJob,
): Promise<Job | null> => {
  if (!isRedisConfigured()) {
    logger.warn(
      '[QUEUE] REDIS_URL not configured; app notification enqueue skipped',
    );
    return null;
  }

  const q = getNotificationQueue();
  const id =
    job.source === 'support'
      ? `app:${job.event}:${job.ticket_id}:${job.message_id || job.status || 'event'}`
      : job.source === 'daily_quota'
        ? `daily-${job.organization_id}-${job.day_key}-${job.level}`
        : undefined;

  return q.add('app', job, {
    jobId: id,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
};

export interface DailyQuotaAlertInput {
  organization_id: string;
  level: 'near' | 'limit';
  day_key: string;
  used: number;
  limit: number;
  reset_at: string;
  timezone: string;
}

/**
 * Fire-and-forget enqueue for an organization daily-limit alert. The scan
 * result never depends on the queue: callers do `void enqueueDailyQuotaAlert()`
 * and every failure is logged and swallowed here. The `enqueue` parameter is
 * injectable so the failure path can be tested without breaking Redis.
 */
export const enqueueDailyQuotaAlert = (
  input: DailyQuotaAlertInput,
  enqueue: (
    job: AppNotificationJob,
  ) => Promise<unknown> = enqueueAppNotification,
): Promise<unknown> =>
  enqueue({ source: 'daily_quota', ...input }).catch((err: any) => {
    logger.error(
      `[QUEUE] daily quota alert enqueue failed for ${input.organization_id}: ${err.message}`,
    );
    return null;
  });

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

// Re-exported for callers that want to query notifications in tests/tools.
export { Notification };
