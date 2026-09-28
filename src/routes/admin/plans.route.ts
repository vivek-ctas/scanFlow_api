import { Router } from 'express';
import { auth } from '../../middlewares/auth.js';
import * as plansController from '../../controllers/admin/plans.controller.js';

const router = Router();

router.get('/', auth('manageSubscriptions'), plansController.listPlans);

export const plansRouter = router;
