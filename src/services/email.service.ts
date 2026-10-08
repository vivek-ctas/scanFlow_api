import nodemailer from 'nodemailer';
import config from '../config/config.js';
import { logger } from '../config/logger.js';
import type { EmailLayoutOptions } from '../emails/email.types.js';
import {
  DEFAULT_COMPANY_NAME,
  DEFAULT_SUPPORT_EMAIL,
} from '../emails/email.constants.js';
import { renderEmailLayout } from '../emails/email-layout.js';
import { renderOtpEmail } from '../emails/auth-email.templates.js';

let transporter: nodemailer.Transporter | null = null;

const isSmtpConfigured = () =>
  !!config.email.smtp.host && !!config.email.smtp.port;

const isTestEnv = () => config.env === 'test';

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport(config.email.smtp);
  }
  return transporter;
};

const consoleLog = (to: string, preview: string) => {
  logger.info(`[EMAIL-CONSOLE] To ${to}: ${preview}`);
};

export const emailDeliveryLog: Array<{
  to: string;
  subject: string;
  html: string;
  preview: string;
}> = [];

export const resetEmailDeliveryLog = () => {
  emailDeliveryLog.length = 0;
};

/**
 * Low-level branded delivery used by every email sender. Falls back to the
 * console in development/test environments so SMTP being down never breaks a
 * flow, but still reports `failed` in production so callers can react.
 */
const deliverTyped = (
  to: string,
  subject: string,
  html: string,
  preview: string,
) => {
  if (isTestEnv()) {
    emailDeliveryLog.push({ to, subject, html, preview });
    consoleLog(to, preview);
    return Promise.resolve({ delivered: 'console' as const });
  }
  if (!isSmtpConfigured()) {
    consoleLog(to, preview);
    return Promise.resolve({ delivered: 'console' as const });
  }
  return getTransporter()
    .sendMail({
      from: config.email.from,
      to,
      subject,
      html,
    })
    .then(() => ({ delivered: 'email' as const }))
    .catch(async (error: any) => {
      logger.error(
        `Failed to send email to ${to} (${subject}): ${error.message}`,
      );
      if (config.env !== 'production') {
        consoleLog(to, preview);
        return { delivered: 'console' as const };
      }
      return { delivered: 'failed' as const };
    });
};

/**
 * Render arbitrary content through the shared ScanFlow layout.
 * Exposed so the subscription-email service can compose template content.
 */
export const sendHtmlEmail = async (
  to: string,
  subject: string,
  content: string,
  layout: Omit<EmailLayoutOptions, 'content'>,
  preview: string,
) =>
  deliverTyped(to, subject, renderEmailLayout({ ...layout, content }), preview);

/**
 * Deliver an already fully-rendered email (e.g. a template that composed its
 * own layout) without wrapping it in another layout. Templates keep defining
 * the complete branded shell; callers must not pass full template output as
 * the `content` of `sendHtmlEmail` or the brand layout is duplicated.
 */
export const sendRenderedEmail = (
  to: string,
  subject: string,
  html: string,
  preview: string,
) => deliverTyped(to, subject, html, preview);

export const sendOtpEmail = async (to: string, otp: string) => {
  const subject = 'Your ScanFlow verification code';
  const html = renderOtpEmail({
    first_name: '',
    otp,
    expiry_minutes: 5,
    support_email: DEFAULT_SUPPORT_EMAIL,
    app_name: DEFAULT_COMPANY_NAME,
  });

  if (isTestEnv()) {
    consoleLog(to, `OTP for ${to}: ${otp}`);
    return { delivered: 'console' as const };
  }
  if (!isSmtpConfigured()) {
    consoleLog(to, `OTP for ${to}: ${otp}`);
    return { delivered: 'console' as const };
  }

  try {
    await getTransporter().sendMail({
      from: config.email.from,
      to,
      subject,
      html,
    });
    return { delivered: 'email' as const };
  } catch (error: any) {
    logger.error(`Failed to send OTP email to ${to}: ${error.message}`);
    if (config.env !== 'production') {
      consoleLog(to, `OTP for ${to}: ${otp}`);
      return { delivered: 'console' as const };
    }
    return { delivered: 'failed' as const };
  }
};

