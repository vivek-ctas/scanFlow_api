import Joi from 'joi';

const companySub = Joi.object().keys({
  name: Joi.string().trim().min(1).max(120).required().messages({
    'string.empty': 'Company name is required',
    'any.required': 'Company name is required',
  }),
  website: Joi.string().trim().max(300).optional().allow(''),
  tagline: Joi.string().trim().max(400).optional().allow(''),
  about: Joi.string().trim().max(1200).optional().allow(''),
});

const contactSub = Joi.object().keys({
  email: Joi.string().trim().email().lowercase().max(200).required().messages({
    'string.email': 'Please provide a valid email address',
    'any.required': 'Contact email is required',
  }),
  phone: Joi.string().trim().min(3).max(60).required().messages({
    'string.empty': 'Contact phone is required',
    'any.required': 'Contact phone is required',
  }),
  address: Joi.string().trim().min(3).max(600).required().messages({
    'string.empty': 'Contact address is required',
    'any.required': 'Contact address is required',
  }),
  city: Joi.string().trim().max(120).optional().allow(''),
  state: Joi.string().trim().max(120).optional().allow(''),
  country: Joi.string().trim().max(120).optional().allow(''),
  postal_code: Joi.string().trim().min(2).max(30).required().messages({
    'string.empty': 'Postal code is required',
    'any.required': 'Postal code is required',
  }),
  working_hours: Joi.string().trim().max(300).optional().allow(''),
  timezone: Joi.string().trim().max(120).optional().allow(''),
});

const socialSub = Joi.object({
  facebook: Joi.string().trim().max(300).optional().allow(''),
  instagram: Joi.string().trim().max(300).optional().allow(''),
  linkedin: Joi.string().trim().max(300).optional().allow(''),
  youtube: Joi.string().trim().max(300).optional().allow(''),
  twitter: Joi.string().trim().max(300).optional().allow(''),
});

const footerSub = Joi.object({
  about: Joi.string().trim().max(1200).optional().allow(''),
  copyright_text: Joi.string().trim().max(300).optional().allow(''),
  show_social: Joi.boolean().optional(),
  show_contact: Joi.boolean().optional(),
  show_address: Joi.boolean().optional(),
  show_working_hours: Joi.boolean().optional(),
});

export const updateWebSettings = {
  body: Joi.object().keys({
    company: companySub.optional(),
    contact: contactSub.optional(),
    social: socialSub.optional(),
    footer: footerSub.optional(),
  }),
};
