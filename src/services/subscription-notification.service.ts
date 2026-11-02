import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { Subscription, ISubscription } from '../models/subscription.model.js';
import { User } from '../models/user.model.js';
import { createForUsers } from './notification.service.js';
import {
  subscriptionExpiredTemplate,
  subscriptionReminderTemplate,
} from './notification-templates.js';

const DAY_MS = 86_400_000;

const activeAdminIds = async (organizationId: string): Promise<string[]> => {
  const admins = await User.find({
    role: 'ORGANIZATION_ADMIN',
    organization_id: organizationId,
    status: 1,
  })
    .select('_id')
    .lean();
  return admins.map((admin: any) => String(admin._id));
};

/** Configured in-app reminder windows, most distant first (`7,1`). */
const reminderWindows = (): number[] =>
  String(config.notification?.subscriptionReminderDays ?? '7,1')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);

/**
 * In-app expiry notice (plan §5.3). Called only after the promotion loop found
 * no successor, at which point scanning is blocked.
 */
export const notifySubscriptionExpired = async (
  sub: ISubscription,
): Promise<void> => {
  const userIds = await activeAdminIds(String(sub.organization_id));
  if (!userIds.length) return;

  const content = subscriptionExpiredTemplate();

  console.log(
    '[DEBUG] notifySubscriptionExpired: sending to %d admins for sub %s',
    userIds.length,
    sub._id,
  );

  await createForUsers({
    user_ids: userIds,
    type: 'subscription',
    severity: content.severity,
    title: content.title,
    message: content.message,
    action_url: content.action_url,
    dedupe_key: `subscription:${String(sub._id)}:expired`,
    organization_id: String(sub.organization_id),
  });

  logger.info(
    `[NOTIFICATION] expiry notice sent to ${userIds.length} admin(s) for org ${String(sub.organization_id)}`,
  );
};

/**
 * In-app reminders at the configured windows (default 7 and 1 days). Uses the
 * additive `app_reminders_sent` array so the existing email cron's
 * `reminders_sent` contract is untouched. Safe to run in more than one worker:
 * the conditional `$addToSet` update is the lock.
 */
export const checkSubscriptionReminders = async (): Promise<number> => {
  const windows = reminderWindows();
  if (!windows.length) return 0;

  const now = new Date();
  const maxDays = windows[0]!;

  console.log(
    '[DEBUG] checkSubscriptionReminders: windows=%j, maxDays=%s',
    windows,
    maxDays,
  );

  const candidates = await Subscription.find({
    status: 'active',
    expires_at: {
      $gt: now,
      $lte: new Date(now.getTime() + maxDays * DAY_MS),
    },
  }).select(
    'organization_id plan_name started_at expires_at app_reminders_sent',
  );

  let sent = 0;

  for (const sub of candidates) {
    const remainingMs = sub.expires_at.getTime() - now.getTime();
    if (remainingMs <= 0) continue;

    const totalDays =
      (sub.expires_at.getTime() - sub.started_at.getTime()) / DAY_MS;

    // Most urgent applicable window. Short subscriptions skip larger windows.
    const applicable = windows.filter(
      (days) => remainingMs <= days * DAY_MS && totalDays > days,
    );
    if (!applicable.length) continue;
    const days = applicable[applicable.length - 1]!;

    console.log(
      '[DEBUG] checkSubscriptionReminders: sub %s remainingMs=%s totalDays=%s applicable=%j days=%s',
      sub._id,
      remainingMs,
      totalDays,
      applicable,
      days,
    );

    // Mark this window (and every larger one) as sent atomically; only the
    // winner writes the notification.
    const claimed = await Subscription.findOneAndUpdate(
      { _id: sub._id, app_reminders_sent: { $ne: days } },
      {
        $addToSet: {
          app_reminders_sent: { $each: windows.filter((w) => w >= days) },
        },
      },
      { new: true },
    );
    if (!claimed) continue;

    const userIds = await activeAdminIds(String(sub.organization_id));
    if (!userIds.length) continue;

    const queuedNext = await Subscription.exists({
      organization_id: sub.organization_id,
      status: 'future',
    });

    const planName = sub.plan_name || 'Your plan';
    const content = subscriptionReminderTemplate({
      days,
      planName,
      queuedNextPlan: Boolean(queuedNext),
    });

    console.log(
      '[DEBUG] checkSubscriptionReminders: creating notification for sub %s days=%s userIds=%j',
      sub._id,
      days,
      userIds,
    );

    await createForUsers({
      user_ids: userIds,
      type: 'subscription',
      severity: content.severity,
      title: content.title,
      message: content.message,
      action_url: content.action_url,
      dedupe_key: `subscription:${String(sub._id)}:reminder:${days}`,
      organization_id: String(sub.organization_id),
    });

    sent += 1;
    logger.info(
      `[NOTIFICATION] ${days}-day reminder sent for sub ${String(sub._id)}`,
    );
  }

  return sent;
};
