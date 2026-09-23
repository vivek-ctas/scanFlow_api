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
