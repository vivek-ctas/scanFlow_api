import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import * as subscriptionService from '../../services/subscription.service.js';
import { dispatchSubscriptionGrantEmails } from '../../services/subscription-email.service.js';
import { createResponse } from '../../services/common.service.js';
import { Request, Response } from 'express';

const resolveOrgAndAssert = async (req: Request) => {
  const organizationId = subscriptionService.resolveOrganizationScope(
    String(req.params.organizationId),
    req.user,
  );
  await subscriptionService.assertOrganizationActive(organizationId);
  return organizationId;
};

export const getSubscription = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result =
      await subscriptionService.getSubscriptionSummary(organizationId);
    res.status(result.status).json(result);
  },
);

export const getOrganizationUsage = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result =
      await subscriptionService.getOrganizationUsage(organizationId);
    res.status(result.status).json(result);
  },
);

export const assignPlan = catchAsync(async (req: Request, res: Response) => {
  const organizationId = await resolveOrgAndAssert(req);
  const sub = await subscriptionService.grantSubscription(
    organizationId,
    req.body.plan_id,
    {
      trialDays: 0,
      billingCycle: req.body.billing_cycle,
      startDate: req.body.start_date ?? null,
    },
  );
  void dispatchSubscriptionGrantEmails(organizationId, sub as any);
  res.status(httpStatus.CREATED).json(
    createResponse(httpStatus.CREATED, 'Plan assigned successfully.', {
      subscription: sub,
      futureQueue:
        await subscriptionService.getOrganizationSubscriptionQueue(
          organizationId,
        ),
    }),
  );
});

export const renewSubscription = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const mode = req.body.mode ?? 'continue';
    const result = await subscriptionService.renewSubscription(
      organizationId,
      mode,
      {
        planId: req.body.plan_id,
        billingCycle: req.body.billing_cycle,
      },
    );
    res.status(result.status).json(result);
  },
);

export const cancelActiveSubscription = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result = await subscriptionService.cancelActiveSubscription(
      organizationId,
      req.body.reason,
    );
    res.status(result.status).json(result);
  },
);

export const forceActivateSubscription = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result = await subscriptionService.forceActivateSubscription(
      organizationId,
      req.body.plan_id,
      {
        trialDays: req.body.trial_days ?? 0,
        billingCycle: req.body.billing_cycle,
        startDate: req.body.start_date ?? null,
      },
    );
    res.status(result.status).json(result);
  },
);

export const cancelQueuedSubscription = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result = await subscriptionService.cancelQueuedSubscription(
      organizationId,
      req.body.subscription_id,
    );
    res.status(result.status).json(result);
  },
);

export const reorderSubscriptionQueue = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result = await subscriptionService.reorderSubscriptionQueue(
      organizationId,
      req.body.orderedSubscriptionIds,
    );
    res.status(result.status).json(result);
  },
);

export const adjustScanLimits = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = await resolveOrgAndAssert(req);
    const result = await subscriptionService.adjustScanLimits(
      organizationId,
      req.body.subscription_id,
      req.body.adjustments,
    );
    res.status(result.status).json(result);
  },
);
