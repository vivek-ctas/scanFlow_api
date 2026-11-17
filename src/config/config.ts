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
    DASHBOARD_TIMEZONE: Joi.string()
      .default('Asia/Kolkata')
      .description('IANA timezone used for dashboard day/month boundaries'),
    DASHBOARD_QUERY_MAX_MS: Joi.number()
      .default(5000)
      .description('max ms a dashboard aggregation may run'),
    DASHBOARD_NEAR_LIMIT_PCT: Joi.number()
      .default(90)
      .description('utilization % at which a quota is flagged near-limit'),
    DASHBOARD_CACHE_FRESH_SECONDS: Joi.number()
      .default(60)
      .description('freshness window for cheap dashboard widgets'),
    DASHBOARD_CHART_CACHE_SECONDS: Joi.number()
      .default(300)
      .description('freshness window for dashboard chart widgets'),
    DAILY_LIMIT_TIMEZONE: Joi.string()
      .default('Asia/Kolkata')
      .description('IANA timezone used for daily scan-limit day boundaries'),
    DAILY_ALERT_THRESHOLD_PCT: Joi.number()
      .min(1)
      .max(100)
      .default(90)
      .description('daily scan usage % that triggers the amber alert'),
    SUPPORT_NOTIFY_EMAILS: Joi.string()
      .allow('')
      .description(
        'comma-separated support notification recipients; empty → all active super admins',
      ),
    SUPPORT_FIRST_RESPONSE_HOURS: Joi.number()
      .default(24)
      .description('staff-only overdue highlight threshold (hours)'),
    SUPPORT_AUTOCLOSE_DAYS: Joi.number()
      .default(7)
      .description('days after which a resolved ticket is auto-closed'),
    SUPPORT_MAX_ATTACHMENT_MB: Joi.number()
      .default(5)
      .description(
        'deprecated: max size of a single support attachment in MB (fallback only)',
      ),
    SUPPORT_MAX_FILES: Joi.number()
      .default(5)
      .description('max attachments per support message'),
    SUPPORT_MAX_TOTAL_MB: Joi.number()
      .default(100)
      .description('max total attachment bytes per support message in MB'),
    SUPPORT_MAX_IMAGE_MB: Joi.number().default(10),
    SUPPORT_MAX_DOCUMENT_MB: Joi.number().default(25),
    SUPPORT_MAX_TEXT_MB: Joi.number().default(10),
    SUPPORT_MAX_ARCHIVE_MB: Joi.number().default(50),
    SUPPORT_MAX_VIDEO_MB: Joi.number().default(100),
    SUPPORT_TICKET_STORAGE_MB: Joi.number()
      .default(250)
      .description('max attachment storage per support ticket in MB'),
    SUPPORT_ORG_STORAGE_MB: Joi.number()
      .default(1024)
      .description('max attachment storage per organization in MB'),
    SUPPORT_UPLOAD_MB_PER_HOUR: Joi.number()
      .default(500)
      .description('max attachment bytes a user may upload per hour'),
    SUPPORT_MIN_FREE_DISK_MB: Joi.number()
      .default(2048)
      .description('refuse uploads when free disk falls below this'),
    SUPPORT_UPLOAD_TMP_DIR: Joi.string()
      .allow('')
      .default('')
      .description('temporary directory for in-flight support uploads'),
    SUPPORT_ALLOWED_KINDS: Joi.string()
      .default('image,document,text,video,archive')
      .description('comma-separated attachment kinds that are enabled'),
    SUPPORT_MEDIA_TOKEN_SECRET: Joi.string()
      .allow('')
      .default('')
      .description('HMAC secret for short-lived attachment access URLs'),
    SUPPORT_MEDIA_TOKEN_TTL_SECONDS: Joi.number().default(120),
    SUPPORT_STORAGE_DRIVER: Joi.string()
      .valid('local', 's3')
      .default('local')
      .description('attachment storage driver'),
    SUPPORT_UPLOAD_DIR: Joi.string()
      .allow('')
      .default('/data/support-uploads')
      .description('local directory for support attachments (shared volume)'),
    SUPPORT_RATE_CREATE_PER_HOUR: Joi.number()
      .default(10)
      .description('max support tickets a user may create per hour'),
    SUPPORT_RATE_REPLY_PER_HOUR: Joi.number()
      .default(60)
      .description('max support replies a user may send per hour'),
    SUPPORT_MAX_ACTIVE_PER_ORG: Joi.number()
      .default(25)
      .description('max simultaneously active tickets per organization'),
    STRIPE_SECRET_KEY: Joi.string().allow('').description('Stripe secret key'),
    STRIPE_WEBHOOK_SECRET: Joi.string()
      .allow('')
      .description('Stripe webhook signing secret'),
    NOTIFY_QUOTA_THRESHOLDS: Joi.string()
      .default('80,90,100')
      .description('comma-separated quota alert thresholds %'),
    NOTIFY_SUBSCRIPTION_REMINDER_DAYS: Joi.string()
      .default('7,1')
      .description(
        'comma-separated in-app reminder windows (days before expiry)',
      ),
    NOTIFY_READ_RETENTION_DAYS: Joi.number()
      .default(30)
      .description('days after read before TTL deletion'),
    NOTIFY_UNREAD_RETENTION_DAYS: Joi.number()
      .default(90)
      .description('days before TTL deletion for unread'),
    NOTIFY_UNREAD_COUNT_CAP: Joi.number()
      .default(100)
      .description('max unread count before bell shows 99+'),
    NOTIFY_REMINDER_INTERVAL_MINUTES: Joi.number()
      .default(15)
      .description('interval for reminder checks'),
    RAZORPAY_KEY_ID: Joi.string().allow('').description('Razorpay key id'),
    RAZORPAY_KEY_SECRET: Joi.string()
      .allow('')
      .description('Razorpay key secret'),
    RAZORPAY_WEBHOOK_SECRET: Joi.string()
      .allow('')
      .description('Razorpay webhook signing secret'),
    CRONZIVO_API_KEY: Joi.string()
      .allow('')
      .default('')
      .description('CronZivo global key (CURRENT slot)'),
    CRONZIVO_API_KEY_SECONDARY: Joi.string()
      .allow('')
      .default('')
      .description('CronZivo global key (rotation overlap slot)'),
    CRONZIVO_PRODUCT_CODE: Joi.string()
      .uppercase()
      .pattern(/^[A-Z][A-Z0-9_]*$/)
      .default('SCANFLOW')
      .description('CronZivo product code used as the token audience'),
    CRONZIVO_ENVIRONMENT: Joi.string()
      .uppercase()
      .valid('DEVELOPMENT', 'STAGING', 'PRODUCTION')
      .default('PRODUCTION')
      .description('CronZivo environment used as the token audience'),
    CRONZIVO_ALLOWED_ORIGINS: Joi.string()
      .allow('')
      .default('')
      .description(
        'comma-separated browser origins allowed to call the prefix',
      ),
    CRONZIVO_MGMT_PREFIX: Joi.string()
      .pattern(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
      .default('/internal/cron')
      .description('Cron Management API mount prefix'),
    CRONZIVO_BULK_RUN_CONCURRENCY: Joi.number()
      .integer()
      .min(1)
      .default(1)
      .description('max bulk-run jobs accepted at once'),
    CRONZIVO_EXECUTION_RETENTION_DAYS: Joi.number()
      .integer()
      .min(0)
      .default(30)
      .description('execution history TTL in days; 0 disables the TTL index'),
    CRONZIVO_RECONCILE_SEC: Joi.number()
      .integer()
      .min(5)
      .default(30)
      .description('scheduler reconcile interval in seconds'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema
  .prefs({ errors: { label: 'key' } })
  .validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const cronzivoKey = String(envVars.CRONZIVO_API_KEY ?? '');
const cronzivoKeySecondary = String(envVars.CRONZIVO_API_KEY_SECONDARY ?? '');

if (cronzivoKeySecondary && cronzivoKeySecondary === cronzivoKey) {
  throw new Error(
    'Config validation error: CRONZIVO_API_KEY_SECONDARY must differ from CRONZIVO_API_KEY',
  );
}

if (envVars.NODE_ENV === 'production' && cronzivoKey) {
  const weak =
    cronzivoKey.length < 32 ||
    /^(change|replace|your|example|placeholder|test)/i.test(cronzivoKey);
  if (weak) {
    throw new Error(
      'Config validation error: CRONZIVO_API_KEY must be at least 32 random characters in production',
    );
  }
}

const cronzivoAllowedOrigins = String(envVars.CRONZIVO_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const cronzivoPrefix = String(envVars.CRONZIVO_MGMT_PREFIX ?? '/internal/cron');
const normalizedCronzivoPrefix =
  cronzivoPrefix === '/' ? '/' : `/${cronzivoPrefix.replace(/^\/+|\/+$/g, '')}`;

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
  dashboard: {
    timezone: envVars.DASHBOARD_TIMEZONE,
    queryMaxMs: envVars.DASHBOARD_QUERY_MAX_MS,
    nearLimitPct: envVars.DASHBOARD_NEAR_LIMIT_PCT,
    cacheFreshSeconds: envVars.DASHBOARD_CACHE_FRESH_SECONDS,
    chartCacheSeconds: envVars.DASHBOARD_CHART_CACHE_SECONDS,
  },
  dailyLimit: {
    timezone: envVars.DAILY_LIMIT_TIMEZONE,
    alertThresholdPct: envVars.DAILY_ALERT_THRESHOLD_PCT,
  },
  support: {
    notifyEmails: envVars.SUPPORT_NOTIFY_EMAILS,
    firstResponseHours: envVars.SUPPORT_FIRST_RESPONSE_HOURS,
    autocloseDays: envVars.SUPPORT_AUTOCLOSE_DAYS,
    maxAttachmentMb: envVars.SUPPORT_MAX_ATTACHMENT_MB,
    maxFiles: envVars.SUPPORT_MAX_FILES,
    maxTotalMb: envVars.SUPPORT_MAX_TOTAL_MB,
    maxImageMb: envVars.SUPPORT_MAX_IMAGE_MB,
    maxDocumentMb: envVars.SUPPORT_MAX_DOCUMENT_MB,
    maxTextMb: envVars.SUPPORT_MAX_TEXT_MB,
    maxArchiveMb: envVars.SUPPORT_MAX_ARCHIVE_MB,
    maxVideoMb: envVars.SUPPORT_MAX_VIDEO_MB,
    ticketStorageMb: envVars.SUPPORT_TICKET_STORAGE_MB,
    orgStorageMb: envVars.SUPPORT_ORG_STORAGE_MB,
    uploadMbPerHour: envVars.SUPPORT_UPLOAD_MB_PER_HOUR,
    minFreeDiskMb: envVars.SUPPORT_MIN_FREE_DISK_MB,
    uploadTmpDir: envVars.SUPPORT_UPLOAD_TMP_DIR,
    allowedKinds: envVars.SUPPORT_ALLOWED_KINDS,
    mediaTokenSecret: envVars.SUPPORT_MEDIA_TOKEN_SECRET,
    mediaTokenTtlSeconds: envVars.SUPPORT_MEDIA_TOKEN_TTL_SECONDS,
    storageDriver: envVars.SUPPORT_STORAGE_DRIVER as 'local' | 's3',
    uploadDir: envVars.SUPPORT_UPLOAD_DIR,
    rateCreatePerHour: envVars.SUPPORT_RATE_CREATE_PER_HOUR,
    rateReplyPerHour: envVars.SUPPORT_RATE_REPLY_PER_HOUR,
    maxActivePerOrg: envVars.SUPPORT_MAX_ACTIVE_PER_ORG,
  },
  notification: {
    quotaThresholds: envVars.NOTIFY_QUOTA_THRESHOLDS,
    subscriptionReminderDays: envVars.NOTIFY_SUBSCRIPTION_REMINDER_DAYS,
    readRetentionDays: envVars.NOTIFY_READ_RETENTION_DAYS,
    unreadRetentionDays: envVars.NOTIFY_UNREAD_RETENTION_DAYS,
    unreadCountCap: envVars.NOTIFY_UNREAD_COUNT_CAP,
    reminderIntervalMinutes: envVars.NOTIFY_REMINDER_INTERVAL_MINUTES,
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
  cronzivo: {
    apiKey: cronzivoKey,
    apiKeySecondary: cronzivoKeySecondary,
    productCode: envVars.CRONZIVO_PRODUCT_CODE,
    environment: envVars.CRONZIVO_ENVIRONMENT,
    allowedOrigins: cronzivoAllowedOrigins,
    mgmtPrefix: normalizedCronzivoPrefix,
    bulkRunConcurrency: envVars.CRONZIVO_BULK_RUN_CONCURRENCY,
    executionRetentionDays: envVars.CRONZIVO_EXECUTION_RETENTION_DAYS,
    reconcileSec: envVars.CRONZIVO_RECONCILE_SEC,
  },
};

export default config;
