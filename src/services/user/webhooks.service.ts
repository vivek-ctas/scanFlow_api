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
  const config = await WebhookConfig.findOne({ organization_id: orgScope });
  return createResponse(httpStatus.OK, 'Webhook config fetched successfully.', {
    config,
  });
};

export const upsertWebhookConfig = async (
  body: Record<string, any>,
  reqUser: any,
) => {
  const orgScope = resolveOrganizationScope(reqUser, body.organization_id, {
    required: true,
  })!;
  const existing = await WebhookConfig.findOne({ organization_id: orgScope });

  const payload: Record<string, any> = {
    endpoint_url: body.endpoint_url,
    enabled: body.enabled,
    timeout_ms: body.timeout_ms,
    batch_size: body.batch_size,
    retry_limit: body.retry_limit,
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
      organization_id: orgScope,
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
  const config = await WebhookConfig.findOne({ organization_id: orgScope });
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
  const orgScope = resolveOrganizationScope(reqUser, filter.organization_id, {
    required: true,
  })!;
  const query: Record<string, any> = { organization_id: orgScope };
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
      total_pages: deliveries.total_pages,
      total_results: deliveries.total_results,
    },
  );
};

export const createDeliveryAndEnqueue = async (scan: any) => {
  const delivery = await WebhookDelivery.create({
    event_id: crypto.randomUUID(),
    scan_id: scan._id,
    organization_id: scan.organization_id,
    status: 'pending',
  });
  await enqueueScanWebhook({
    event_id: delivery.event_id,
    scan_id: String(scan._id),
    organization_id: String(scan.organization_id),
  });
  return delivery;
};
