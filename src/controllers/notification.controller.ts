import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../utils/catchAsync.js';
import { pick } from '../utils/pick.js';
import * as notificationService from '../services/notification.service.js';
import { createResponse } from '../services/common.service.js';

export const listNotifications = catchAsync(
  async (req: Request, res: Response) => {
    // Auth middleware thi user_id leve che
    const filter: Record<string, any> = { user_id: (req.user as any)._id };
    if (String(req.query.unread_only) === 'true') {
      filter.is_read = false;
    }
    const options = pick(req.query, ['page', 'limit', 'sortBy']);

    const result = await notificationService.listNotifications(filter, options);
    res.status(result.status).json(result);
  },
);

export const unreadCount = catchAsync(async (req: Request, res: Response) => {
  const filter = { user_id: (req.user as any)._id };
  const result = await notificationService.unreadCount(filter);
  res.status(result.status).json(result);
});

export const markRead = catchAsync(async (req: Request, res: Response) => {
  const filter = {
    _id: req.params.notificationId,
    user_id: (req.user as any)._id, // Security: user faktu potani notification j read kari sake
  };
  const result = await notificationService.markRead(filter);
  res.status(result.status).json(result);
});

export const readAll = catchAsync(async (req: Request, res: Response) => {
  const filter = { user_id: (req.user as any)._id, is_read: false };
  const result = await notificationService.readAll(filter);
  res.status(result.status).json(result);
});
