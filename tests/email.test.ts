import { describe, it, expect } from 'vitest';
import { createOrg, createPlan, createUser, grant } from './helpers.js';
import {
  BRAND,
  DEFAULT_COMPANY_NAME,
  DEFAULT_SUPPORT_EMAIL,
} from '../src/emails/email.constants.js';
import {
  buildInvoiceNumber,
  escapeHtml,
  formatBillingCycleLabel,
  formatCurrency,
  formatEmailDate,
  formatGatewayLabel,
} from '../src/emails/format.utils.js';
import { buildInvoiceEmailDetails } from '../src/emails/invoice.builder.js';
import { renderOtpEmail } from '../src/emails/auth-email.templates.js';
import {
  renderExpiryReminderEmail,
  renderFutureSubscriptionActivatedEmail,
  renderFutureSubscriptionScheduledEmail,
  renderRenewalEmail,
  renderSubscriptionExpiredEmail,
  renderWelcomeEmail,
} from '../src/emails/subscription-email.templates.js';
import {
  prettifyAppName,
  resendSubscriptionEmail,
} from '../src/services/subscription-email.service.js';
import {
  REMINDER_WINDOW_DAYS,
  sendSubscriptionExpiryReminders,
} from '../src/cron/subscription/index.js';
import {
  emailDeliveryLog,
  resetEmailDeliveryLog,
  sendOtpEmail,
  sendPaymentFailureEmail,
} from '../src/services/email.service.js';
import { Subscription } from '../src/models/index.js';

const invoice = {
  invoice_number: 'INV-12345678',
  invoice_date: '1 January 2026',
  amount: '₹9,999.00',
  currency_code: 'INR',
  billing_cycle: 'month',
  billing_cycle_label: 'Monthly',
  payment_method: 'Razorpay',
  transaction_id: 'txn_abc',
  subscription_start: '1 January 2026',
  subscription_end: '1 February 2026',
};

const base = {
  first_name: 'Rahul',
  plan_name: 'Scale',
  expired_at: '1 February 2026',
  support_email: DEFAULT_SUPPORT_EMAIL,
  app_name: DEFAULT_COMPANY_NAME,
  invoice,
};

