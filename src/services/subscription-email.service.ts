import httpStatus from 'http-status';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { Organization } from '../models/organization.model.js';
import { User } from '../models/user.model.js';
import { Subscription } from '../models/subscription.model.js';
import { Payment } from '../models/payment.model.js';
import { errorHandler } from '../utils/system-error.handler.js';
import { createResponse, toObjectId } from './common.service.js';
import { getWebSettings } from './admin/web-settings.service.js';
import { buildInvoiceEmailDetails } from '../emails/invoice.builder.js';
import { formatEmailDate } from '../emails/format.utils.js';
import {
  DEFAULT_COMPANY_NAME,
  DEFAULT_PANEL_LOGIN_PATH,
  DEFAULT_SUPPORT_EMAIL,
} from '../emails/email.constants.js';
import {
  renderFutureSubscriptionActivatedEmail,
  renderFutureSubscriptionScheduledEmail,
  renderRenewalEmail,
  renderSubscriptionExpiredEmail,
  renderWelcomeEmail,
} from '../emails/subscription-email.templates.js';
import { sendHtmlEmail, sendRenderedEmail } from './email.service.js';

const DEFAULT_PANEL_URL = 'http://localhost:7052';

const PRETTY_NAMES: Record<string, string> = { scanflow: 'ScanFlow' };

export const prettifyAppName = (name?: string): string => {
  const trimmed = (name || '').trim();
  if (!trimmed) return DEFAULT_COMPANY_NAME;
  const key = trimmed.toLowerCase();
  return PRETTY_NAMES[key] ?? trimmed;
};

/** Resolve product name + support email from the persisted web settings. */
export const resolveBranding = async (): Promise<{
  appName: string;
  supportEmail: string;
}> => {
  try {
    const settings = await getWebSettings();
    return {
      appName: prettifyAppName(settings.company?.name),
      supportEmail: (
        settings.contact?.email ||
        config.email.contactRecipient ||
        DEFAULT_SUPPORT_EMAIL
      ).toLowerCase(),
    };
  } catch (err: any) {
    logger.error(
      `Failed to resolve web settings for email branding: ${err.message}`,
    );
    return {
      appName: DEFAULT_COMPANY_NAME,
      supportEmail: config.email.contactRecipient || DEFAULT_SUPPORT_EMAIL,
    };
  }
};

/** Org admin user is the primary recipient; the org email is the fallback. */
export const resolveOrgRecipient = async (organizationId: string) => {
  const org = await Organization.findById(organizationId).lean();
  if (!org) return null;
  const admin = await User.findOne({
    organization_id: org._id,
    role: 'ORGANIZATION_ADMIN',
    status: { $ne: 2 },
  }).lean();
  const email = admin?.email || org.email;
  if (!email) return null;
  return {
    email: String(email).toLowerCase(),
    firstName: admin?.first_name || org.company_name || 'there',
  };
};

const resolvePayment = async (paymentId: any) => {
  try {
    if (!paymentId) return null;
    return await Payment.findById(paymentId);
  } catch (err: any) {
    logger.error(`Failed to load payment ${paymentId}: ${err.message}`);
    return null;
  }
};

export const panelLoginUrl = () =>
  `${config.panelUrl || DEFAULT_PANEL_URL}${DEFAULT_PANEL_LOGIN_PATH}`;

const report = (action: string, err: unknown, ctx: string) => {
  logger.error(`[EMAIL] ${action} failed ${ctx}: ${(err as Error).message}`);
  errorHandler.errorM({ action_type: action, error_data: err });
};

/**
 * Decide & send the grant email for a freshly created subscription — mirrors the
 * SaaS rule set:
 *  - `future`  → "upcoming subscription scheduled"
 *  - otherwise → welcome email on the first-ever grant, renewal otherwise
 * Fire-and-forget: never throws into the caller.
 */
