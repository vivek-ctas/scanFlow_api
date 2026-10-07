import Joi from 'joi';
import { objectId } from '../custom.validation.js';

const contactIdParams = {
  params: Joi.object().keys({
    contactId: Joi.string().custom(objectId).required(),
  }),
};

export const submitContact = {
  body: Joi.object().keys({
    name: Joi.string().trim().min(1).max(100).required().messages({
      'string.empty': 'Name is required',
      'any.required': 'Name is required',
      'string.max': 'Name must be at most 100 characters',
    }),
    email: Joi.string().trim().email().lowercase().required().messages({
      'string.email': 'Please provide a valid email address',
      'any.required': 'Email is required',
    }),
    company: Joi.string().trim().max(200).optional().allow(''),
    phone: Joi.string().trim().max(50).optional().allow(''),
    inquiry_type: Joi.string()
      .trim()
      .valid('sales', 'demo', 'support', 'sdk', 'partnership', 'general')
      .default('general'),
    message: Joi.string().trim().min(10).max(2000).required().messages({
      'string.min': 'Message must be at least 10 characters',
      'string.max': 'Message must be at most 2000 characters',
      'any.required': 'Message is required',
    }),
  }),
};

export const listContacts = {
  query: Joi.object().keys({
    search: Joi.string().trim().optional(),
    status: Joi.number().valid(0, 1, 2).optional(),
    inquiry_type: Joi.string()
      .trim()
      .valid('sales', 'demo', 'support', 'sdk', 'partnership', 'general')
      .optional(),
    date_from: Joi.date().iso().optional(),
    date_to: Joi.date().iso().optional(),
    sort_by: Joi.string().trim().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getContact = {
  ...contactIdParams,
};

export const updateContactStatus = {
  ...contactIdParams,
  body: Joi.object().keys({
    status: Joi.number().valid(0, 1, 2).required().messages({
      'any.only': 'Status must be one of 0 (new), 1 (read), 2 (replied)',
      'any.required': 'Status is required',
    }),
  }),
};

export const replyToContact = {
  ...contactIdParams,
  body: Joi.object().keys({
    message: Joi.string().trim().min(1).max(5000).required().messages({
      'string.empty': 'Reply message is required',
      'any.required': 'Reply message is required',
    }),
  }),
};
