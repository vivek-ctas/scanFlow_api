import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import passport from 'passport';
import httpStatus from 'http-status';
import config from './config/config.js';
import {
  successHandler,
  errorHandler as morganErrorHandler,
} from './config/morgan.js';
import { jwtStrategy } from './config/passport.js';
import { authLimiter } from './middlewares/rateLimiter.js';
import { mongoSanitize } from './middlewares/mongoSanitize.js';
import { auth } from './middlewares/auth.js';
import { apiRouter, PUBLIC_PATHS } from './routes/index.js';
import {
  errorConverter,
  errorHandler as errorHandlerMiddleware,
} from './middlewares/error.js';
import { ApiError } from './utils/ApiError.js';

const app = express();

if (config.behindReverseProxy) {
  app.set('trust proxy', 1);
}

if (config.env !== 'test') {
  app.use(successHandler);
  app.use(morganErrorHandler);
}

app.use(helmet());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(mongoSanitize());

app.use(compression());

app.use(cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Methods',
    'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  );
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

passport.use('jwt', jwtStrategy);

if (config.env === 'production') {
  app.use('/api/auth', authLimiter);
}

app.use('/api', (req, res, next) => {
  const isPublic = PUBLIC_PATHS.some(
    (path) => req.path === path || req.path.startsWith(`${path}/`),
  );
  if (isPublic) {
    return next();
  }
  return auth()(req, res, next);
});

app.use('/api', apiRouter);

app.get('/', (req, res) => {
  res.status(httpStatus.OK).json({
    status: httpStatus.OK,
    message: 'ScanFlow API',
  });
});

app.get('/health', (req, res) => {
  res.status(httpStatus.OK).json({
    status: httpStatus.OK,
    message: 'ScanFlow API is up and running.',
  });
});

app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'Not Found'));
});

app.use(errorConverter);
app.use(errorHandlerMiddleware);

export default app;
