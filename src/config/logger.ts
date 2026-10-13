import winston from 'winston';
import config from './config.js';

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    // Return a copy — never mutate the original Error (logging must have no
    // side effects; mutating `message` to the stack corrupts downstream use).
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
      message: info.stack,
    });
  }
  return info;
});

export const logger = winston.createLogger({
  level: config.env === 'development' ? 'debug' : 'info',
  format: winston.format.combine(
    enumerateErrorFormat(),
    config.env === 'development'
      ? winston.format.colorize()
      : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(({ level, message }) => `${level}: ${message}`),
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});
