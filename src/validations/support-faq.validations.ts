import Joi from 'joi';
import { objectId } from './custom.validation.js';

const FAQ_CATEGORIES = [
  'scanner',
  'account_login',
  'subscription_quota',
  'webhook',
  'bug',
  'other',
];
const FAQ_AUDIENCES = ['all', 'organization_admin', 'operator'];

export const listFaqs = {
  query: Joi.object().keys({}),
};

export const manageFaqs = {
  query: Joi.object().keys({
    page: Joi.number().integer().min(1).optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    category: Joi.string()
      .valid(...FAQ_CATEGORIES)
      .optional(),
    search: Joi.string().trim().optional(),
  }),
};

export const createFaq = {
  body: Joi.object().keys({
    question: Joi.string().trim().min(1).max(200).required(),
    answer: Joi.string().trim().min(1).max(4000).required(),
    category: Joi.string()
      .valid(...FAQ_CATEGORIES)
      .required(),
    audience: Joi.string()
      .valid(...FAQ_AUDIENCES)
      .default('all'),
    keywords: Joi.array().items(Joi.string().trim().max(50)).max(10).optional(),
    status: Joi.number().integer().valid(0, 1, 2).optional(),
    sort_order: Joi.number().integer().min(0).optional(),
  }),
};

export const updateFaq = {
  params: Joi.object().keys({
    faqId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      question: Joi.string().trim().min(1).max(200).optional(),
      answer: Joi.string().trim().min(1).max(4000).optional(),
      category: Joi.string()
        .valid(...FAQ_CATEGORIES)
        .optional(),
      audience: Joi.string()
        .valid(...FAQ_AUDIENCES)
        .optional(),
      keywords: Joi.array()
        .items(Joi.string().trim().max(50))
        .max(10)
        .optional(),
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      sort_order: Joi.number().integer().min(0).optional(),
    })
    .min(1),
};

export const updateFaqStatus = {
  params: Joi.object().keys({
    faqId: Joi.string().custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      status: Joi.number().integer().valid(0, 1, 2).optional(),
      action_type: Joi.string().valid('activate', 'deactivate').optional(),
    })
    .min(1),
};

export const deleteFaq = {
  params: Joi.object().keys({
    faqId: Joi.string().custom(objectId).required(),
  }),
};
