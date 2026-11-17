import httpStatus from 'http-status';
export type ManagementErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CRON'
  | 'INVALID_TIMEZONE'
  | 'CONFIRMATION_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'JOB_NOT_FOUND'
  | 'JOB_ALREADY_RUNNING'
  | 'VERSION_CONFLICT'
  | 'JOB_NOT_RUNNABLE'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'SCHEDULER_UNAVAILABLE'
  | 'SCHEDULER_APPLY_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export class ManagementError extends Error {
  public readonly statusCode: number;
  public readonly code: ManagementErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ManagementErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ManagementError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

export const validationError = (message = 'Invalid request') =>
  new ManagementError(httpStatus.BAD_REQUEST, 'VALIDATION_ERROR', message);

export const jobNotFound = () =>
  new ManagementError(httpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Unknown job id');

export const capabilityNotSupported = () =>
  new ManagementError(
    httpStatus.NOT_IMPLEMENTED,
    'CAPABILITY_NOT_SUPPORTED',
    'Operation is not supported by this product',
  );
