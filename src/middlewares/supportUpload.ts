import multer from 'multer';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import {
  SUPPORT_ALLOWED_MIME,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from '../services/support-storage.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.support.maxAttachmentMb * 1024 * 1024,
    files: MAX_ATTACHMENTS_PER_MESSAGE,
  },
  fileFilter: (_req, file, cb) => {
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