export const dispatchSubscriptionGrantEmails = async (
  organizationId: string,
  createdSub: any,
): Promise<void> => {
  try {
    const recipient = await resolveOrgRecipient(organizationId);
    if (!recipient) return;

    const branding = await resolveBranding();
    const payment = await resolvePayment(createdSub.payment_id);
    const invoice = buildInvoiceEmailDetails(
      payment as any,
      createdSub.started_at,
      createdSub.expires_at,
    );
    const base = {
      first_name: recipient.firstName,
      plan_name: createdSub.plan_name || 'Your Plan',
      support_email: branding.supportEmail,
      app_name: branding.appName,
    };

    if (createdSub.status === 'future') {
      await sendRenderedEmail(
        recipient.email,
        `Your upcoming ${branding.appName} subscription has been scheduled`,
        renderFutureSubscriptionScheduledEmail({
          ...base,
          purchased_at: formatEmailDate(payment?.paid_at || new Date()),
          invoice,
        }),
        `Upcoming subscription scheduled for ${recipient.email}`,
      );
      logger.info(`[EMAIL] Scheduled-plan email sent to ${recipient.email}`);
      return;
    }

    const priorSubs = await Subscription.find({
      organization_id: toObjectId(organizationId),
      _id: { $ne: createdSub._id },
    })
      .select('status is_plan_cancel')
      .lean();
    const isRenewal = priorSubs.some(
      (s: any) =>
        (s.status === 'active' || s.status === 'future') && !s.is_plan_cancel,
    );

    if (isRenewal) {
      await sendRenderedEmail(
        recipient.email,
        `Your ${branding.appName} subscription has been renewed`,
        renderRenewalEmail({
          ...base,
          expired_at: formatEmailDate(createdSub.expires_at),
          invoice,
        }),
        `Renewal confirmation sent to ${recipient.email}`,
      );
      logger.info(`[EMAIL] Renewal email sent to ${recipient.email}`);
      return;
    }

    await sendRenderedEmail(
      recipient.email,
      `Welcome to ${branding.appName} — your subscription is active`,
      renderWelcomeEmail({
        ...base,
        features: createdSub.marketing_features || [],
        expired_at: formatEmailDate(createdSub.expires_at),
        admin_panel_login_url: panelLoginUrl(),
        invoice,
      }),
      `Welcome email sent to ${recipient.email}`,
    );
    logger.info(`[EMAIL] Welcome email sent to ${recipient.email}`);
  } catch (err: any) {
    report('grant-subscription-email', err, `for org ${organizationId}`);
  }
};

/** Email for a queued plan that was just promoted to active. */
export const dispatchSubscriptionActivatedEmail = async (
  organizationId: string,
  sub: any,
): Promise<void> => {
  try {
    const recipient = await resolveOrgRecipient(organizationId);
    if (!recipient) return;
    const branding = await resolveBranding();
    const payment = await resolvePayment(sub.payment_id);
    const invoice = buildInvoiceEmailDetails(
      payment as any,
      sub.started_at,
      sub.expires_at,
    );

    await sendRenderedEmail(
      recipient.email,
      `Your upcoming ${branding.appName} subscription is now active!`,
      renderFutureSubscriptionActivatedEmail({
        first_name: recipient.firstName,
        plan_name: sub.plan_name || 'Your Plan',
        features: sub.marketing_features || [],
        expired_at: formatEmailDate(sub.expires_at),
        admin_panel_login_url: panelLoginUrl(),
        support_email: branding.supportEmail,
        app_name: branding.appName,
        invoice,
      }),
      `Activation email sent to ${recipient.email}`,
    );
    logger.info(`[EMAIL] Activation email sent to ${recipient.email}`);
  } catch (err: any) {
    report('future-activation-email', err, `for org ${organizationId}`);
  }
};

