import { catchAsync } from '../../utils/catchAsync.js';
import { pick } from '../../utils/pick.js';
import * as webhookService from '../../services/user/webhooks.service.js';
import { Request, Response } from 'express';

export const getWebhookConfig = catchAsync(
  async (req: Request, res: Response) => {
    const result = await webhookService.getWebhookConfig(
      String(req.query.organizationId || ''),
      req.user,
    );
    res.status(result.status).json(result);
  },
);

export const upsertWebhookConfig = catchAsync(
  async (req: Request, res: Response) => {
    const result = await webhookService.upsertWebhookConfig(req.body, req.user);
    res.status(result.status).json(result);
  },
);

export const deleteWebhookConfig = catchAsync(
  async (req: Request, res: Response) => {
    const result = await webhookService.deleteWebhookConfig(
      String(req.query.organizationId || ''),
      req.user,
    );
    res.status(result.status).json(result);
  },
);

export const listWebhookDeliveries = catchAsync(
  async (req: Request, res: Response) => {
    const filter = pick(req.query, ['organizationId', 'status']);
    const options = pick(req.query, ['sortBy', 'limit', 'page']);
    const result = await webhookService.listWebhookDeliveries(
      filter,
      options,
      req.user,
    );
    res.status(result.status).json(result);
  },
);