export const sendPaymentSuccessEmail = async (
  to: string,
  info: {
    firstName: string;
    organizationName: string;
    planName: string;
    amount: number;
    currency: string;
    invoiceNumber?: string;
    invoiceUrl?: string;
  },
) => {
  const invoiceText = [
    `Amount charged: ${info.currency} ${info.amount.toFixed(2)}`,
    invoiceNumberText(info.invoiceNumber),
    info.invoiceUrl ? `Invoice: ${info.invoiceUrl}` : '',
  ]
    .filter(Boolean)
    .join('<br/>');

  return deliverTyped(
    to,
    'Your ScanFlow subscription is active',
    renderEmailLayout({
      appName: DEFAULT_COMPANY_NAME,
      headerTitle: 'Payment successful',
      headerSubtitle:
        'Your ScanFlow subscription is active. You can sign in with your email to confirm and start scanning.',
      supportEmail: DEFAULT_SUPPORT_EMAIL,
      content: `
        <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
          Hi ${escape(info.firstName)},<br/><br/>
          Your <strong>${escape(info.planName)}</strong> subscription is now active
          for <strong>${escape(info.organizationName)}</strong>.
        </p>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#4B5563;">${invoiceText}</p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#6B7280;">
          Questions? Email us at
          <a href="mailto:${DEFAULT_SUPPORT_EMAIL}" style="color:#3C9AC4;text-decoration:none;font-weight:600;">${DEFAULT_SUPPORT_EMAIL}</a>.
        </p>
      `,
    }),
    `Subscription active for ${info.organizationName}`,
  );
};

export const sendPaymentFailureEmail = async (
  to: string,
  info: { firstName: string },
) => {
  const html = renderEmailLayout({
    appName: DEFAULT_COMPANY_NAME,
    headerTitle: 'Payment not completed',
    headerSubtitle:
      'We could not complete your ScanFlow payment. No charge was made and no subscription was activated.',
    supportEmail: DEFAULT_SUPPORT_EMAIL,
    content: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        Hi ${escape(info.firstName)},
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        We couldn’t complete your ScanFlow payment. No charge was made and no
        subscription was activated. You can retry the checkout at any time.
      </p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#6B7280;">
        Questions? Email us at
        <a href="mailto:${DEFAULT_SUPPORT_EMAIL}" style="color:#3C9AC4;text-decoration:none;font-weight:600;">${DEFAULT_SUPPORT_EMAIL}</a>.
      </p>
    `,
  });

  return deliverTyped(
    to,
    'Your ScanFlow payment was not completed',
    html,
    'Payment not completed',
  );
};

/**
 * Confirmation email to the visitor who submitted the contact form.
 */
export const sendContactConfirmationEmail = async (
  to: string,
  info: { name: string; inquiryType: string },
) => {
  const html = renderEmailLayout({
    appName: DEFAULT_COMPANY_NAME,
    headerTitle: 'We received your message',
    headerSubtitle:
      'Thanks for reaching out to ScanFlow. Our team will get back to you within 24 hours.',
    supportEmail: DEFAULT_SUPPORT_EMAIL,
    content: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        Hi ${escape(info.name)},
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        Thanks for reaching out. We’ve received your <strong>${escape(info.inquiryType || 'general')}</strong>
        inquiry and a member of our team will get back to you within 24 hours.
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">— The ScanFlow team</p>
    `,
  });

  return deliverTyped(
    to,
    'We received your message — ScanFlow',
    html,
    `Contact confirmation to ${to}`,
  );
};

/**
 * Notification email to the company whenever a new contact inquiry lands.
 */
export const sendContactNotificationEmail = async (info: {
  name: string;
  email: string;
  company?: string;
  inquiryType: string;
  message: string;
}) => {
  const content = `
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4B5563;">
      <strong>Name:</strong> ${escape(info.name)}<br/>
      <strong>Email:</strong> ${escape(info.email)}<br/>
      ${info.company ? `<strong>Company:</strong> ${escape(info.company)}<br/>` : ''}
      <strong>Inquiry type:</strong> ${escape(info.inquiryType)}
    </p>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#4B5563;"><strong>Message:</strong></p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;white-space:pre-wrap;">${escape(info.message)}</p>
  `;

  return deliverTyped(
    config.email.contactRecipient || 'info@scanflow.app',
    `New ScanFlow contact inquiry — ${info.name}`,
    renderEmailLayout({
      appName: DEFAULT_COMPANY_NAME,
      headerTitle: 'New contact inquiry',
      headerSubtitle: `A visitor submitted the contact form.`,
      supportEmail: DEFAULT_SUPPORT_EMAIL,
      content,
    }),
    `New contact inquiry from ${info.name}`,
  );
};

/**
 * Notification email to the visitor once an admin replies from the panel.
 */
export const sendContactReplyEmail = async (
  to: string,
  info: { name: string; message: string },
) => {
  const html = renderEmailLayout({
    appName: DEFAULT_COMPANY_NAME,
    headerTitle: 'Response to your inquiry',
    headerSubtitle:
      'A member of the ScanFlow team has replied to your inquiry.',
    supportEmail: DEFAULT_SUPPORT_EMAIL,
    content: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        Hi ${escape(info.name)},
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;white-space:pre-wrap;">
        ${escape(info.message)}
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#4B5563;">
        If you have any further questions, just reply to this email or reach
        out to us again through the website.
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#4B5563;">— The ScanFlow team</p>
    `,
  });

  return deliverTyped(
    to,
    'ScanFlow — Response to your inquiry',
    html,
    `Reply sent to ${to}`,
  );
};

function escape(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function invoiceNumberText(invoiceNumber?: string): string {
  return invoiceNumber ? ` (invoice ${invoiceNumber})` : '';
}
