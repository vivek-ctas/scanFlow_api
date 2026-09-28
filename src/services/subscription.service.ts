import httpStatus from 'http-status';
import mongoose from 'mongoose';
import { Organization } from '../models/organization.model.js';
import { Plan, IPlan } from '../models/plan.model.js';
import {
  Subscription,
  ISubscription,
  SubscriptionStatus,
} from '../models/subscription.model.js';
import { Payment } from '../models/payment.model.js';
import { Usage } from '../models/usage.model.js';
import { Scan } from '../models/scan.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse, toObjectId } from './common.service.js';
import {
  computeExpiresAt,
  USAGE_RETENTION_DAYS,
} from '../utils/subscription-expiry.util.js';
import { scanLimitOf, priceForCycle } from '../utils/plan-features.util.js';
import {
  writeActiveSubscriptionCache,
  deleteActiveSubscriptionCache,
  flushActiveSubUsage,
  readActiveSubUsage,
} from './quota.service.js';
import { isSuperAdmin } from '../middlewares/guards/isSuperAdmin.js';

const activeSubQuery = (organizationId: string) => ({
  organization_id: toObjectId(organizationId),
  status: 'active' as SubscriptionStatus,
});

const futureQuery = (organizationId: string) => ({
  organization_id: toObjectId(organizationId),
  status: 'future' as SubscriptionStatus,
});

export const assertOrganizationActive = async (
  organizationId: string,
): Promise<InstanceType<typeof Organization>> => {
  const org = await Organization.findById(organizationId);
  if (!org || org.status !== 1) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Organization is not active or not found',
    );
  }
  return org;
};

/** Non-super-admin callers are forced into their own organization (§9). */
export const resolveOrganizationScope = (
  organizationId: string,
  reqUser: any,
): string => {
  if (!isSuperAdmin(reqUser)) {
    return String(reqUser.organization_id);
  }
  return organizationId;
};

export const getActiveSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> =>
  Subscription.findOne(activeSubQuery(organizationId)).sort({ created_at: -1 });

export const getOrganizationSubscriptionQueue = async (
  organizationId: string,
): Promise<ISubscription[]> =>
  Subscription.find(futureQuery(organizationId)).sort({ queue_priority: 1 });

/** Creates the manual Payment row used by admin grants and renewals. */
const createManualPaymentRecord = async (data: {
  organization_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  price: number;
  currency_code: string;
  billing_cycle: 'month' | 'quarterly';
}): Promise<mongoose.Types.ObjectId> => {
  const payment = await Payment.create({
    organization_id: data.organization_id,
    plan_id: data.plan_id,
    gateway: 'manual',
    price: data.price,
    currency_code: data.currency_code,
    billing_cycle: data.billing_cycle,
    status: 'TXN_SUCCESS',
    paid_at: new Date(),
    lead_id: null,
  });
  return payment._id;
};

const writeActiveSubCache = async (
  sub: ISubscription,
  resetUsed: boolean = true,
): Promise<void> => {
  await writeActiveSubscriptionCache(
    String(sub.organization_id),
    scanLimitOf(sub.features),
    sub.expires_at,
    resetUsed,
  );
};

const deleteActiveSubCache = async (organizationId: string): Promise<void> => {
  await deleteActiveSubscriptionCache(organizationId);
};

/**
 * Cold-cache fallback (§4 -2 handling): the only time the scan hot path
 * touches the Subscription collection. Populates the cache from Mongo
 * (seeded with the max of the durable Usage row and the scans created since
 * the subscription started) and reports whether an active subscription exists.
 */
export const populateActiveSubCache = async (
  organizationId: string,
): Promise<boolean> => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    return false;
  }
  const usage = await Usage.findOne({
    organization_id: toObjectId(organizationId),
    subscription_id: active._id,
  });
  const scansFromStart = await Scan.countDocuments({
    organization_id: toObjectId(organizationId),
    created_at: { $gte: active.started_at },
  });
  const used = Math.max(usage?.usage ?? 0, scansFromStart);
  await writeActiveSubscriptionCache(
    String(active.organization_id),
    scanLimitOf(active.features),
    active.expires_at,
    false,
    used,
  );
  return true;
};

