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
    CLIENT_URL: Joi.string().allow('').description('frontend origin'),
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
      .description('webhook request batching hint (reserved)'),
    WEBHOOK_RETRY_LIMIT: Joi.number()
      .default(3)
      .description('webhook delivery retry attempts'),
    SCAN_QUOTA_PERIOD: Joi.string()
      .default('monthly')
      .description('reset cadence for the per-organization scan counter'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: 'key' } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

export const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
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
  },
  clientUrl: envVars.CLIENT_URL,
  behindReverseProxy: envVars.BEHIND_REVERSE_PROXY,
  auth: {
    bypassEmail: envVars.BYPASS_EMAIL,
    bypassOtp: envVars.BYPASS_OTP,
  },
  redis: {
    url: envVars.REDIS_URL,
    scanQuotaPeriod: envVars.SCAN_QUOTA_PERIOD,
  },
  webhook: {
    workerConcurrency: envVars.WEBHOOK_WORKER_CONCURRENCY,
    timeoutMs: envVars.WEBHOOK_TIMEOUT_MS,
    batchSize: envVars.WEBHOOK_BATCH_SIZE,
    retryLimit: envVars.WEBHOOK_RETRY_LIMIT,
  },
};

export default config;
