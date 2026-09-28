import mongoose from 'mongoose';
import config from '../src/config/config.js';
import {
  User,
  Organization,
  Plan,
  Subscription,
  Usage,
  GuestLead,
  Payment,
  Scan,
  WebhookConfig,
  WebhookDelivery,
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
  Payment,
  Scan,
  WebhookConfig,
  WebhookDelivery,
];

export const clearDb = async (): Promise<void> => {
  await Promise.all(
    MODELS.map((model) => (model as any).deleteMany({})),
  );
};

export const createOrg = async (overrides: Record<string, any> = {}) =>
  Organization.create({ name: 'Test Org', status: 1, ...overrides });

export const createPlan = async (overrides: Record<string, any> = {}) =>
  Plan.create({
    name: 'Test Plan',
    billingCycle: 'monthly',
    amount: 100,
    currency: 'INR',
    trialDays: 0,
    scanLimit: 100,
    isActive: true,
    isPublic: true,
    ...overrides,
  });

export interface TestUserDoc {
  _id: string;
  role: string;
  isSuperAdmin?: boolean;
  organizationId?: string;
  email: string;
}

export const createUser = async (
  role: string,
  organizationId: string | null,
  overrides: Record<string, any> = {},
): Promise<TestUserDoc> => {
  const user = await User.create({
    first_name: 'Test',
    last_name: 'User',
    email: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    role,
    isSuperAdmin: false,
    organizationId,
    status: 1,
    ...overrides,
  });
  return {
    _id: String(user._id),
    role: user.role,
    isSuperAdmin: user.isSuperAdmin,
    organizationId: user.organizationId ? String(user.organizationId) : undefined,
    email: user.email,
  };
};

export const createAdminUser = async (overrides: Record<string, any> = {}) => {
  const user = await User.create({
    first_name: 'Super',
    last_name: 'Admin',
    email: `super-${Date.now()}@example.com`,
    role: 'SUPER_ADMIN',
    isSuperAdmin: true,
    organizationId: null,
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
  const { grantSubscription } = await import(
    '../src/services/subscription.service.js'
  );
  return grantSubscription(organizationId, planId, options);
};

export const scan = async (organizationId: string, clientScanId?: string) => {
  const { createScan } = await import('../src/services/user/scans.service.js');
  const user = await createUser('OPERATOR', organizationId);
  return createScan(
    {
      organizationId,
      clientScanId: clientScanId ?? `scan-${Date.now()}-${Math.random()}`,
    },
    user,
  );
};