describe('email format utilities', () => {
  it('formatCurrency renders major-unit amounts without stray conversion', () => {
    expect(formatCurrency(9999, 'INR')).toContain('9,999');
    expect(formatCurrency(49.99, 'USD')).toContain('49.99');
  });

  it('buildInvoiceNumber falls back for empty payment ids', () => {
    expect(buildInvoiceNumber()).toBe('INV-00000000');
    expect(buildInvoiceNumber('507f1f77bcf86cd799439011')).toMatch(/^INV-/);
  });

  it('formatEmailDate returns an empty string for bad dates', () => {
    expect(formatEmailDate(new Date('not-a-real-date'))).toBe('');
  });

  it('labels gateway + billing cycle in display form', () => {
    expect(formatGatewayLabel('razorpay')).toBe('Razorpay');
    expect(formatBillingCycleLabel('quarterly')).toBe('Quarterly');
  });

  it('escapeHtml neutralises markup injection', () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});

describe('invoice builder (major-unit payments)', () => {
  it('builds a full InvoiceEmailDetails from a Payment row', () => {
    const details = buildInvoiceEmailDetails(
      {
        _id: '507f1f77bcf86cd799439011',
        price: 4999,
        currency_code: 'INR',
        billing_cycle: 'quarterly',
        gateway: 'stripe',
        transaction_id: 'ch_123',
        paid_at: new Date('2026-01-01T10:00:00Z'),
        invoice_number: 'INV-PAY-1',
      },
      new Date('2026-01-01T10:00:00Z'),
      new Date('2026-03-01T10:00:00Z'),
    );
    expect(details.amount).toContain('4,999');
    expect(details.billing_cycle_label).toBe('Quarterly');
    expect(details.payment_method).toBe('Stripe');
    expect(details.invoice_number).toBe('INV-PAY-1');
    expect(details.transaction_id).toBe('ch_123');
  });

  it('returns a placeholder invoice when no payment exists', () => {
    const details = buildInvoiceEmailDetails(null);
    expect(details.amount).toBe('—');
    expect(details.invoice_number).toBe('INV-00000000');
  });
});

describe('branding resolver', () => {
  it('prettifies the lowercase seed name and defaults', () => {
    expect(prettifyAppName('scanflow')).toBe('ScanFlow');
    expect(prettifyAppName()).toBe('ScanFlow');
    expect(prettifyAppName('  Acme  ')).toBe('Acme');
  });
});

describe('subscription email templates', () => {
  it('renders the welcome email with brand + CTA (navy/sky, not SaaS green)', () => {
    const html = renderWelcomeEmail({
      ...base,
      features: ['Unlimited scans', 'Team operators'],
      admin_panel_login_url: 'https://panel.example/login',
    });
    expect(html).toContain('Welcome aboard');
    expect(html).toContain('₹9,999.00');
    expect(html).toContain('Rahul');
    expect(html).toContain(BRAND.navy);
    expect(html).toContain(BRAND.sky);
    expect(html).toContain('https://panel.example/login');
    expect(html).not.toContain('#059669');
  });

  it('escapes dynamic user content in body copy', () => {
    const html = renderSubscriptionExpiredEmail({
      first_name: 'Rahul</p><script>alert(1)</script>',
      plan_name: 'Scale<script>',
      expires_at: '1 February 2026',
      support_email: DEFAULT_SUPPORT_EMAIL,
      app_name: DEFAULT_COMPANY_NAME,
      login_url: 'https://panel.example/login',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders every subscription template with its headline', () => {
    expect(renderRenewalEmail(base)).toContain('Subscription renewed');
    expect(
      renderFutureSubscriptionScheduledEmail({
        first_name: base.first_name,
        plan_name: base.plan_name,
        purchased_at: '1 January 2026',
        support_email: base.support_email,
        app_name: base.app_name,
        invoice,
      }),
    ).toContain('Plan scheduled');
    expect(
      renderFutureSubscriptionActivatedEmail({
        ...base,
        features: ['Unlimited scans'],
        admin_panel_login_url: 'https://panel.example/login',
      }),
    ).toContain('Upcoming plan now active');
    expect(
      renderExpiryReminderEmail({
        first_name: base.first_name,
        plan_name: base.plan_name,
        days_left: 1,
        expires_at: base.expired_at,
        support_email: base.support_email,
        app_name: base.app_name,
        renewal_url: 'https://panel.example/login',
      }),
    ).toContain('Subscription expiring soon');
    expect(
      renderSubscriptionExpiredEmail({ ...base, login_url: undefined }),
    ).toContain('Subscription ended');
  });
});

describe('OTP email', () => {
  it('renders the OTP code and delivery reaches the console in test env', async () => {
    const html = renderOtpEmail({
      first_name: 'Rahul',
      otp: '123456',
      expiry_minutes: 5,
      support_email: DEFAULT_SUPPORT_EMAIL,
      app_name: DEFAULT_COMPANY_NAME,
    });
    expect(html).toContain('123456');
    expect(html).toContain('Verify it’s you');

    const result = await sendOtpEmail('test@example.com', '123456');
    expect(result.delivered).toBe('console');
  });

  it('payment failure email short-circuits to console in test env', async () => {
    const result = await sendPaymentFailureEmail('test@example.com', {
      firstName: 'Rahul',
    });
    expect(result.delivered).toBe('console');
  });
});

describe('subscription-email service (test env = console delivery)', () => {
  it('resend welcome resolves recipient, invoice and brand layout', async () => {
    const org = await createOrg({ email: 'resend@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(org._id), {
      first_name: 'Rahul',
      email: 'resend@example.com',
    });
    const plan = await createPlan({ name: 'Scale', marketing_features: ['x'] });
    const sub = await grant(String(org._id), String(plan._id), {
      trialDays: 0,
    });
    expect(sub.status).toBe('active');

    const result = await resendSubscriptionEmail(String(org._id), 'welcome');
    expect(result.status).toBe(200);
    expect(result.message).toContain('resend@example.com');
  });

  it('resend renewal finds the latest active subscription', async () => {
    const org = await createOrg({ email: 'resend2@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(org._id), {
      email: 'resend2@example.com',
    });
    const plan = await createPlan({ name: 'Scale', marketing_features: [] });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });
    const result = await resendSubscriptionEmail(String(org._id), 'renewal');
    expect(result.status).toBe(200);
    expect(result.message).toContain('Renewal email resent');
  });

  it('resend fails for an organization with no recipient email', async () => {
    const org = await createOrg({ email: undefined });
    await expect(
      resendSubscriptionEmail(String(org._id), 'welcome'),
    ).rejects.toThrow('Organization has no recipient email');
  });
});

describe('email brand layout (single shell, no double template)', () => {
  it('delivers welcome once with a single layout wrap', async () => {
    resetEmailDeliveryLog();
    const org = await createOrg({ email: 'single-layout@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(org._id), {
      email: 'single-layout@example.com',
    });
    const plan = await createPlan({ name: 'Scale', marketing_features: [] });
    await grant(String(org._id), String(plan._id), { trialDays: 0 });

    await resendSubscriptionEmail(String(org._id), 'welcome');
    const delivered = emailDeliveryLog.find((e) =>
      e.subject.startsWith('[Resent] Welcome'),
    );
    expect(delivered).toBeDefined();
    expect((delivered!.html.match(/class="email-shell"/g) || []).length).toBe(
      1,
    );
    expect((delivered!.html.match(/class="email-card"/g) || []).length).toBe(1);
  });
});

describe('expiry reminder sweep', () => {
  const utcNoonInDays = (days: number): Date => {
    const now = new Date();
    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + days,
        12,
        0,
        0,
      ),
    );
  };

  it('sends one reminder per calendar-day threshold and marks reminders_sent', async () => {
    const orgs = await Promise.all([
      createOrg({ email: 'remind-7@example.com' }),
      createOrg({ email: 'remind-3@example.com' }),
      createOrg({ email: 'remind-1@example.com' }),
    ]);
    for (const org of orgs) {
      await createUser('ORGANIZATION_ADMIN', String(org._id), {
        email: org.email,
      });
    }
    const plan = await createPlan({ name: 'Scale', marketing_features: [] });
    const windows = REMINDER_WINDOW_DAYS.filter((days) => days > 0);
    const subs: Array<Awaited<ReturnType<typeof grant>>> = [];
    for (let i = 0; i < windows.length; i += 1) {
      const sub = await grant(String(orgs[i]._id), String(plan._id), {
        trialDays: 0,
      });
      await Subscription.updateOne(
        { _id: sub._id },
        { $set: { expires_at: utcNoonInDays(windows[i]) } },
      );
      subs.push(sub);
    }

    resetEmailDeliveryLog();
    const sent = await sendSubscriptionExpiryReminders();
    expect(sent).toBeGreaterThanOrEqual(windows.length);

    const reminder = emailDeliveryLog.find((e) => e.subject.includes('days'));
    expect(reminder).toBeDefined();
    expect((reminder!.html.match(/class="email-shell"/g) || []).length).toBe(1);
    expect((reminder!.html.match(/class="email-card"/g) || []).length).toBe(1);

    for (let i = 0; i < windows.length; i += 1) {
      const refreshed = await Subscription.findById(subs[i]._id);
      expect(refreshed?.reminders_sent).toContain(windows[i]);
    }

    // Dedupe: the same sweep must not re-send within the same windows.
    const second = await sendSubscriptionExpiryReminders();
    expect(second).toBe(0);
  });

  it('sends a day-0 reminder only to active subscriptions expiring today', async () => {
    const activeOrg = await createOrg({ email: 'remind-0@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(activeOrg._id), {
      email: activeOrg.email,
    });
    const expiredOrg = await createOrg({ email: 'remind-expired@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(expiredOrg._id), {
      email: expiredOrg.email,
    });

    const plan = await createPlan({ name: 'Scale', marketing_features: [] });
    const activeSub = await grant(String(activeOrg._id), String(plan._id), {
      trialDays: 0,
    });
    await Subscription.updateOne(
      { _id: activeSub._id },
      { $set: { expires_at: utcNoonInDays(0) } },
    );
    const expiredSub = await grant(String(expiredOrg._id), String(plan._id), {
      trialDays: 0,
    });
    await Subscription.updateOne(
      { _id: expiredSub._id },
      { $set: { status: 'expired', expires_at: utcNoonInDays(-5) } },
    );

    await sendSubscriptionExpiryReminders();

    const refreshedActive = await Subscription.findById(activeSub._id);
    expect(refreshedActive?.reminders_sent).toContain(0);

    // Already-expired subscriptions are covered by the flip's "subscription
    // ended" email and must not get a day-0 reminder as well.
    const refreshedExpired = await Subscription.findById(expiredSub._id);
    expect(refreshedExpired?.reminders_sent ?? []).not.toContain(0);
  });

  it('skips organizations without a recipient and still sends to the rest', async () => {
    const goodOrg = await createOrg({ email: 'good@example.com' });
    await createUser('ORGANIZATION_ADMIN', String(goodOrg._id), {
      email: 'good@example.com',
    });
    const noRecipientOrg = await createOrg({ email: undefined });

    const plan = await createPlan({ name: 'Scale', marketing_features: [] });
    const goodSub = await grant(String(goodOrg._id), String(plan._id), {
      trialDays: 0,
    });
    await Subscription.updateOne(
      { _id: goodSub._id },
      { $set: { expires_at: utcNoonInDays(1) } },
    );
    const noRecipientSub = await grant(
      String(noRecipientOrg._id),
      String(plan._id),
      { trialDays: 0 },
    );
    await Subscription.updateOne(
      { _id: noRecipientSub._id },
      { $set: { expires_at: utcNoonInDays(1) } },
    );

    const sent = await sendSubscriptionExpiryReminders();
    expect(sent).toBe(1);

    const refreshedGood = await Subscription.findById(goodSub._id);
    expect(refreshedGood?.reminders_sent).toContain(1);
    const refreshedNoRecipient = await Subscription.findById(
      noRecipientSub._id,
    );
    expect(refreshedNoRecipient?.reminders_sent ?? []).not.toContain(1);
  });
});