export const createUsageForSubscription = async (
  sub: ISubscription,
): Promise<InstanceType<typeof Usage>> =>
  Usage.create({
    feature_name: 'scan',
    organization_id: sub.organization_id,
    subscription_id: sub._id,
    scan_limit: scanLimitOf(sub.features),
    usage: 0,
    started_at: sub.started_at,
    expires_at: sub.expires_at,
    is_exhausted: false,
    purge_after: new Date(
      sub.expires_at.getTime() + USAGE_RETENTION_DAYS * 86400000,
    ),
  });

const planPriceFor = (
  plan: IPlan,
  billingCycle: 'month' | 'quarterly',
): number => {
  try {
    return priceForCycle(plan.price, plan.price_quarterly, billingCycle);
  } catch (err: any) {
    if (err.message === 'PLAN_QUARTERLY_PRICE_REQUIRED') {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Quarterly pricing is not configured for this plan',
      );
    }
    throw err;
  }
};

const decideInitialStatus = async (
  organizationId: string,
  billingCycle: 'month' | 'quarterly',
  trialDays: number,
  forceActive: boolean,
): Promise<{
  status: SubscriptionStatus;
  queuePriority: number;
  startedAt: Date;
  expiresAt: Date;
}> => {
  if (forceActive) {
    const now = new Date();
    return {
      status: 'active',
      queuePriority: 0,
      startedAt: now,
      expiresAt: computeExpiresAt(billingCycle, trialDays, now),
    };
  }
  const active = await Subscription.findOne(
    activeSubQuery(organizationId),
  ).sort({ created_at: -1 });
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queue_priority: 1,
  });
  if (!active && futures.length === 0) {
    const now = new Date();
    return {
      status: 'active',
      queuePriority: 0,
      startedAt: now,
      expiresAt: computeExpiresAt(billingCycle, trialDays, now),
    };
  }
  const chainSource = active ?? futures[futures.length - 1];
  const startedAt = chainSource ? chainSource.expires_at : new Date();
  return {
    status: 'future',
    queuePriority: futures.length
      ? (futures[futures.length - 1]?.queue_priority ?? 0) + 1
      : 1,
    startedAt,
    expiresAt: computeExpiresAt(billingCycle, trialDays, startedAt),
  };
};

/**
 * Single, shared grant entry point (§3). Every caller (admin assign-plan,
 * Stripe/Razorpay success, renew-recreate, force-activate) routes through it.
 */
export const grantSubscription = async (
  organizationId: string,
  planId: string,
  options: {
    trialDays?: number;
    forceActive?: boolean;
    billingCycle?: 'month' | 'quarterly';
    paymentId?: string;
  } = {},
): Promise<ISubscription> => {
  const plan = await Plan.findById(planId);
  if (!plan || plan.status !== 1) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Plan not found or not active');
  }
  const billingCycle = options.billingCycle ?? 'month';
  const trialDays = options.trialDays ?? 0;
  const planPrice = planPriceFor(plan, billingCycle);
  const decided = await decideInitialStatus(
    organizationId,
    billingCycle,
    trialDays,
    Boolean(options.forceActive),
  );

  const orgId = toObjectId(organizationId);
  const paymentId = options.paymentId
    ? toObjectId(options.paymentId)
    : await createManualPaymentRecord({
        organization_id: orgId,
        plan_id: plan._id,
        price: planPrice,
        currency_code: plan.currency || 'inr',
        billing_cycle: billingCycle,
      });

  const sub = await Subscription.create({
    organization_id: orgId,
    plan_id: plan._id,
    payment_id: paymentId,
    features: plan.features.map((f) => ({
      features_name: f.features_name,
      scan_limit: f.scan_limit,
    })),
    billing_cycle: billingCycle,
    status: decided.status,
    started_at: decided.startedAt,
    expires_at: decided.expiresAt,
    queue_priority: decided.queuePriority,
    reminders_sent: [],
    marketing_features: plan.marketing_features ?? [],
    trial_days: trialDays,
    currency_code: plan.currency || 'inr',
    plan_price: planPrice,
    plan_name: plan.name,
    is_plan_cancel: false,
  });

  if (sub.status === 'active') {
    await createUsageForSubscription(sub);
    await writeActiveSubCache(sub, true);
  }
  return sub;
};

