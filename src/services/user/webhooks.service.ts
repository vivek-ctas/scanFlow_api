import httpStatus from 'http-status';
import crypto from 'crypto';
import { WebhookConfig } from '../../models/webhook-config.model.js';
import { WebhookDelivery } from '../../models/webhook-delivery.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { createResponse } from '../common.service.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';
import { enqueueScanWebhook } from '../../queues/webhook.queue.js';
import { systemLog } from '../../utils/system-log.js';

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
    const previous = existing.toObject();
    Object.assign(existing, payload);
    await existing.save();
    config = existing;
    await systemLog({
      operation: 'UPDATE',
      key: 'update-webhook-config',
      data: config.toObject(),
      existingData: previous,
      actorId: reqUser._id,
      organizationId: orgScope,
    });
  } else {
    config = await WebhookConfig.create({
      organization_id: orgScope,
      ...payload,
    });
    await systemLog({
      operation: 'CREATE',
      key: 'create-webhook-config',
      data: config.toObject(),
      actorId: reqUser._id,
      organizationId: orgScope,
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
  const removed = config.toObject();
  await config.deleteOne();
  await systemLog({
    operation: 'DELETE',
    key: 'delete-webhook-config',
    data: removed,
    actorId: reqUser._id,
    organizationId: orgScope,
  });
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

  const deliveries = await (WebhookDelivery as any).paginate(query, {
    sortBy: options.sort_by ?? 'created_at:desc',
    limit: options.limit,
    page: options.page,
  });
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
