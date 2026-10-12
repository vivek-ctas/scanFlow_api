import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import * as validation from '../../validations/admin/dashboard.validations.js';
import * as controller from '../../controllers/admin/dashboard.controller.js';

const router = Router();

router.get(
  '/summary',
  auth('viewDashboard'),
  validate(validation.emptyQuery),
  controller.getSummary,
);

router.get(
  '/scan-trend',
  auth('viewDashboard'),
  validate(validation.rangeQuery),
  controller.getScanTrend,
);

router.get(
  '/plan-distribution',
  auth('viewDashboard'),
  validate(validation.emptyQuery),
  controller.getPlanDistribution,
);

router.get(
  '/growth',
  auth('viewDashboard'),
  validate(validation.growthQuery),
  controller.getGrowth,
);

router.get(
  '/recent-leads',
  auth('viewDashboard'),
  validate(validation.recentLeadsQuery),
  controller.getRecentLeads,
);

router.get(
  '/top-organizations',
  auth('viewDashboard'),
  validate(validation.topOrganizationsQuery),
  controller.getTopOrganizations,
);

router.get(
  '/attention',
  auth('viewDashboard'),
  validate(validation.emptyQuery),
  controller.getAttention,
);

router.get(
  '/webhooks',
  auth('viewDashboard'),
  validate(validation.emptyQuery),
  controller.getWebhooks,
);

router.get(
  '/system',
  auth('viewDashboard'),
  validate(validation.emptyQuery),
  controller.getSystem,
);

export const dashboardRouter = router;
