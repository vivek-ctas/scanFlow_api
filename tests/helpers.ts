import mongoose from 'mongoose';
import config from '../src/config/config.js';
import {
  User,
  Organization,
  Plan,
  Subscription,
  Usage,
  GuestLead,
  Contact,
  Payment,
  Scan,
  WebhookConfig,
  WebhookDelivery,
  Country,
  WebSettings,
} from '../src/models/index.js';

let connected = false;

export const connectDb = async (): Promise<void> => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(config.mongoose.url);
  }
  connected = true;
};

export const disconnectDb = async (): Promise<void> => {
  if (connected) {
    await mongoose.disconnect();
    connected = false;
  }
};

const MODELS = [
  User,
  Organization,
  Plan,
  Subscription,
  Usage,
  GuestLead,
  Contact,
  Payment,
  Scan,
  WebhookConfig,
  WebhookDelivery,
  Country,
  WebSettings,
];

export const clearDb = async (): Promise<void> => {
  await Promise.all(MODELS.map((model) => (model as any).deleteMany({})));
};

/** Drops every collection so mongoose re-creates indexes from the current schema. */
export const dropCollections = async (): Promise<void> => {
  await Promise.all(
    MODELS.map(async (model) => {
      try {
        await (model as any).collection.drop();
      } catch {
        // collection may not exist yet
      }
    }),
  );
};

export const createOrg = async (overrides: Record<string, any> = {}) =>
  Organization.create({ company_name: 'Test Org', status: 1, ...overrides });

export const createPlan = async (overrides: Record<string, any> = {}) => {
  const { scan_limit, ...rest } = overrides;
  const scanLimit = scan_limit ?? 100;
  const billingCycle = rest.billing_cycle ?? 'month';
  const price = rest.price ?? 100;
  return Plan.create({
    name: 'Test Plan',
    price,
    // Quarterly amount is always numeric; `billing_cycle` decides what is charged.
    price_quarterly: price * 3,
    billing_cycle: billingCycle,
    currency: 'INR',
    trial_days: 0,
    features: [{ features_name: 'scan', scan_limit: scanLimit }],
    marketing_features: [],
    status: 1,
    is_custom_plan: false,
    is_popular: false,
    discount: 0,
    ...rest,
  });
};

/**
 * Country rows are the source of truth the organization write path resolves
 * against, so any test that sends `country_name` needs one seeded.
 */
export const createCountry = async (overrides: Record<string, any> = {}) =>
  Country.create({
    country_code: 'IND',
    country_name: 'India',
    currency_code: 'INR',
    aliases: [],
    ...overrides,
  });

export interface TestUserDoc {
  id: string;
  _id: string;
  role: string;
  is_super_admin?: boolean;
  organization_id?: string;
  email: string;
}

export const createUser = async (
  role: string,
  organization_id: string | null,
  overrides: Record<string, any> = {},
): Promise<TestUserDoc> => {
  const user = await User.create({
    first_name: 'Test',
    last_name: 'User',
    email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    role,
    is_super_admin: false,
    organization_id,
    status: 1,
    ...overrides,
  });
  return {
    id: String(user._id),
    _id: String(user._id),
    role: user.role,
    is_super_admin: user.is_super_admin,
    organization_id: user.organization_id
      ? String(user.organization_id)
      : undefined,
    email: user.email,
  };
};

export const createAdminUser = async (overrides: Record<string, any> = {}) => {
  const user = await User.create({
    first_name: 'Super',
    last_name: 'Admin',
    email: `super-${Date.now()}@example.com`,
    role: 'SUPER_ADMIN',
    is_super_admin: true,
    organization_id: null,
    status: 1,
    ...overrides,
  });
  return user;
};

export const grant = async (
  organizationId: string,
  planId: string,
  options: Record<string, any> = {},
) => {
  const { grantSubscription } =
    await import('../src/services/subscription.service.js');
  return grantSubscription(organizationId, planId, options);
};

export const scan = async (organizationId: string, clientScanId?: string) => {
  const { createScan } = await import('../src/services/user/scans.service.js');
  const user = await createUser('OPERATOR', organizationId);
  return createScan(
    {
      organization_id: organizationId,
      client_scan_id: clientScanId ?? `scan-${Date.now()}-${Math.random()}`,
      barcode: `BC-${clientScanId ?? 'x'}`,
    },
    user,
  );
};

/** Live `used` counter from the active-subscription Redis hash. */
export const activeUsed = async (organizationId: string): Promise<number> => {
  const { getRedis } = await import('../src/queues/redis.js');
  const { activeSubscriptionCacheKey } =
    await import('../src/services/quota.service.js');
  const raw = await getRedis().hget(
    activeSubscriptionCacheKey(organizationId),
    'used',
  );
  return parseInt(String(raw ?? '0'), 10) || 0;
};
