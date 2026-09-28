import nodemailer from 'nodemailer';
import config from '../config/config.js';
import { logger } from '../config/logger.js';

let transporter: nodemailer.Transporter | null = null;

const isSmtpConfigured = () =>
  !!config.email.smtp.host && !!config.email.smtp.port;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport(config.email.smtp);
  }
  return transporter;
};

export const sendOtpEmail = async (to: string, otp: string) => {
  if (!isSmtpConfigured()) {
    logger.info(`[EMAIL-CONSOLE] OTP for ${to}: ${otp}`);
    return { delivered: 'console' as const };
  }

  try {
    await getTransporter().sendMail({
      from: config.email.from,
      to,
      subject: 'ScanFlow verification code',
      html: `<p>Your ScanFlow verification code is:</p>
             <h2 style="letter-spacing:4px;">${otp}</h2>
             <p>This code expires in 5 minutes.</p>`,
    });
    return { delivered: 'email' as const };
  } catch (error: any) {
    logger.error(`Failed to send OTP email to ${to}: ${error.message}`);
    if (config.env !== 'production') {
      logger.info(`[EMAIL-CONSOLE] OTP for ${to}: ${otp}`);
      return { delivered: 'console' as const };
    }
    return { delivered: 'failed' as const };
  }
};

const deliverTyped = (
  to: string,
  subject: string,
  html: string,
  preview: string,
) => {
  if (!isSmtpConfigured()) {
    logger.info(`[EMAIL-CONSOLE] To ${to}: ${preview}`);
    return { delivered: 'console' as const };
  }
  return getTransporter()
    .sendMail({ from: config.email.from, to, subject, html })
    .then(() => ({ delivered: 'email' as const }))
    .catch(async (error: any) => {
      logger.error(
        `Failed to send email to ${to} (${subject}): ${error.message}`,
      );
      if (config.env !== 'production') {
        logger.info(`[EMAIL-CONSOLE] To ${to}: ${preview}`);
        return { delivered: 'console' as const };
      }
      return { delivered: 'failed' as const };
    });
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
) =>
  deliverTyped(
    to,
    'Your ScanFlow subscription is active',
    `<p>Hi ${info.firstName},</p>
     <p>Your <strong>${info.planName}</strong> subscription is now active
     for <strong>${info.organizationName}</strong>.</p>
     <p>Amount charged: ${info.currency} ${info.amount.toFixed(2)}
     ${info.invoiceNumber ? ` (invoice ${info.invoiceNumber})` : ''}</p>
     ${info.invoiceUrl ? `<p>Invoice: <a href="${info.invoiceUrl}">${info.invoiceUrl}</a></p>` : ''}
     <p>You can sign in with your email to confirm and start scanning.</p>`,
    `Subscription active for ${info.organizationName}`,
  );

export const sendPaymentFailureEmail = async (
  to: string,
  info: { firstName: string },
) =>
  deliverTyped(
    to,
    'Your ScanFlow payment was not completed',
    `<p>Hi ${info.firstName},</p>
     <p>We couldn't complete your ScanFlow payment. No charge was made and no
     subscription was activated. You can retry the checkout at any time.</p>`,
    'Payment not completed',
  );