export const promoteEarliestFutureSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> => {
  const earliest = await Subscription.findOne(futureQuery(organizationId)).sort(
    {
      queue_priority: 1,
    },
  );
  if (!earliest) {
    return null;
  }
  earliest.status = 'active';
  earliest.queue_priority = 0;
  await earliest.save();
  await createUsageForSubscription(earliest);
  await writeActiveSubCache(earliest, true);
  await normalizeQueuePriorities(organizationId);
  return earliest;
};

export const normalizeQueuePriorities = async (
  organizationId: string,
): Promise<void> => {
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queue_priority: 1,
  });
  const ops = futures.map((sub, index) => ({
    updateOne: {
      filter: { _id: sub._id },
      update: { $set: { queue_priority: index + 1 } },
    },
  }));
  if (ops.length) {
    await Subscription.bulkWrite(ops);
  }
};

export const normalizeAllQueuePriorities = async (): Promise<void> => {
  const orgIds = await Subscription.distinct('organization_id', {
    status: 'future',
  });
  for (const orgId of orgIds) {
    await normalizeQueuePriorities(String(orgId));
  }
};

/**
 * Worker EVERY_MINUTE job (§12): expire overdue active subscriptions, then
 * promote the earliest queued successor when no active remains.
 */
export const activateEligibleSubscriptions = async (): Promise<void> => {
  const now = new Date();
  const orgIds = new Set<string>();

  const actives = await Subscription.find({ status: 'active' });
  for (const active of actives) {
    if (active.expires_at.getTime() <= now.getTime()) {
      const orgId = String(active.organization_id);
      await flushActiveSubUsage(orgId);
      await deleteActiveSubCache(orgId);
      active.status = 'expired';
      await active.save();
      orgIds.add(orgId);
    }
  }

  const dueFutures = await Subscription.find({
    status: 'future',
    started_at: { $lte: now },
  }).select('organization_id');
  for (const future of dueFutures) {
    orgIds.add(String(future.organization_id));
  }

  for (const orgId of orgIds) {
    const active = await Subscription.findOne(activeSubQuery(orgId));
    if (!active) {
      await promoteEarliestFutureSubscription(orgId);
    }
  }
};

export const renewSubscription = async (
  organizationId: string,
  mode: 'continue' | 'promote' | 'recreate',
  options: { planId?: string; billingCycle?: 'month' | 'quarterly' } = {},
) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    throw new ApiError(httpStatus.NOT_FOUND, 'NO_ACTIVE_SUBSCRIPTION');
  }

  if (mode === 'continue') {
    const newExpiry = computeExpiresAt(
      active.billing_cycle,
      active.trial_days && active.trial_days > 0 ? active.trial_days : 0,
      active.expires_at,
    );
    active.expires_at = newExpiry;
    await active.save();
    await writeActiveSubCache(active, false);

    const futures = await getOrganizationSubscriptionQueue(organizationId);
    if (futures.length) {
      const shiftOps = futures.map((sub, index) => ({
        updateOne: {
          filter: { _id: sub._id },
          update: { $set: { queue_priority: index + 2 } },
        },
      }));
      await Subscription.bulkWrite(shiftOps);
      const nextPaymentId = await createManualPaymentRecord({
        organization_id: active.organization_id,
        plan_id: active.plan_id,
        price: active.plan_price,
        currency_code: active.currency_code,
        billing_cycle: active.billing_cycle,
      });
      await Subscription.create({
        organization_id: toObjectId(organizationId),
        plan_id: active.plan_id,
        payment_id: nextPaymentId,
        features: active.features.map((f) => ({
          features_name: f.features_name,
          scan_limit: f.scan_limit,
        })),
        billing_cycle: active.billing_cycle,
        status: 'future',
        started_at: newExpiry,
        expires_at: computeExpiresAt(active.billing_cycle, 0, newExpiry),
        queue_priority: 1,
        reminders_sent: [],
        marketing_features: active.marketing_features ?? [],
        trial_days: 0,
        currency_code: active.currency_code,
        plan_price: active.plan_price,
        plan_name: active.plan_name,
        is_plan_cancel: false,
      });
    }
    await normalizeQueuePriorities(organizationId);
    return createResponse(httpStatus.OK, 'Subscription renewed.', {
      activeSubscription: await getActiveSubscription(organizationId),
      futureQueue: await getOrganizationSubscriptionQueue(organizationId),
    });
  }

  if (mode === 'promote') {
    const promoted = await promoteEarliestFutureSubscription(organizationId);
    if (!promoted) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        'No queued subscription to promote',
      );
    }
    return createResponse(
      httpStatus.OK,
      'Next queued subscription activated.',
      {
        subscription: promoted,
      },
    );
  }

  active.status = 'cancelled';
  active.cancellation_reason = 'recreate';
  await active.save();
  await flushActiveSubUsage(organizationId);
  await deleteActiveSubCache(organizationId);
  const created = await grantSubscription(
    organizationId,
    options.planId ?? String(active.plan_id),
    {
      trialDays: 0,
      billingCycle: options.billingCycle ?? active.billing_cycle,
    },
  );
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Subscription recreated.', {
    subscription: created,
    futureQueue: await getOrganizationSubscriptionQueue(organizationId),
  });
};

