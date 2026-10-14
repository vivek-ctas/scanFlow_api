import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { orgDashboardLimiter } from '../../middlewares/rateLimiter.js';
import * as orgDashboardController from '../../controllers/user/org-dashboard.controller.js';
import * as orgDashboardValidation from '../../validations/user/org-dashboard.validations.js';

const router = Router();

router.use(auth());
router.use(orgDashboardLimiter);

router.get(
  '/summary',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardSummaryValidation),
  orgDashboardController.getOrgSummary,
);
router.get(
  '/quota',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardQuotaValidation),
  orgDashboardController.getOrgQuota,
);
router.get(
  '/scan-trend',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardScanTrendValidation),
  orgDashboardController.getOrgScanTrend,
);
router.get(
  '/team',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardTeamValidation),
  orgDashboardController.getOrgTeam,
);
router.get(
  '/webhooks',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardWebhooksValidation),
  orgDashboardController.getOrgWebhooks,
);
router.get(
  '/attention',
  auth('viewOrgDashboard'),
  validate(orgDashboardValidation.orgDashboardAttentionValidation),
  orgDashboardController.getOrgAttention,
);

export const orgDashboardRouter = router;
