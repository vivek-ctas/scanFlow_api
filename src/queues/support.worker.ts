import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { isRedisConfigured } from './redis.js';
import { SupportTicket, User } from '../models/index.js';
import { sendSupportNotificationEmail } from '../services/email.service.js';
import type { SupportNotificationJob } from './support.queue.js';

const parseList = (value: string | undefined): string[] =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const activeSuperAdminEmails = async (): Promise<string[]> => {
  const admins = await User.find({ role: 'SUPER_ADMIN', status: 1 })
    .select('email')
    .lean();
  return admins
    .map((admin: any) => admin.email)
    .filter((email: string): email is string => Boolean(email));
};

const resolveRecipients = async (
  data: SupportNotificationJob,
  ticket: any,
): Promise<string[]> => {
  if (data.event === 'ticket_created' || data.event === 'customer_replied') {
    if (data.event === 'customer_replied' && ticket.assigned_to) {
      const assignee = await User.findById(ticket.assigned_to)
        .select('email')
        .lean();
      if (assignee?.email) return [assignee.email];
    }
    const explicit = parseList(config.support.notifyEmails);
    return explicit.length ? explicit : activeSuperAdminEmails();
  }

  // staff_replied / status_changed → notify the ticket creator.
  if (!ticket.created_by) return [];
  const creator = await User.findById(ticket.created_by).select('email').lean();
  return creator?.email ? [creator.email] : [];
};

const processor = async (job: Job) => {
  const data = job.data as SupportNotificationJob;
  const ticket = await SupportTicket.findById(data.ticket_id).lean();
  if (!ticket) {
    logger.warn(`[SUPPORT] notification for missing ticket ${data.ticket_id}`);
    return;
  }

  const recipients = [...new Set(await resolveRecipients(data, ticket))];
  if (!recipients.length) return;

  const url = `${config.panelUrl}/support/${String(ticket._id)}`;
  for (const to of recipients) {
    await sendSupportNotificationEmail(to, {
      ticket_no: ticket.ticket_no,
      subject: ticket.subject,
      status: ticket.status,
      event: data.event,
      url,
    });
  }
  logger.info(
    `[SUPPORT] ${data.event} notification for ${ticket.ticket_no} sent to ${recipients.length} recipient(s)`,
  );
};

export const startSupportWorker = async () => {
  if (!isRedisConfigured()) {
    logger.warn('[WORKER] REDIS_URL not configured; support worker disabled');
    return null;
  }

  const connection = new Redis(config.redis.url!, {
    maxRetriesPerRequest: null,
  });
  const worker = new Worker('support-notifications', processor as any, {
    connection,
    concurrency: 5,
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(`[SUPPORT] job ${job?.id ?? '?'} failed: ${err.message}`);
  });
  worker.on('error', (err) => {
    logger.error(`[SUPPORT] worker error: ${err.message}`);
  });

  return worker;
};
