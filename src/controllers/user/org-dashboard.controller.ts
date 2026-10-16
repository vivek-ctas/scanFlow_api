import httpStatus from 'http-status';
import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync.js';
import { createResponse } from '../../services/common.service.js';
import * as orgDashboardService from '../../services/user/org-dashboard.service.js';
import { getOrCompute } from '../../services/admin/dashboard.cache.js';
import type { WidgetCacheOptions } from '../../services/admin/dashboard.cache.js';
import { resolveOrganizationScope } from '../../middlewares/guards/orgScope.js';

const fresh = () => 60;
const chartFresh = () => 300;
const quotaFresh = () => 10;
const webhooksFresh = () => 30;

const getOrgId = (req: Request): string => {
  const orgId = resolveOrganizationScope(
    req.user as any,
    req.query.organization_id as string | undefined,
    {
      required: true,
    },
  );
  if (!orgId) {
    throw new Error('Organization ID could not be resolved');
  }
  return orgId.toString();
};

const respond = (
  res: Response,
  message: string,
  result: { data: any; computedAt: string },
) => {
  res.status(httpStatus.OK).json(
    createResponse(httpStatus.OK, message, {
      ...result.data,
      computed_at: result.computedAt,
    }),
  );
};

export const getOrgSummary = catchAsync(async (req: Request, res: Response) => {
  const organizationId = getOrgId(req);
  const options: WidgetCacheOptions = { freshSeconds: fresh() };
  const key = `org-dashboard:summary:${organizationId}`;
  const result = await getOrCompute(key, options, () =>
    orgDashboardService.getOrgSummary(organizationId),
  );
  respond(res, 'Organization dashboard summary fetched successfully.', result);
});

export const getOrgQuota = catchAsync(async (req: Request, res: Response) => {
  const organizationId = getOrgId(req);
  const options: WidgetCacheOptions = { freshSeconds: quotaFresh() };
  const key = `org-dashboard:quota:${organizationId}`;
  const result = await getOrCompute(key, options, () =>
    orgDashboardService.getOrgQuota(organizationId),
  );
  respond(res, 'Organization quota fetched successfully.', result);
});

export const getOrgScanTrend = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = getOrgId(req);
    const options: WidgetCacheOptions = {
      freshSeconds: chartFresh(),
      scanHeavy: true,
    };
    const range = req.query.range as string;
    const from = req.query.from
      ? new Date(req.query.from as string)
      : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const compare = Boolean(req.query.compare);
    const key = `org-dashboard:scan-trend:${organizationId}:${range}:${from?.toISOString() ?? 'none'}:${to?.toISOString() ?? 'none'}:${compare}`;
    const result = await getOrCompute(key, options, () =>
      orgDashboardService.getOrgScanTrend(organizationId, {
        range,
        from,
        to,
        compare,
      }),
    );
    respond(res, 'Organization scan trend fetched successfully.', result);
  },
);

export const getOrgTeam = catchAsync(async (req: Request, res: Response) => {
  const organizationId = getOrgId(req);
  const options: WidgetCacheOptions = { freshSeconds: 120, scanHeavy: true };
  const key = `org-dashboard:team:${organizationId}`;
  const result = await getOrCompute(key, options, () =>
    orgDashboardService.getOrgTeam(organizationId),
  );
  respond(res, 'Organization team activity fetched successfully.', result);
});

export const getOrgWebhooks = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = getOrgId(req);
    const options: WidgetCacheOptions = { freshSeconds: webhooksFresh() };
    const key = `org-dashboard:webhooks:${organizationId}`;
    const result = await getOrCompute(key, options, () =>
      orgDashboardService.getOrgWebhooks(organizationId),
    );
    respond(res, 'Organization webhooks fetched successfully.', result);
  },
);

export const getOrgAttention = catchAsync(
  async (req: Request, res: Response) => {
    const organizationId = getOrgId(req);
    const options: WidgetCacheOptions = { freshSeconds: webhooksFresh() };
    const key = `org-dashboard:attention:${organizationId}`;
    const result = await getOrCompute(key, options, () =>
      orgDashboardService.getOrgAttention(organizationId),
    );
    respond(res, 'Organization attention fetched successfully.', result);
  },
);
