import Joi from 'joi';
import { objectId } from './custom.validation.js';

const CATEGORIES = [
  'scanner',
  'account_login',
  'subscription_quota',
  'webhook',
  'bug',
  'other',
];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];
const STATUSES = [
  'open',
  'in_progress',
  'waiting_for_customer',
  'resolved',
  'closed',
];
const VIEWS = [
  'active',
  'awaiting_customer',
  'resolved',
  'closed',
  'unassigned',
  'awaiting_staff',
];

const ticketIdParams = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
  }),
};

export const createTicket = {
  body: Joi.object().keys({
    subject: Joi.string().trim().min(3).max(120).required().messages({
      'string.empty': 'Subject is required',
      'any.required': 'Subject is required',
      'string.max': 'Subject must be at most 120 characters',
    }),
    category: Joi.string()
      .valid(...CATEGORIES)
      .required()
      .messages({
        'any.only': `Category must be one of: ${CATEGORIES.join(', ')}`,
        'any.required': 'Category is required',
      }),
    priority: Joi.string()
      .valid(...PRIORITIES)
      .default('normal'),
    description: Joi.string().trim().min(10).max(5000).required().messages({
      'string.min': 'Description must be at least 10 characters',
      'string.max': 'Description must be at most 5000 characters',
      'any.required': 'Description is required',
    }),
    organization_id: Joi.string().custom(objectId).optional(),
    related_faq_id: Joi.string().custom(objectId).optional(),
    client_info: Joi.alternatives()
      .try(
        Joi.object().keys({
          user_agent: Joi.string().trim().max(500).allow(''),
          device_id: Joi.string().trim().max(200).allow(''),
          app_path: Joi.string().trim().max(300).allow(''),
        }),
        Joi.string()
          .trim()
          .custom((value, helpers) => {
            try {
              return JSON.parse(value);
            } catch {
              return helpers.error('any.invalid');
            }
          }),
      )
      .optional(),
  }),
};

export const listTickets = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    view: Joi.string()
      .valid(...VIEWS)
      .optional(),
    category: Joi.string()
      .valid(...CATEGORIES)
      .optional(),
    priority: Joi.string()
      .valid(...PRIORITIES)
      .optional(),
    status: Joi.string()
      .valid(...STATUSES)
      .optional(),
    search: Joi.string().trim().optional(),
    sort_by: Joi.string().trim().optional(),
    organization_id: Joi.string().custom(objectId).optional(),
    assigned_to: Joi.string().custom(objectId).optional(),
  }),
};

export const getTicket = {
  ...ticketIdParams,
};

export const listMessages = {
  ...ticketIdParams,
  query: Joi.object().keys({
    before: Joi.string().isoDate().optional(),
    after: Joi.string().isoDate().optional(),
    limit: Joi.number().integer().min(1).max(50).optional(),
  }),
};

export const addMessage = {
  ...ticketIdParams,
  body: Joi.object().keys({
    message: Joi.string().trim().min(1).max(5000).required().messages({
      'string.empty': 'Message is required',
      'any.required': 'Message is required',
      'string.max': 'Message must be at most 5000 characters',
    }),
    client_message_id: Joi.string().trim().min(1).max(100).optional(),
  }),
};

export const closeTicket = {
  ...ticketIdParams,
};

export const addNote = {
  ...ticketIdParams,
  body: Joi.object().keys({
    message: Joi.string().trim().min(1).max(5000).required().messages({
      'string.empty': 'Note is required',
      'any.required': 'Note is required',
      'string.max': 'Note must be at most 5000 characters',
    }),
  }),
};

export const updateTicket = {
  ...ticketIdParams,
  body: Joi.object()
    .keys({
      status: Joi.string()
        .valid(...STATUSES)
        .optional(),
      priority: Joi.string()
        .valid(...PRIORITIES)
        .optional(),
      assigned_to: Joi.string().custom(objectId).allow(null).optional(),
    })
    .min(1)
    .messages({
      'object.min':
        'At least one of status, priority or assigned_to is required',
    }),
};

export const downloadAttachment = {
  params: Joi.object().keys({
    ticketId: Joi.string().custom(objectId).required(),
    messageId: Joi.string().custom(objectId).required(),
    index: Joi.string().pattern(/^\d+$/).required(),
  }),
};

export const getSummary = {
  query: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
  }),
};
