import { logger } from '../../config/logger.js';
import { Subscription } from '../../models/subscription.model.js';
import { formatEmailDate } from '../../emails/format.utils.js';
import { renderExpiryReminderEmail } from '../../emails/subscription-email.templates.js';
import { sendRenderedEmail } from '../../services/email.service.js';
import {
  panelLoginUrl,
  resolveBranding,
  resolveOrgRecipient,
} from '../../services/subscription-email.service.js';
import { errorHandler } from '../../utils/system-error.handler.js';
import { withCronRun } from '../cron-runner.js';
import {
  endOfUtcDay,
  shiftUtcDay,
  startOfUtcDay,
} from './date-window.utils.js';

/**
 * Calendar-day offsets (in UTC) at which an active subscription gets an expiry
 * reminder. `0` is the day the subscription expires.
 */
export const REMINDER_WINDOW_DAYS = [7, 3, 1, 0];

/**
 * Per-threshold subject lines, adapted from the SaaS subscription cron.
 */
export const buildExpiryReminderSubject = (
  appName: string,
  days: number,
): string => {
  switch (days) {
    case 0:
      return `Your ${appName} plan has expired — reactivate now`;
    case 1:
      return `Last chance — your ${appName} plan expires tomorrow`;
    case 3:
      return `3 days left on your ${appName} subscription`;
    case 7:
      return `Your ${appName} plan expires in 7 days`;
    default:
      return `Your ${appName} plan expires in ${days} days`;
  }
};

/**
 * Reminder sweep for the subscription cron: every active subscription expiring
 * on one of the configured UTC calendar days (7, 3, 1 and 0 days out) gets one
 * reminder per threshold, guarded by the subscription's `reminders_sent` array.
 *
 * The day-0 window only targets subscriptions that are still active on the day
 * of expiry — once the expiry job flips a subscription to `expired` the
 * "subscription ended" email has already been delivered, so no second notice is
 * sent here.
 *
 * A threshold is recorded only when the email was actually delivered ("mark on
 * success"), so a real SMTP failure is retried on the next pass.
 */
export const sendSubscriptionExpiryReminders = async (): Promise<number> => {
  let totalSent = 0;

  for (const days of REMINDER_WINDOW_DAYS) {
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const now = new Date();
      const targetDay = shiftUtcDay(now, days);
      const windowStart = startOfUtcDay(targetDay);
      const windowEnd = endOfUtcDay(targetDay);

      const due = await Subscription.find({
        status: 'active',
        expires_at: { $gte: windowStart, $lte: windowEnd },
      }).select(
        'organization_id plan_name plan_price billing_cycle started_at expires_at reminders_sent marketing_features',
      );

      logger.info(
        `[CRON] expiry-reminders ${days}d window (${windowStart.toISOString()} -> ${windowEnd.toISOString()}) found ${due.length} active subscription(s)`,
      );

      for (const sub of due) {
        if ((sub.reminders_sent || []).includes(days)) {
          skipped += 1;
          continue;
        }

        try {
          const recipient = await resolveOrgRecipient(
            String(sub.organization_id),
          );
          if (!recipient) {
            skipped += 1;
            continue;
          }
          const branding = await resolveBranding();

          const delivered = await sendRenderedEmail(
            recipient.email,
            buildExpiryReminderSubject(branding.appName, days),
            renderExpiryReminderEmail({
              first_name: recipient.firstName,
              plan_name: sub.plan_name || 'Your Plan',
              days_left: days,
              expires_at: formatEmailDate(sub.expires_at),
              renewal_url: panelLoginUrl(),
              support_email: branding.supportEmail,
              app_name: branding.appName,
            }),
            `Expiry reminder (${days}d) sent to ${recipient.email}`,
          );

          if (delivered.delivered === 'failed') {
            failed += 1;
            logger.error(
              `[EMAIL] Expiry reminder (${days}d) delivery failed for ${recipient.email}`,
            );
            continue;
          }

          await Subscription.updateOne(
            { _id: sub._id },
            { $addToSet: { reminders_sent: days } },
          );
          sent += 1;
          totalSent += 1;
          logger.info(
            `[EMAIL] Expiry reminder (${days}d) sent to ${recipient.email}`,
          );
        } catch (err: any) {
          failed += 1;
          logger.error(
            `[EMAIL] Expiry reminder (${days}d) failed for sub ${sub._id}: ${err.message}`,
          );
          await errorHandler.errorM({
            action_type: 'expiry-reminder-email',
            error_data: err,
          });
        }
      }
    } catch (err: any) {
      logger.error(
        `[CRON] Expiry reminder cron error for ${days}d threshold: ${err.message}`,
      );
      await errorHandler.errorM({
        action_type: 'expiry-reminder-threshold',
        error_data: err,
      });
    }

    logger.info(
      `[CRON] expiry-reminders ${days}d summary: sent=${sent}, skipped=${skipped}, failed=${failed}`,
    );
  }

  logger.info(`[CRON] expiry-reminders complete — ${totalSent} email(s) sent`);
  return totalSent;
};

/** Cron-job wrapper: no-overlap guard + logging around the reminder sweep. */
export const runSubscriptionReminderJob = (): Promise<number | undefined> =>
  withCronRun('subscription-expiry-reminders', () =>
    sendSubscriptionExpiryReminders(),
  );
