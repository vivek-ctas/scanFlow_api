import { activateEligibleSubscriptions } from '../../services/subscription.service.js';
import { withCronRun } from '../cron-runner.js';

/**
 * Expiry sweep for the subscription cron (worker EVERY_MINUTE): flips overdue
 * active subscriptions to `expired` (flushing the quota cache and dispatching
 * the "subscription ended" email) and promotes the earliest queued successor
 * when no active subscription remains. The business logic lives in
 * services/subscription.service.js; this wrapper adds no-overlap + logging.
 */
export const runSubscriptionExpiryJob = (): Promise<void | undefined> =>
  withCronRun('subscription-expiry', () => activateEligibleSubscriptions());
