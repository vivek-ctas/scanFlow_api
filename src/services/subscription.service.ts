import httpStatus from 'http-status';
import { Organization } from '../models/organization.model.js';
import { Plan, IPlan } from '../models/plan.model.js';
import {
  Subscription,
  ISubscription,
  SubscriptionStatus,
} from '../models/subscription.model.js';
import { Usage } from '../models/usage.model.js';
import { ApiError } from '../utils/ApiError.js';
import { createResponse, toObjectId } from './common.service.js';
import {
  computeExpiresAt,
  USAGE_RETENTION_DAYS,
} from '../utils/subscription-expiry.util.js';
import {
  writeActiveSubscriptionCache,
  deleteActiveSubscriptionCache,
  resetScanCounters,
} from './quota.service.js';
import { isSuperAdmin } from '../middlewares/guards/isSuperAdmin.js';

const activeSubQuery = (organizationId: string) => ({
  organizationId: toObjectId(organizationId),
  status: 'active' as SubscriptionStatus,
});

const futureQuery = (organizationId: string) => ({
  organizationId: toObjectId(organizationId),
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
    return String(reqUser.organizationId);
  }
  return organizationId;
};

export const getActiveSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> =>
  Subscription.findOne(activeSubQuery(organizationId)).sort({ createdAt: -1 });

export const getOrganizationSubscriptionQueue = async (
  organizationId: string,
): Promise<ISubscription[]> =>
  Subscription.find(futureQuery(organizationId)).sort({ queuePriority: 1 });

const writeActiveSubCache = async (sub: ISubscription): Promise<void> => {
  await writeActiveSubscriptionCache(
    String(sub.organizationId),
    sub.scanLimit,
    sub.expiresAt,
    sub.billingCycle,
  );
};

const deleteActiveSubCache = async (organizationId: string): Promise<void> => {
  await deleteActiveSubscriptionCache(organizationId);
};

/**
 * Cold-cache fallback (§4 -2 handling): the only time the scan hot path
 * touches the Subscription collection. Populates the cache from Mongo and
 * reports whether an active subscription exists.
 */
export const populateActiveSubCache = async (
  organizationId: string,
): Promise<boolean> => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    return false;
  }
  await writeActiveSubCache(active);
  return true;
};

export const createUsageForSubscription = async (
  sub: ISubscription,
): Promise<InstanceType<typeof Usage>> =>
  Usage.create({
    organizationId: sub.organizationId,
    subscriptionId: sub._id,
    used: 0,
    limit: sub.scanLimit,
    startTime: sub.startedAt,
    endTime: sub.expiresAt,
    purgeAfter: new Date(
      sub.expiresAt.getTime() + USAGE_RETENTION_DAYS * 86400000,
    ),
  });

const decideInitialStatus = async (
  organizationId: string,
  plan: IPlan,
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
      expiresAt: computeExpiresAt(plan.billingCycle, trialDays, now),
    };
  }
  const active = await Subscription.findOne(
    activeSubQuery(organizationId),
  ).sort({
    createdAt: -1,
  });
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queuePriority: 1,
  });
  if (!active && futures.length === 0) {
    const now = new Date();
    return {
      status: 'active',
      queuePriority: 0,
      startedAt: now,
      expiresAt: computeExpiresAt(plan.billingCycle, trialDays, now),
    };
  }
  const chainSource = active ?? futures[futures.length - 1];
  const startedAt = chainSource ? chainSource.expiresAt : new Date();
  return {
    status: 'future',
    queuePriority: futures.length
      ? (futures[futures.length - 1]?.queuePriority ?? 0) + 1
      : 1,
    startedAt,
    expiresAt: computeExpiresAt(plan.billingCycle, trialDays, startedAt),
  };
};

/**
 * Single, shared grant entry point (§3). Every caller (admin assign-plan,
 * Stripe/Razorpay success, renew-recreate, force-activate) routes through it.
 */
export const grantSubscription = async (
  organizationId: string,
  planId: string,
  options: { trialDays?: number; forceActive?: boolean } = {},
): Promise<ISubscription> => {
  const plan = await Plan.findById(planId);
  if (!plan || !plan.isActive) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Plan not found or not active');
  }
  const trialDays = options.trialDays ?? 0;
  const decided = await decideInitialStatus(
    organizationId,
    plan,
    trialDays,
    Boolean(options.forceActive),
  );

  const sub = await Subscription.create({
    organizationId: toObjectId(organizationId),
    planId: plan._id,
    scanLimit: plan.scanLimit,
    billingCycle: plan.billingCycle,
    status: decided.status,
    startedAt: decided.startedAt,
    expiresAt: decided.expiresAt,
    usageResetAnchor: decided.startedAt,
    queuePriority: decided.queuePriority,
    planValidityDays: trialDays > 0 ? trialDays : undefined,
  });

  if (sub.status === 'active') {
    await createUsageForSubscription(sub);
    await writeActiveSubCache(sub);
  }
  return sub;
};

