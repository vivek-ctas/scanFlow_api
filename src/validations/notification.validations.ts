import Joi from 'joi';
import { objectId } from './custom.validation.js';

export const listNotifications = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(50).default(20),
    sortBy: Joi.string().trim().optional(),
  }),
};

export const unreadCount = {
  query: Joi.object().keys({}), // Future ma filter add karva hoy to aya mukso
};

export const markRead = {
  params: Joi.object().keys({
    notificationId: Joi.string().custom(objectId).required(),
  }),
};

export const readAll = {
  query: Joi.object().keys({}),
};
