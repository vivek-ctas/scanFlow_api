import { Router } from 'express';
import { authRouter } from './auth.route.js';
import { userRouter } from './user.route.js';

export const PUBLIC_PATHS = ['/auth'];

const router = Router();

router.use('/auth', authRouter);
router.use('/users', userRouter);

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 200,
    message: 'ScanFlow API is up and running.',
  });
});

export const v1Router = router;
