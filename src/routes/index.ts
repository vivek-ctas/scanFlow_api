import { Router } from 'express';
import { authRouter } from './auth.route.js';
import { organizationsRouter } from './admin/organizations.route.js';
import { operatorsRouter } from './user/operators.route.js';
import { scansRouter } from './user/scans.route.js';
import { webhooksRouter } from './user/webhooks.route.js';
import { publicCheckoutRouter } from './public-checkout.route.js';
import { plansRouter } from './admin/plans.route.js';
import { guestLeadsRouter } from './admin/guest-leads.route.js';
import { contactRouter } from './admin/contact.route.js';
import { webSettingsRouter } from './admin/web-settings.route.js';
import { emailRouter } from './admin/email.route.js';
import { countriesRouter } from './countries.route.js';

export const PUBLIC_PATHS = [
  '/auth',
  '/health',
  '/public-checkout',
  '/countries',
  '/plans/public',
  '/contact/public',
  '/web-settings',
];

const router = Router();

router.use('/auth', authRouter);
router.use('/organizations', organizationsRouter);
router.use('/operators', operatorsRouter);
router.use('/scans', scansRouter);
router.use('/webhooks', webhooksRouter);
router.use('/public-checkout', publicCheckoutRouter);
router.use('/plans', plansRouter);
router.use('/guest-leads', guestLeadsRouter);
router.use('/contact', contactRouter);
router.use('/web-settings', webSettingsRouter);
router.use('/email', emailRouter);
router.use('/countries', countriesRouter);

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 200,
    message: 'ScanFlow API is up and running.',
  });
});

export const apiRouter = router;
