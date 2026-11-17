import { Usage } from '../../models/index.js';
import { activateEligibleSubscriptions } from '../../services/subscription.service.js';
import { sendSubscriptionExpiryReminders } from '../subscription/subscription-reminder.cron.js';
import { runAutoCloseJob } from '../../services/support.service.js';
import type { CronJobDefinition } from './types.js';

/**
 * Code-owned job registry — the only source of job identity and defaults.
 *
 * The four jobs are the existing worker loops exposed through the management
 * API. Sub-minute loops (quota reconcile, webhook sweep, heartbeat) stay
 * internal and are intentionally not registered.
 */
export const JOB_REGISTRY: CronJobDefinition[] = [
  {
    id: 'subscription_expiry',
    name: 'Subscription Expiry',
    description:
      'Flips overdue active subscriptions to expired and promotes queued successors.',
    defaultExpression: '* * * * *',
    defaultTimezone: 'UTC',
    concurrentSafe: false,
    capabilities: {
      start: true,
      stop: true,
      run: true,
      update_schedule: true,
    },
    handler: async () => {
      await activateEligibleSubscriptions();
      return 'subscription expiry sweep completed';
    },
  },
  {
    id: 'subscription_reminders',
    name: 'Subscription Reminders',
    description:
      'Sends expiry reminder emails for the 7/3/1/0-day UTC windows.',
    defaultExpression: '*/30 * * * *',
    defaultTimezone: 'UTC',
    concurrentSafe: false,
    capabilities: {
      start: true,
      stop: true,
      run: true,
      update_schedule: true,
    },
    handler: async () => {
      const sent = await sendSubscriptionExpiryReminders();
      return `expiry reminders sent: ${sent}`;
    },
  },
  {
    id: 'usage_purge',
    name: 'Usage Purge',
    description: 'Deletes usage rows whose retention date has passed.',
    defaultExpression: '0 * * * *',
    defaultTimezone: 'UTC',
    concurrentSafe: false,
    capabilities: {
      start: true,
      stop: true,
      run: true,
      update_schedule: true,
    },
    handler: async () => {
      const result = await Usage.deleteMany({
        purge_after: { $lte: new Date() },
      });
      return `removed ${result.deletedCount} usage row(s)`;
    },
  },
  {
    id: 'support_auto_close',
    name: 'Support Auto Close',
    description:
      'Closes resolved support tickets that have been idle past the configured window.',
    defaultExpression: '0 * * * *',
    defaultTimezone: 'UTC',
    concurrentSafe: false,
    capabilities: {
      start: true,
      stop: true,
      run: true,
      update_schedule: true,
    },
    handler: async () => {
      const closed = await runAutoCloseJob();
      return `closed ${closed} support ticket(s)`;
    },
  },
];

export const findJob = (jobId: string): CronJobDefinition | undefined =>
  JOB_REGISTRY.find((job) => job.id === jobId);
