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
  'text/x-log',
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 3;

const rootDir = () => path.resolve(config.support.uploadDir);

const sanitizeName = (name: string) =>
  path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'file';

type DetectedKind =
  'png' | 'jpeg' | 'webp' | 'gif' | 'pdf' | 'text' | 'unknown';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Sniffs the buffer itself; the declared MIME type is never trusted alone. */
const detectKind = (buffer: Buffer): DetectedKind => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE))
    return 'png';
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return 'jpeg';
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-')
    return 'pdf';

  // Text has no signature: accept valid UTF-8 without NUL or most control
  // bytes. SVG/HTML are plain text too, but their MIME type is not allowed.
  if (buffer.length && !buffer.includes(0)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      // eslint-disable-next-line no-control-regex
      if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'text';
    } catch {
      return 'unknown';
    }
  }

  return 'unknown';
};

const KIND_TO_MIME: Record<
  Exclude<DetectedKind, 'text' | 'unknown'>,
  string
> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

const TEXT_MIME = new Set(['text/plain', 'text/csv', 'text/x-log']);

const assertContentMatches = (file: Express.Multer.File) => {
  if (!file.size) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Attachment is empty.');
  }

  const kind = detectKind(file.buffer);

  if (kind === 'unknown') {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Attachment content is not an allowed type: ${file.originalname}`,
    );
  }

  if (kind === 'text') {
    if (!TEXT_MIME.has(file.mimetype)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attachment content does not match its declared type: ${file.originalname}`,
      );
    }
    return;
  }

  if (KIND_TO_MIME[kind] !== file.mimetype) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Attachment content does not match its declared type: ${file.originalname}`,
    );
  }
};

type StorageTarget = {
  organizationId: string;
  ticketId: string;
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

/** Best-effort cleanup used when a DB write fails after files were stored. */
export const deleteStoredFiles = async (
  attachments: ISupportAttachment[] = [],
): Promise<void> => {
  await Promise.allSettled(
    attachments.map((attachment) =>
      fs.promises.unlink(resolveAttachmentPath(attachment.storage_key)),
    ),
  );
};

/**
 * Persist uploaded files to the configured driver and return attachment
 * subdocuments. Local disk only for now; `s3` is a future driver.
 *
 * Keys are generated server-side as `<organization_id>/<ticket_id>/<uuid>`;
 * the original name is kept only as sanitised display metadata.
 */
export const saveAttachments = async (
  files: Express.Multer.File[] = [],
  target?: StorageTarget,
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

  if (!target?.organizationId || !target?.ticketId) {
    throw new ApiError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'Attachment storage target is missing.',
    );
  }

  const maxBytes = config.support.maxAttachmentMb * 1024 * 1024;
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
    assertContentMatches(file);
  }

  const dir = path.join(
    rootDir(),
    sanitizeName(target.organizationId),
    sanitizeName(target.ticketId),
  );

  await fs.promises.mkdir(dir, { recursive: true });

  const attachments: ISupportAttachment[] = [];
  try {
    for (const file of files) {
      const key = [
        sanitizeName(target.organizationId),
        sanitizeName(target.ticketId),
        crypto.randomUUID(),
      ].join('/');
      const absolute = path.join(rootDir(), key);

      await fs.promises.writeFile(absolute, file.buffer);

      attachments.push({
        storage_key: key,
        file_name: sanitizeName(file.originalname),
        content_type: file.mimetype,
        size_bytes: file.size,
      });
    }
  } catch (error) {
    await deleteStoredFiles(attachments);
    throw error;
  }

  return attachments;
};

export const attachmentExists = async (storageKey: string) => {
  try {
    await fs.promises.access(
      resolveAttachmentPath(storageKey),
      fs.constants.R_OK,
    );
    return true;
  } catch {
    return false;
  }
};
