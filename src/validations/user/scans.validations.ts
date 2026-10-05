import Joi from 'joi';
import { objectId } from '../custom.validation.js';

export const MAX_BATCH_SCANS = 50;
const scanBody = Joi.object().keys({
  client_scan_id: Joi.string().required(),
  barcode: Joi.string().required(),
  barcode_type: Joi.string().allow('', null).optional(),
  device_id: Joi.string().allow('', null).optional(),
  scanned_at: Joi.date().optional(),
  organization_id: Joi.string().custom(objectId).optional(),
});

export const createScan = {
  body: scanBody,
};

export const batchCreateScans = {
  body: Joi.object().keys({
    scans: Joi.array().items(scanBody).min(1).max(MAX_BATCH_SCANS).required(),
  }),
};

export const listScans = {
  query: Joi.object().keys({
    organization_id: Joi.string().custom(objectId).optional(),
    user_id: Joi.string().custom(objectId).optional(),
    barcode: Joi.string().optional(),
    sort_by: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getScan = {
  params: Joi.object().keys({
    scanId: Joi.string().custom(objectId).required(),
  }),
};
