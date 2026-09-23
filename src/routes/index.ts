import { Router } from 'express';
import { authRouter } from './auth.route.js';
import { subUsersRouter } from './user/sub-users.route.js';
import { usersRouter } from './admin/users.route.js';

export const PUBLIC_PATHS = ['/auth', '/health'];

const router = Router();

router.use('/auth', authRouter);
router.use('/users', subUsersRouter);
router.use('/users', usersRouter);

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 200,
    message: 'ScanFlow API is up and running.',
  });
});

export const apiRouter = router;
