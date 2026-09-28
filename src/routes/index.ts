import { Router } from 'express';
import { authRouter } from './auth.route.js';
import { organizationsRouter } from './admin/organizations.route.js';
import { operatorsRouter } from './user/operators.route.js';
import { scansRouter } from './user/scans.route.js';
import { webhooksRouter } from './user/webhooks.route.js';
import { publicCheckoutRouter } from './public-checkout.route.js';
import { plansRouter } from './admin/plans.route.js';

export const PUBLIC_PATHS = ['/auth', '/health', '/public-checkout'];

const router = Router();

router.use('/auth', authRouter);
router.use('/organizations', organizationsRouter);
router.use('/operators', operatorsRouter);
router.use('/scans', scansRouter);
router.use('/webhooks', webhooksRouter);
router.use('/public-checkout', publicCheckoutRouter);
router.use('/plans', plansRouter);

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 200,
    message: 'ScanFlow API is up and running.',
  });
});

export const apiRouter = router;
