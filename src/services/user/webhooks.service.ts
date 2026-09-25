import httpStatus from 'http-status';
import crypto from 'crypto';
import { WebhookConfig } from '../../models/webhook-config.model.js';
import { WebhookDelivery } from '../../models/webhook-delivery.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse } from '../common.service.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import { enqueueScanWebhook } from '../../queues/webhook.queue.js';

export const getWebhookConfig = async (
  organizationId: string,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, organizationId, {
    required: true,
  })!;
  const config = await WebhookConfig.findOne({ organizationId: orgScope });
  return createResponse(httpStatus.OK, 'Webhook config fetched successfully.', {
    config,
  });
};

export const upsertWebhookConfig = async (
  body: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, body.organizationId, {
    required: true,
  })!;
  const existing = await WebhookConfig.findOne({ organizationId: orgScope });

  const payload: Record<string, any> = {
    endpointUrl: body.endpointUrl,
    enabled: body.enabled,
    timeoutMs: body.timeoutMs,
    batchSize: body.batchSize,
    retryLimit: body.retryLimit,
  };
  if (body.secret !== undefined) {
    payload.secret = body.secret;
  }

  let config;
  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    config = existing;
  } else {
    config = await WebhookConfig.create({
      organizationId: orgScope,
      ...payload,
    });
  }

  return createResponse(httpStatus.OK, 'Webhook config saved successfully.', {
    config,
  });
};

export const deleteWebhookConfig = async (
  organizationId: string,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, organizationId, {
    required: true,
  })!;
  const config = await WebhookConfig.findOne({ organizationId: orgScope });
  if (!config) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Webhook config not found');
  }
  await config.deleteOne();
  return createResponse(httpStatus.OK, 'Webhook config deleted successfully.');
};

export const listWebhookDeliveries = async (
  filter: Record<string, any>,
  options: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, filter.organizationId, {
    required: true,
  })!;
  const query: Record<string, any> = { organizationId: orgScope };
  if (filter.status) {
    query.status = filter.status;
  }

  const deliveries = await (WebhookDelivery as any).paginate(query, options);
  return createResponse(
    httpStatus.OK,
    'Webhook deliveries fetched successfully.',
    {
      results: deliveries.results,
      page: deliveries.page,
      limit: deliveries.limit,
      totalPages: deliveries.totalPages,
      totalResults: deliveries.totalResults,
    },
  );
};

export const createDeliveryAndEnqueue = async (scan: any) => {
  const delivery = await WebhookDelivery.create({
    eventId: crypto.randomUUID(),
    scanId: scan._id,
    organizationId: scan.organizationId,
    status: 'pending',
  });
  await enqueueScanWebhook({
    eventId: delivery.eventId,
    scanId: String(scan._id),
    organizationId: String(scan.organizationId),
  });
  return delivery;
};
