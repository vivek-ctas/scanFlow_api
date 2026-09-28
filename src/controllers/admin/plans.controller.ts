import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import * as subscriptionService from '../../services/subscription.service.js';

export const listPlans = catchAsync(async (_req: Request, res: Response) => {
  const result = await subscriptionService.listPlans();
  res.status(result.status).json(result);
});
