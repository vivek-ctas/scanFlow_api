import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import type { ISupportAttachment } from '../models/support-message.model.js';

export const SUPPORT_ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 3;

const rootDir = () => path.resolve(config.support.uploadDir);

const sanitizeName = (name: string) =>
  path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'file';

/**
 * Persist uploaded files to the configured driver and return attachment
 * subdocuments. Local disk only for now; `s3` is a future driver.
 */
export const saveAttachments = async (
  files: Express.Multer.File[] = [],
): Promise<ISupportAttachment[]> => {
  if (!files.length) return [];

  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
    );
  }

  if (config.support.storageDriver !== 'local') {
    throw new ApiError(
      httpStatus.NOT_IMPLEMENTED,
      `Support storage driver "${config.support.storageDriver}" is not available.`,
    );
  }

  const maxBytes = config.support.maxAttachmentMb * 1024 * 1024;
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(rootDir(), day);

  const attachments: ISupportAttachment[] = [];
  for (const file of files) {
    if (!SUPPORT_ALLOWED_MIME.has(file.mimetype)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Unsupported attachment type: ${file.mimetype}`,
      );
    }
    if (file.size > maxBytes) {
      throw new ApiError(
        413,
        `Attachment exceeds the ${config.support.maxAttachmentMb}MB limit.`,
      );
    }

    const safeName = sanitizeName(file.originalname);
    const key = `${day}/${crypto.randomUUID()}-${safeName}`;
    const absolute = path.join(rootDir(), key);

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(absolute, file.buffer);

    attachments.push({
      storage_key: key,
      file_name: file.originalname,
      content_type: file.mimetype,
      size_bytes: file.size,
    });
  }

  return attachments;
};

/**
 * Resolve a stored attachment to an absolute path on disk, guarding against
 * path traversal.
 */
export const resolveAttachmentPath = (storageKey: string): string => {
  const absolute = path.resolve(rootDir(), storageKey);
  const normalizedRoot = rootDir() + path.sep;
  if (!absolute.startsWith(normalizedRoot)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid attachment key.');
  }
  return absolute;
};

export const attachmentExists = async (storageKey: string) => {
  try {
    await fs.promises.access(resolveAttachmentPath(storageKey), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};
