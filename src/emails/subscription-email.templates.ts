import type {
  ExpiredEmailContext,
  ExpiryReminderContext,
  FutureSubscriptionActivatedContext,
  FutureSubscriptionScheduledContext,
  RenewalEmailContext,
  WelcomeEmailContext,
} from './email.types.js';
import { renderEmailLayout } from './email-layout.js';
import {
  renderFallbackLink,
  renderFeaturesList,
  renderGreeting,
  renderInfoBox,
  renderInlineSupport,
  renderInvoiceSummary,
  renderLeadParagraph,
  renderPrimaryCta,
  renderSubscriptionSummary,
} from './email-components.js';
import { escapeHtml } from './format.utils.js';

/** Dynamic values are escaped before they reach raw (trusted-HTML) slots. */
type Safe = { planName: string; expiresAt: string; appName: string };

const safeValues = (ctx: {
  plan_name: string;
  expired_at?: string;
  expires_at?: string;
  app_name: string;
}): Safe => ({
  planName: escapeHtml(ctx.plan_name),
  expiresAt: escapeHtml(ctx.expired_at ?? ctx.expires_at ?? ''),
  appName: escapeHtml(ctx.app_name),
});

export function renderWelcomeEmail(ctx: WelcomeEmailContext): string {
  const { planName, appName } = safeValues(ctx);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Your <strong>${appName}</strong> account is ready and your <strong>${planName}</strong> subscription is now active. Log in to your dashboard to start scanning.`,
    )}
    ${renderSubscriptionSummary({
      planName: ctx.plan_name,
      expiredAt: ctx.expired_at,
      billingCycleLabel: ctx.invoice.billing_cycle_label,
    })}
    ${renderInvoiceSummary(ctx.invoice)}
    ${renderFeaturesList(ctx.features)}
    ${renderLeadParagraph(
      'You can open your dashboard using the button below.',
    )}
    ${renderPrimaryCta('Open your dashboard', ctx.admin_panel_login_url)}
    ${renderFallbackLink(ctx.admin_panel_login_url)}
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Welcome aboard',
    headerSubtitle:
      'Thank you for your purchase. Your subscription is active and your receipt is below.',
    supportEmail: ctx.support_email,
    content,
  });
}

export function renderRenewalEmail(ctx: RenewalEmailContext): string {
  const { appName } = safeValues(ctx);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Your <strong>${appName}</strong> subscription has been renewed successfully. You can continue using all features without interruption.`,
    )}
    ${renderSubscriptionSummary({
      planName: ctx.plan_name,
      expiredAt: ctx.expired_at,
      billingCycleLabel: ctx.invoice.billing_cycle_label,
    })}
    ${renderInvoiceSummary(ctx.invoice)}
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Subscription renewed',
    headerSubtitle:
      'Your payment was processed successfully. Here is a summary of your renewal.',
    supportEmail: ctx.support_email,
    content,
  });
}

export function renderFutureSubscriptionScheduledEmail(
  ctx: FutureSubscriptionScheduledContext,
): string {
  const { planName } = safeValues(ctx);
  const purchasedAt = escapeHtml(ctx.purchased_at);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Your payment for <strong>${planName}</strong> was successful and the plan is now scheduled. It will activate automatically once your current subscription period ends.`,
    )}
    ${renderInfoBox('Plan status', [
      `<strong>Purchased date:</strong> ${purchasedAt}`,
      `<strong>Plan status:</strong> Scheduled`,
      `<em>When your current plan period ends, this plan will activate and we will email you your start and expiry dates.</em>`,
    ])}
    ${renderInvoiceSummary(ctx.invoice)}
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Plan scheduled',
    headerSubtitle:
      'Thank you for your payment. Your upcoming subscription has been scheduled successfully.',
    supportEmail: ctx.support_email,
    content,
  });
}

export function renderFutureSubscriptionActivatedEmail(
  ctx: FutureSubscriptionActivatedContext,
): string {
  const { planName } = safeValues(ctx);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Great news! Your scheduled <strong>${planName}</strong> subscription is now <strong>ACTIVE</strong>. You can access all features included in your plan.`,
    )}
    ${renderSubscriptionSummary({
      planName: ctx.plan_name,
      expiredAt: ctx.expired_at,
      billingCycleLabel: ctx.invoice.billing_cycle_label,
    })}
    ${renderInvoiceSummary(ctx.invoice)}
    ${renderFeaturesList(ctx.features)}
    ${renderLeadParagraph(
      'You can open your dashboard using the button below.',
    )}
    ${renderPrimaryCta('Open your dashboard', ctx.admin_panel_login_url)}
    ${renderFallbackLink(ctx.admin_panel_login_url)}
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Upcoming plan now active',
    headerSubtitle:
      'Your queued subscription plan is now active. Your receipt and plan details are below.',
    supportEmail: ctx.support_email,
    content,
  });
}

export function renderExpiryReminderEmail(ctx: ExpiryReminderContext): string {
  const { planName, expiresAt } = safeValues(ctx);
  const daysText =
    ctx.days_left === 0
      ? 'later today'
      : ctx.days_left === 1
        ? 'tomorrow'
        : `in ${ctx.days_left} days`;
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Your <strong>${planName}</strong> subscription expires <strong>${daysText}</strong> — on ${expiresAt}. Renew before then to keep scanning without interruption.`,
    )}
    ${renderInfoBox(
      'Your plan',
      [
        `<strong>Plan:</strong> ${planName}`,
        `<strong>Active until:</strong> ${expiresAt}`,
      ],
      'warn',
    )}
    ${
      ctx.renewal_url
        ? `${renderPrimaryCta('Renew your subscription', ctx.renewal_url)}
         ${renderFallbackLink(ctx.renewal_url)}`
        : ''
    }
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Subscription expiring soon',
    headerSubtitle:
      'Your scan limit resets after renewal. Don’t lose access — renew before your plan expires.',
    supportEmail: ctx.support_email,
    content,
  });
}

export function renderSubscriptionExpiredEmail(
  ctx: ExpiredEmailContext,
): string {
  const { planName, expiresAt } = safeValues(ctx);
  const content = `
    ${renderGreeting(ctx.first_name)}
    ${renderLeadParagraph(
      `Your <strong>${planName}</strong> subscription ended on ${expiresAt}, so scanning is currently paused. Re-subscribe to reactivate your plan and pick up right where you left off.`,
    )}
    ${renderInfoBox('Subscription ended', [
      `<strong>Plan:</strong> ${planName}`,
      `<strong>Ended on:</strong> ${expiresAt}`,
    ])}
    ${
      ctx.login_url
        ? `${renderPrimaryCta('Renew your subscription', ctx.login_url)}
         ${renderFallbackLink(ctx.login_url)}`
        : ''
    }
    ${renderInlineSupport(ctx.support_email)}
  `;

  return renderEmailLayout({
    appName: ctx.app_name,
    headerTitle: 'Subscription ended',
    headerSubtitle:
      'Your subscription period has finished. Re-subscribe to keep your scanning running.',
    supportEmail: ctx.support_email,
    content,
  });
}