/** Email when an active subscription is marked expired (period ended). */
export const dispatchSubscriptionExpiredEmail = async (
  organizationId: string,
  sub: any,
): Promise<void> => {
  try {
    const recipient = await resolveOrgRecipient(organizationId);
    if (!recipient) return;
    const branding = await resolveBranding();

    await sendRenderedEmail(
      recipient.email,
      `Your ${branding.appName} subscription has ended`,
      renderSubscriptionExpiredEmail({
        first_name: recipient.firstName,
        plan_name: sub.plan_name || 'Your Plan',
        expires_at: formatEmailDate(sub.expires_at),
        login_url: panelLoginUrl(),
        support_email: branding.supportEmail,
        app_name: branding.appName,
      }),
      `Expired-subscription email sent to ${recipient.email}`,
    );
    logger.info(
      `[EMAIL] Expired-subscription email sent to ${recipient.email}`,
    );
  } catch (err: any) {
    report('subscription-expired-email', err, `for org ${organizationId}`);
  }
};

const loadLatestSubscription = async (organizationId: string) => {
  const active = await Subscription.findOne({
    organization_id: toObjectId(organizationId),
    status: 'active',
  }).sort({ created_at: -1 });
  if (active) return active;
  return Subscription.findOne({
    organization_id: toObjectId(organizationId),
  }).sort({ created_at: -1 });
};

/**
 * Admin resend endpoint — re-sends the welcome or the renewal email using the
 * latest subscription + linked payment, mirroring the SaaS resend API.
 */
export const resendSubscriptionEmail = async (
  organizationId: string,
  kind: 'welcome' | 'renewal',
) => {
  const recipient = await resolveOrgRecipient(organizationId);
  if (!recipient) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      'Organization has no recipient email',
    );
  }

  const sub = await loadLatestSubscription(organizationId);
  if (!sub) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      'No subscription found for this organization',
    );
  }

  const branding = await resolveBranding();
  const payment = await resolvePayment(sub.payment_id);
  const invoice = buildInvoiceEmailDetails(
    payment as any,
    sub.started_at,
    sub.expires_at,
  );
  const base = {
    first_name: recipient.firstName,
    plan_name: sub.plan_name || 'Your Plan',
    expired_at: formatEmailDate(sub.expires_at),
    support_email: branding.supportEmail,
    app_name: branding.appName,
    invoice,
  };

  if (kind === 'renewal') {
    await sendRenderedEmail(
      recipient.email,
      `[Resent] Your ${branding.appName} subscription has been renewed`,
      renderRenewalEmail(base),
      `Resent renewal email to ${recipient.email}`,
    );
  } else {
    await sendRenderedEmail(
      recipient.email,
      `[Resent] Welcome to ${branding.appName} — your subscription is active`,
      renderWelcomeEmail({
        ...base,
        features: sub.marketing_features || [],
        admin_panel_login_url: panelLoginUrl(),
      }),
      `Resent welcome email to ${recipient.email}`,
    );
  }

  return createResponse(
    httpStatus.OK,
    `${kind === 'renewal' ? 'Renewal' : 'Welcome'} email resent to ${recipient.email}.`,
  );
};

/** Admin SMTP test email rendered through the brand layout. */
export const sendTestEmail = async (
  to: string,
  subject: string,
  message: string,
) => {
  await sendHtmlEmail(
    to,
    `[TEST] ${subject}`,
    `
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4B5563;">
        This is a test email from <strong>ScanFlow</strong>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4B5563;white-space:pre-wrap;">${message}</p>
      <p style="margin:0;font-size:12px;color:#9CA3AF;">Sent at ${new Date().toISOString()}</p>
    `,
    {
      appName: DEFAULT_COMPANY_NAME,
      headerTitle: 'Test email',
      headerSubtitle: 'SMTP configuration check',
      supportEmail: config.email.contactRecipient || DEFAULT_SUPPORT_EMAIL,
    },
    `Test email to ${to}`,
  );
  return createResponse(httpStatus.OK, `Test email sent to ${to}.`);
};
