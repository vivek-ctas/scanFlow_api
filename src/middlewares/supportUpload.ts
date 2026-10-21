import path from 'path';
import multer from 'multer';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import {
  SUPPORT_ALLOWED_MIME,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../services/support-storage.service.js';

const TEXT_EXTENSION_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.support.maxAttachmentMb * 1024 * 1024,
    files: MAX_ATTACHMENTS_PER_MESSAGE,
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/octet-stream') {
      const normalized =
        TEXT_EXTENSION_MIME[path.extname(file.originalname).toLowerCase()];
      if (normalized) file.mimetype = normalized;
    }

    if (!SUPPORT_ALLOWED_MIME.has(file.mimetype)) {
      cb(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `Unsupported attachment type: ${file.mimetype}`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

/** Accepts up to `MAX_ATTACHMENTS_PER_MESSAGE` files under the `attachments` field. */
export const supportUpload = upload.array(
  'attachments',
  MAX_ATTACHMENTS_PER_MESSAGE,
);
