import Joi from 'joi';
import { objectId } from '../custom.validation.js';

export const createScan = {
  body: Joi.object().keys({
    clientScanId: Joi.string().required(),
    barcode: Joi.string().required(),
    barcodeType: Joi.string().allow('', null).optional(),
    deviceId: Joi.string().allow('', null).optional(),
    scannedAt: Joi.date().optional(),
    organizationId: Joi.string().custom(objectId).optional(),
  }),
};

export const listScans = {
  query: Joi.object().keys({
    organizationId: Joi.string().custom(objectId).optional(),
    userId: Joi.string().custom(objectId).optional(),
    barcode: Joi.string().optional(),
    sortBy: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100).optional(),
    page: Joi.number().integer().min(1).optional(),
  }),
};

export const getScan = {
  params: Joi.object().keys({
    scanId: Joi.string().custom(objectId).required(),
  }),
};
