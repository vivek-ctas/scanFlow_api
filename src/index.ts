import mongoose from 'mongoose';
import app from './app.js';
import config from './config/config.js';
import { logger } from './config/logger.js';
import { SystemError } from './models/index.js';
import { setSystemErrorModel } from './utils/system-error.handler.js';

setSystemErrorModel(SystemError);

let server: ReturnType<typeof app.listen> | null = null;

const startServer = async () => {
  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(config.mongoose.url, config.mongoose.options);
    logger.info('Connected to MongoDB');

    server = app.listen(config.port, () => {
      logger.info(`Listening on port ${config.port}`);
    });
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
};

startServer();

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

const unexpectedErrorHandler = (error: Error) => {
  logger.error('Unexpected error', error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  exitHandler();
});
