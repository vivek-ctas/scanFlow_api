import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as planService from '../../services/admin/plans.service.js';
import { createResponse } from '../../services/common.service.js';

export const listPlans = catchAsync(async (req: Request, res: Response) => {
  const filter = pick(req.query, [
    'search',
    'status',
    'is_custom_plan',
    'date_from',
    'date_to',
  ]);
  const options = pick(req.query, ['sort_by', 'limit', 'page']);
  const result = await planService.listPlans(filter, options);
  res.status(result.status).json(result);
});

export const listPublicPlans = catchAsync(
  async (_req: Request, res: Response) => {
    const result = await planService.listPublicPlans();
    res.status(result.status).json(result);
  },
);

export const createPlan = catchAsync(async (req: Request, res: Response) => {
  const result = await planService.createPlan(req.body);
  res.status(result.status).json(result);
});

export const getPlan = catchAsync(async (req: Request, res: Response) => {
  const plan = await planService.getPlanById(String(req.params.planId));
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Plan fetched successfully.', { plan }),
    );
});

export const updatePlan = catchAsync(async (req: Request, res: Response) => {
  const plan = await planService.updatePlanById(
    String(req.params.planId),
    req.body,
  );
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Plan updated successfully.', { plan }),
    );
});

export const updatePlanStatus = catchAsync(
  async (req: Request, res: Response) => {
    const plan = await planService.updatePlanStatusById(
      String(req.params.planId),
      req.body,
    );
    res.status(httpStatus.OK).json(
      createResponse(httpStatus.OK, 'Plan status updated successfully.', {
        plan,
      }),
    );
  },
);

export const deletePlan = catchAsync(async (req: Request, res: Response) => {
  const plan = await planService.deletePlanById(String(req.params.planId));
  res
    .status(httpStatus.OK)
    .json(
      createResponse(httpStatus.OK, 'Plan deleted successfully.', { plan }),
    );
});
