import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import * as emailService from '../../services/subscription-email.service.js';

export const resendWelcome = catchAsync(async (req: Request, res: Response) => {
  const result = await emailService.resendSubscriptionEmail(
    req.body.organization_id,
    'welcome',
  );
  res.status(result.status).json(result);
});

export const resendRenewal = catchAsync(async (req: Request, res: Response) => {
  const result = await emailService.resendSubscriptionEmail(
    req.body.organization_id,
    'renewal',
  );
  res.status(result.status).json(result);
});

export const sendTest = catchAsync(async (req: Request, res: Response) => {
  const result = await emailService.sendTestEmail(
    req.body.to,
    req.body.subject,
    req.body.message ?? '',
  );
  res.status(result.status).json(result);
});
