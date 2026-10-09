import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string()
      .valid('production', 'development', 'test')
      .required(),
    PORT: Joi.number().default(3000),
    MONGODB_URL: Joi.string().required().description('Mongo DB url'),
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number()
      .default(30)
      .description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number()
      .default(30)
      .description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which reset password token expires'),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which verify email token expires'),
    SMTP_HOST: Joi.string()
      .allow('')
      .description('server that will send emails'),
    SMTP_PORT: Joi.number()
      .allow('')
      .description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string()
      .allow('')
      .description('username for email server'),
    SMTP_PASSWORD: Joi.string()
      .allow('')
      .description('password for email server'),
    EMAIL_FROM: Joi.string()
      .allow('')
      .description('the from field in the emails sent by the app'),
    EMAIL_CONTACT_RECIPIENT: Joi.string()
      .allow('')
      .description('recipient of contact-form notification emails'),
    CLIENT_URL: Joi.string().allow('').description('frontend origin'),
    ADMIN_PANEL_URL: Joi.string()
      .allow('')
      .default('http://localhost:7052')
      .description('admin panel origin used in subscription emails'),
    SITE_URL: Joi.string()
      .allow('')
      .default('http://localhost:3001')
      .description('marketing site origin used in subscription emails'),
    BEHIND_REVERSE_PROXY: Joi.boolean()
      .default(false)
      .description('trust X-Forwarded-* headers when behind a reverse proxy'),
    BYPASS_EMAIL: Joi.string()
      .allow('')
      .description('dev-only email that skips real OTP delivery'),
    BYPASS_OTP: Joi.string()
      .allow('')
      .description('dev-only fixed OTP accepted instead of the generated one'),
    REDIS_URL: Joi.string()
      .allow('')
      .description('Redis connection URL for queues and scan quota counter'),
    WEBHOOK_WORKER_CONCURRENCY: Joi.number()
      .default(100)
      .description('concurrent webhook deliveries per worker process'),
    WEBHOOK_TIMEOUT_MS: Joi.number()
      .default(5000)
      .description('max ms a webhook delivery request may take'),
    WEBHOOK_BATCH_SIZE: Joi.number()
      .default(100)
      .description('webhook request batching hint'),
    WEBHOOK_BATCH_DEBOUNCE_MS: Joi.number()
      .default(2000)
      .description('debounce window before flushing a partial webhook batch'),
    WEBHOOK_RETRY_LIMIT: Joi.number()
      .default(3)
      .description('webhook delivery retry attempts'),
    STRIPE_SECRET_KEY: Joi.string().allow('').description('Stripe secret key'),
    STRIPE_WEBHOOK_SECRET: Joi.string()
      .allow('')
      .description('Stripe webhook signing secret'),
    RAZORPAY_KEY_ID: Joi.string().allow('').description('Razorpay key id'),
    RAZORPAY_KEY_SECRET: Joi.string()
      .allow('')
      .description('Razorpay key secret'),
    RAZORPAY_WEBHOOK_SECRET: Joi.string()
      .allow('')
      .description('Razorpay webhook signing secret'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: 'key' } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

/**
 * Appends '-test' to the database name of a Mongo URI, preserving any
 * query string (`?authSource=...`, `?readPreference=...`). Naively appending
 * to the whole string would corrupt the query and break authentication.
 */
const withTestDbSuffix = (url: string): string => {
  const queryIndex = url.indexOf('?');
  const base = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  return `${base}-test${query}`;
};

export const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoose: {
    url:
      envVars.NODE_ENV === 'test'
        ? withTestDbSuffix(envVars.MONGODB_URL)
        : envVars.MONGODB_URL,
    options: {},
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes:
      envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
    contactRecipient: envVars.EMAIL_CONTACT_RECIPIENT,
  },
  clientUrl: envVars.CLIENT_URL,
  panelUrl: envVars.ADMIN_PANEL_URL,
  siteUrl: envVars.SITE_URL,
  behindReverseProxy: envVars.BEHIND_REVERSE_PROXY,
  auth: {
    bypassEmail: envVars.BYPASS_EMAIL,
    bypassOtp: envVars.BYPASS_OTP,
  },
  redis: {
    url: envVars.REDIS_URL,
  },
  webhook: {
    workerConcurrency: envVars.WEBHOOK_WORKER_CONCURRENCY,
    timeoutMs: envVars.WEBHOOK_TIMEOUT_MS,
    batchSize: envVars.WEBHOOK_BATCH_SIZE,
    batchDebounceMs: envVars.WEBHOOK_BATCH_DEBOUNCE_MS,
    retryLimit: envVars.WEBHOOK_RETRY_LIMIT,
  },
  stripe: {
    secretKey: envVars.STRIPE_SECRET_KEY,
    webhookSecret: envVars.STRIPE_WEBHOOK_SECRET,
  },
  razorpay: {
    keyId: envVars.RAZORPAY_KEY_ID,
    keySecret: envVars.RAZORPAY_KEY_SECRET,
    webhookSecret: envVars.RAZORPAY_WEBHOOK_SECRET,
  },
};

export default config;