export const promoteEarliestFutureSubscription = async (
  organizationId: string,
): Promise<ISubscription | null> => {
  const earliest = await Subscription.findOne(futureQuery(organizationId)).sort(
    {
      queuePriority: 1,
    },
  );
  if (!earliest) {
    return null;
  }
  earliest.status = 'active';
  earliest.queuePriority = 0;
  await earliest.save();
  await createUsageForSubscription(earliest);
  await writeActiveSubCache(earliest);
  await normalizeQueuePriorities(organizationId);
  return earliest;
};

export const normalizeQueuePriorities = async (
  organizationId: string,
): Promise<void> => {
  const futures = await Subscription.find(futureQuery(organizationId)).sort({
    queuePriority: 1,
  });
  const ops = futures.map((sub, index) => ({
    updateOne: {
      filter: { _id: sub._id },
      update: { $set: { queuePriority: index + 1 } },
    },
  }));
  if (ops.length) {
    await Subscription.bulkWrite(ops);
  }
};

export const normalizeAllQueuePriorities = async (): Promise<void> => {
  const orgIds = await Subscription.distinct('organizationId', {
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
    if (active.expiresAt.getTime() <= now.getTime()) {
      active.status = 'expired';
      await active.save();
      await deleteActiveSubCache(String(active.organizationId));
      orgIds.add(String(active.organizationId));
    }
  }

  const dueFutures = await Subscription.find({
    status: 'future',
    startedAt: { $lte: now },
  }).select('organizationId');
  for (const future of dueFutures) {
    orgIds.add(String(future.organizationId));
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
  options: { planId?: string } = {},
) => {
  const active = await getActiveSubscription(organizationId);
  if (!active) {
    throw new ApiError(httpStatus.NOT_FOUND, 'NO_ACTIVE_SUBSCRIPTION');
  }

  if (mode === 'continue') {
    const newExpiry = computeExpiresAt(
      active.billingCycle,
      active.planValidityDays && active.planValidityDays > 0
        ? active.planValidityDays
        : 0,
      active.expiresAt,
    );
    active.expiresAt = newExpiry;
    await active.save();
    await writeActiveSubCache(active);

    const futures = await getOrganizationSubscriptionQueue(organizationId);
    if (futures.length) {
      const shiftOps = futures.map((sub, index) => ({
        updateOne: {
          filter: { _id: sub._id },
          update: { $set: { queuePriority: index + 2 } },
        },
      }));
      await Subscription.bulkWrite(shiftOps);
      await Subscription.create({
        organizationId: toObjectId(organizationId),
        planId: active.planId,
        scanLimit: active.scanLimit,
        billingCycle: active.billingCycle,
        status: 'future',
        startedAt: newExpiry,
        expiresAt: computeExpiresAt(active.billingCycle, 0, newExpiry),
        usageResetAnchor: newExpiry,
        queuePriority: 1,
        planValidityDays: active.planValidityDays,
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
  active.cancellationReason = 'recreate';
  await active.save();
  await deleteActiveSubCache(organizationId);
  const created = await grantSubscription(
    organizationId,
    options.planId ?? String(active.planId),
    {
      trialDays: 0,
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
  active.status = 'cancelled';
  active.cancellationReason = reason || 'Cancelled';
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
  options: { trialDays?: number } = {},
) => {
  const existingActive = await getActiveSubscription(organizationId);
  if (existingActive) {
    existingActive.status = 'cancelled';
    existingActive.cancellationReason = 'Force activated';
    await existingActive.save();
    await Usage.deleteMany({ subscriptionId: existingActive._id });
    await deleteActiveSubCache(organizationId);
  }
  const created = await grantSubscription(organizationId, planId, {
    trialDays: options.trialDays ?? 0,
    forceActive: true,
  });
  await resetScanCounters(organizationId);
  await normalizeQueuePriorities(organizationId);
  return createResponse(httpStatus.OK, 'Subscription force-activated.', {
    subscription: created,
  });
};

export const getSubscriptionSummary = async (
  organizationId: string,
): Promise<ReturnType<typeof createResponse>> => {
  const active = await Subscription.findOne(activeSubQuery(organizationId))
    .populate('planId')
    .sort({ createdAt: -1 });
  const futureQueue = await Subscription.find(futureQuery(organizationId))
    .populate('planId')
    .sort({ queuePriority: 1 });
  const usage = active
    ? await Usage.findOne({
        organizationId: toObjectId(organizationId),
        subscriptionId: active._id,
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
        organizationId,
        usage: { periodCount: 0, quotaLimit: 0, quotaPeriod: null },
      },
    );
  }
  const usage = await Usage.findOne({
    organizationId: toObjectId(organizationId),
    subscriptionId: active._id,
  });
  return createResponse(
    httpStatus.OK,
    'Organization usage fetched successfully.',
    {
      organizationId,
      usage: {
        periodCount: usage?.used ?? 0,
        quotaLimit: active.scanLimit,
        quotaPeriod: active.billingCycle,
        subscriptionExpiresAt: active.expiresAt,
      },
    },
  );
};

export const listPlans = async () => {
  const plans = await Plan.find({ isActive: true, isPublic: true }).sort({
    amount: 1,
  });
  return createResponse(httpStatus.OK, 'Plans fetched successfully.', {
    plans,
  });
};
