import { Router } from 'express';
import { auth } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';
import * as notificationValidation from '../validations/notification.validations.js';
import * as notificationController from '../controllers/notification.controller.js';

const router = Router();

// Badha routes authenticated hova joie
router.use(auth());

router.get(
  '/',
  validate(notificationValidation.listNotifications),
  notificationController.listNotifications,
);

router.get(
  '/unread-count',
  validate(notificationValidation.unreadCount),
  notificationController.unreadCount,
);

router.patch(
  '/:notificationId/read',
  validate(notificationValidation.markRead),
  notificationController.markRead,
);

router.patch(
  '/read-all',
  validate(notificationValidation.readAll),
  notificationController.readAll,
);

export const notificationRouter = router;
