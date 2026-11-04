import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import httpStatus from 'http-status';
import type { NextFunction, Request, Response } from 'express';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  SUPPORT_MAX_VIDEO_BYTES,
  ensureTempDir,
} from '../services/support-storage.service.js';
import {
  BLOCKED_EXTENSIONS,
  extensionOf,
  sanitizeFileName,
} from '../services/support-attachment-types.js';

const tempDirPath = (): string => {
  const configured = String((config as any).support?.uploadTmpDir || '').trim();
  return path.resolve(
    configured || path.join(os.tmpdir(), 'scanflow-support-tmp'),
  );
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      const dir = tempDirPath();
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (error: any) {
      cb(error, '');
    }
  },
  filename: (_req, file, cb) => {
    const extension = extensionOf(sanitizeFileName(file.originalname));
    cb(
      null,
      `${crypto.randomUUID()}${extension ? `.${extension}` : ''}.upload`,
    );
  },
});

const upload = multer({
  storage,
  limits: {
    // The real per-kind limit is enforced after content detection. This is the
    // hard ceiling so memory/disk use stays bounded.
    fileSize: SUPPORT_MAX_VIDEO_BYTES,
    files: MAX_ATTACHMENTS_PER_MESSAGE,
  },
  fileFilter: (_req, file, cb) => {
    const safeName = sanitizeFileName(file.originalname);
    const extension = extensionOf(safeName);

    if (!extension) {
      cb(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `Files must have an extension: ${safeName}`,
        ),
      );
      return;
    }
    if (BLOCKED_EXTENSIONS.has(extension)) {
      cb(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `This file type is not allowed: .${extension}. Save it in a supported format and try again.`,
        ),
      );
      return;
    }

    cb(null, true);
  },
});

const uploadArray = upload.array('attachments', MAX_ATTACHMENTS_PER_MESSAGE);

/**
 * Accepts up to `MAX_ATTACHMENTS_PER_MESSAGE` files under the `attachments`
 * field, streams them to the temp directory, and converts multer limits into
 * specific API errors.
 */
export const supportUpload = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  uploadArray(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        next(
          new ApiError(
            413,
            `Attachment is larger than the ${Math.round(
              SUPPORT_MAX_VIDEO_BYTES / (1024 * 1024),
            )} MB maximum.`,
          ),
        );
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        next(
          new ApiError(
            httpStatus.BAD_REQUEST,
            `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
          ),
        );
        return;
      }
      next(new ApiError(httpStatus.BAD_REQUEST, error.message));
      return;
    }
    next(error);
  });
};

// Ensure the temp directory exists before the first request (best effort).
void ensureTempDir().catch(() => undefined);
