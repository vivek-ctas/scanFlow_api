import httpStatus from 'http-status';
import mongoose from 'mongoose';
import {
  Notification,
  NotificationType,
  NotificationSeverity,
} from '../models/notification.model.js';
import { createResponse } from './common.service.js';
import { logger } from '../config/logger.js';

export interface CreateForUsersInput {
  user_ids: string[];
  type: NotificationType;
  severity: NotificationSeverity;
  title?: string;
  message?: string;
  action_url?: string;
  dedupe_key?: string;
}

export const createForUsers = async (inputs: CreateForUsersInput) => {
  const { user_ids, type, severity, title, message, action_url, dedupe_key } =
    inputs;
  if (!Array.isArray(user_ids) || user_ids.length === 0) return [];

  const created: any[] = [];
  for (const userIdStr of user_ids) {
    try {
      const userId = new mongoose.Types.ObjectId(userIdStr);
      const key = dedupe_key || `${type}:${userIdStr}`;

      const existing = await Notification.findOne({
        user_id: userId,
        is_read: false,
        dedupe_key: key,
      }).lean();

      if (existing) {
        await Notification.updateOne(
          { _id: existing._id },
          {
            message: message || existing.message,
            title: title || existing.title,
            action_url: action_url || existing.action_url,
            expires_at: new Date(Date.now() + 90 * 86400000),
          },
        );
        created.push({ ...existing, message, title, action_url });
      } else {
        const notification = await Notification.create({
          user_id: userId,
          type,
          severity: severity || 'info',
          title: title || 'Notification',
          message: message || 'You have a new notification',
          action_url,
          dedupe_key: key,
          expires_at: new Date(Date.now() + 90 * 86400000),
          is_read: false,
        });
        created.push(notification);
      }
    } catch (err: any) {
      logger.error(
        `[NOTIFICATION] failed to create notification for user ${userIdStr}: ${err.message}`,
      );
    }
  }
  return created;
};

export const listNotifications = async (
  filter: Record<string, any>,
  options: Record<string, any>,
) => {
  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const sortBy = options.sortBy ?? 'created_at:desc';

  const skip = (page - 1) * limit;
  const sortOptions: Record<string, 1 | -1> = {};
  sortBy.split(',').forEach((s: string) => {
    const parts = s.split(':');
    const key = parts[0];
    const order = parts[1];
    if (key) {
      sortOptions[key] = order === 'desc' ? -1 : 1;
    }
  });

  const [total_results, rows] = await Promise.all([
    Notification.countDocuments(filter).exec(),
    Notification.find(filter).sort(sortOptions).skip(skip).limit(limit).lean(),
  ]);

  const results = rows.map(({ _id, __v, ...rest }) => ({
    id: String(_id),
    ...rest,
  }));

  return createResponse(httpStatus.OK, 'Notifications fetched successfully.', {
    results,
    page,
    limit,
    total_pages: Math.ceil(total_results / limit),
    total_results,
  });
};

export const unreadCount = async (filter: Record<string, any>) => {
  const count = await Notification.countDocuments({
    ...filter,
    is_read: false,
  }).exec();
  return createResponse(httpStatus.OK, 'Unread count fetched.', {
    count,
    capped: count >= 100,
  });
};

export const markRead = async (filter: Record<string, any>) => {
  const result = await Notification.updateOne(filter, {
    $set: { is_read: true, expires_at: new Date(Date.now() + 30 * 86400000) },
  }).exec();
  return createResponse(httpStatus.OK, 'Notification marked as read.', {
    modified: result.modifiedCount,
  });
};

export const readAll = async (filter: Record<string, any>) => {
  const result = await Notification.updateMany(filter, {
    $set: { is_read: true, expires_at: new Date(Date.now() + 30 * 86400000) },
  }).exec();
  return createResponse(httpStatus.OK, 'All notifications marked as read.', {
    modified: result.modifiedCount,
  });
};
