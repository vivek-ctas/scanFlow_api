import httpStatus from 'http-status';
import { catchAsync } from '../../utils/catchAsync.js';
import * as subscriptionService from '../../services/subscription.service.js';
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
    req.body.planId,
    { trialDays: 0 },
  );
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
      { planId: req.body.planId },
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
      req.body.planId,
      { trialDays: req.body.trialDays ?? 0 },
    );
    res.status(result.status).json(result);
  },
);