export const cancelActiveSubscription = async (
  organizationId: string,
  reason?: string,
) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    throw new ApiError(httpStatus.NOT_FOUND, 'NO_ACTIVE_SUBSCRIPTION');
  }
  await flushActiveSubUsage(organizationId);
  active.status = 'cancelled';
  active.cancellation_reason = reason || 'Cancelled';
  await active.save();
  await deleteActiveSubCache(organizationId);
  const promoted = await promoteEarliestFutureSubscription(organizationId);
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Active subscription cancelled.', {
    cancelledSubscription: active._id,
    promotedSubscription: promoted?._id ?? null,
  });
};

export const forceActivateSubscription = async (
  organizationId: string,
  planId: string,
  options: { trialDays?: number; billingCycle?: 'month' | 'quarterly' } = {},
) => {
  const existingActive = await getActiveSubscription(organizationId);
  if (existingActive) {
    await flushActiveSubUsage(organizationId);
    await Usage.deleteMany({ subscription_id: existingActive._id });
    existingActive.status = 'cancelled';
    existingActive.cancellation_reason = 'Force activated';
    await existingActive.save();
    await deleteActiveSubCache(organizationId);
  }
  const created = await grantSubscription(organizationId, planId, {
    trialDays: options.trialDays ?? 0,
    forceActive: true,
    billingCycle: options.billingCycle ?? 'month',
  });
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Subscription force-activated.', {
    subscription: created,
  });
};

export const getSubscriptionSummary = async (
  organizationId: string,
): Promise<ReturnType<typeof createResponse>> => {
  const active = await Subscription.findOne(activeSubQuery(organizationId))
    .populate('plan_id')
    .sort({ created_at: -1 });
  const futureQueue = await Subscription.find(futureQuery(organizationId))
    .populate('plan_id')
    .sort({ queue_priority: 1 });
  const usage = active
    ? await Usage.findOne({
        organization_id: toObjectId(organizationId),
        subscription_id: active._id,
      })
    : null;
  return createResponse(httpStatus.OK, 'Subscription fetched successfully.', {
    activeSubscription: active,
    futureQueue,
    usage,
  });
};

export const getOrganizationUsage = async (organizationId: string) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    return createResponse(
      httpStatus.OK,
      'Organization usage fetched successfully.',
      {
        organization_id: organizationId,
        usage: {
          period_count: 0,
          scan_limit: 0,
          quota_period: null,
          subscription_expires_at: null,
        },
      },
    );
  }
  const usage = await Usage.findOne({
    organization_id: toObjectId(organizationId),
    subscription_id: active._id,
  });
  const cache = await readActiveSubUsage(organizationId, active as any);
  return createResponse(
    httpStatus.OK,
    'Organization usage fetched successfully.',
    {
      organization_id: organizationId,
      usage: {
        period_count: cache?.used ?? usage?.usage ?? 0,
        scan_limit: scanLimitOf(active.features),
        quota_period: active.billing_cycle,
        subscription_expires_at: active.expires_at,
      },
    },
  );
};

export const listPlans = async () => {
  const plans = await Plan.find({ status: 1, is_custom_plan: false }).sort({
    price: 1,
  });
  return createResponse(httpStatus.OK, 'Plans fetched successfully.', {
    plans,
  });
};
