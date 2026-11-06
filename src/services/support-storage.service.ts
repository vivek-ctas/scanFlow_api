import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import httpStatus from 'http-status';
import config from '../config/config.js';
import { ApiError } from '../utils/ApiError.js';
import { SupportMessage } from '../models/index.js';
import type { ISupportAttachment } from '../models/support-message.model.js';
import {
  ATTACHMENT_REGISTRY,
  DEFAULT_CONFIG,
  EXTENSION_MAP,
  MIME_BY_EXTENSION_MAP,
  extensionOf,
  isPreviewable,
  validateAttachment,
  type AttachmentKind,
  type AttachmentValidationResult,
} from './support-attachment-types.js';

const MB = 1024 * 1024;

const supportConfig = () =>
  (config as any).support ?? ({} as Record<string, any>);

export const SUPPORT_ALLOWED_MIME: ReadonlySet<string> = new Set(
  Object.values(MIME_BY_EXTENSION_MAP),
);

export const MAX_ATTACHMENTS_PER_MESSAGE: number =
  Number(supportConfig().maxFiles) || DEFAULT_CONFIG.maxFiles;

export const SUPPORT_MAX_TOTAL_BYTES: number =
  (Number(supportConfig().maxTotalMb) || DEFAULT_CONFIG.maxTotalMB) * MB;

export const SUPPORT_MAX_VIDEO_BYTES: number =
  (Number(supportConfig().maxVideoMb) || DEFAULT_CONFIG.maxVideoMB) * MB;

const rootDir = () =>
  path.resolve(supportConfig().uploadDir || '/tmp/support-uploads');

/** Resolve a stored attachment to an absolute path, guarding against traversal. */
export const resolveAttachmentPath = (storageKey: string): string => {
  const absolute = path.resolve(rootDir(), storageKey);
  const normalizedRoot = rootDir() + path.sep;
  if (!absolute.startsWith(normalizedRoot)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid attachment key.');
  }
  return absolute;
};

const tempDir = () => {
  const configured = String(supportConfig().uploadTmpDir || '').trim();
  return path.resolve(
    configured || path.join(os.tmpdir(), 'scanflow-support-tmp'),
  );
};

export const ensureTempDir = async (): Promise<string> => {
  const dir = tempDir();
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

/** Deletes multer temp files after a failed or completed upload. */
export const deleteTempFiles = async (
  files: Express.Multer.File[] = [],
): Promise<void> => {
  await Promise.allSettled(
    files
      .map((file) => (file as any).path)
      .filter(Boolean)
      .map((filePath: string) => fs.promises.unlink(filePath)),
  );
};

/** Best-effort cleanup used when a DB write fails after files were stored. */
export const deleteStoredFiles = async (
  attachments: ISupportAttachment[] = [],
): Promise<void> => {
  await Promise.allSettled(
    attachments
      .filter((attachment) => Boolean(attachment.storage_key))
      .map((attachment) =>
        fs.promises.unlink(resolveAttachmentPath(attachment.storage_key)),
      ),
  );
};

const readFileBuffer = async (file: Express.Multer.File): Promise<Buffer> => {
  if (file.buffer?.length) return file.buffer;
  const filePath = (file as any).path as string | undefined;
  if (!filePath) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Attachment could not be read: ${file.originalname}`,
    );
  }

  // ZIP/OOXML/text validation needs the whole file; magic-byte checks only
  // need the header. Reading in this targeted way keeps large videos cheap.
  const ext = extensionOf(file.originalname);
  const entry = EXTENSION_MAP[ext];
  const wholeFile =
    !entry ||
    entry.kind === 'text' ||
    entry.kind === 'archive' ||
    (entry.kind === 'document' && ext !== 'pdf');

  if (wholeFile) return fs.promises.readFile(filePath);

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, file.size ?? 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const assertFreeDisk = async (incomingBytes: number): Promise<void> => {
  const minFreeMb =
    Number(supportConfig().minFreeDiskMb) || DEFAULT_CONFIG.minFreeDiskMB;
  if (!minFreeMb) return;
  try {
    const stats = await fs.promises.statfs(rootDir());
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (available - incomingBytes < minFreeMb * MB) {
      throw new ApiError(
        httpStatus.INSUFFICIENT_STORAGE,
        'Support file storage is full. Please try again later or attach a smaller file.',
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // statfs is unavailable on some platforms; do not block uploads for that.
  }
};

const sumAttachmentBytes = async (
  filter: Record<string, unknown>,
): Promise<number> => {
  const rows = await SupportMessage.aggregate([
    { $match: filter },
    { $unwind: '$attachments' },
    { $group: { _id: null, total: { $sum: '$attachments.size_bytes' } } },
  ]);
  return Number(rows?.[0]?.total ?? 0);
};

const assertStorageCaps = async (
  target: { organizationId: string; ticketId: string },
  incomingBytes: number,
): Promise<void> => {
  const ticketCapMb =
    Number(supportConfig().ticketStorageMb) ||
    DEFAULT_CONFIG.maxTicketStorageMB;
  const orgCapMb =
    Number(supportConfig().orgStorageMb) || DEFAULT_CONFIG.maxOrgStorageMB;

  const [ticketBytes, orgBytes] = await Promise.all([
    sumAttachmentBytes({ ticket_id: target.ticketId }),
    sumAttachmentBytes({ organization_id: target.organizationId }),
  ]);

  if (ticketBytes + incomingBytes > ticketCapMb * MB) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `This ticket has reached its ${ticketCapMb} MB attachment limit.`,
    );
  }
  if (orgBytes + incomingBytes > orgCapMb * MB) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Your organization has reached its ${orgCapMb} MB attachment limit.`,
    );
  }
};

const moveFile = async (source: string, destination: string): Promise<void> => {
  try {
    await fs.promises.rename(source, destination);
  } catch (error: any) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(source, destination);
    await fs.promises.unlink(source);
  }
};

type StorageTarget = {
  organizationId: string;
  ticketId: string;
};

/**
 * Validate and persist uploaded files. Files are validated by detected content
 * and extension (never by the declared MIME type), then moved from the temp
 * directory to `<organization>/<ticket>/<uuid>.<detected-extension>`.
 */
export const saveAttachments = async (
  files: Express.Multer.File[] = [],
  target?: StorageTarget,
): Promise<ISupportAttachment[]> => {
  if (!files.length) return [];

  const allowedKinds = String(supportConfig().allowedKinds || '')
    .split(',')
    .map((kind) => kind.trim())
    .filter(Boolean) as AttachmentKind[];
  const enabledKinds = allowedKinds.length
    ? allowedKinds
    : DEFAULT_CONFIG.allowedKinds;

  try {
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `At most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
      );
    }

    if (
      supportConfig().storageDriver &&
      supportConfig().storageDriver !== 'local'
    ) {
      throw new ApiError(
        httpStatus.NOT_IMPLEMENTED,
        `Support storage driver "${supportConfig().storageDriver}" is not available.`,
      );
    }

    if (!target?.organizationId || !target?.ticketId) {
      throw new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'Attachment storage target is missing.',
      );
    }

    const totalBytes = files.reduce(
      (sum, file) => sum + Number(file.size ?? 0),
      0,
    );
    if (totalBytes > SUPPORT_MAX_TOTAL_BYTES) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Attachments exceed the ${Math.round(
          SUPPORT_MAX_TOTAL_BYTES / MB,
        )} MB total limit for one message.`,
      );
    }

    const validated: Array<{
      file: Express.Multer.File;
      result: AttachmentValidationResult;
    }> = [];

    for (const file of files) {
      const buffer = await readFileBuffer(file);
      const result = validateAttachment(
        {
          buffer,
          originalname: file.originalname,
          size: Number(file.size ?? buffer.length),
          declaredMime: file.mimetype,
        },
        enabledKinds,
      );
      validated.push({ file, result });
    }

    await assertFreeDisk(totalBytes);
    await assertStorageCaps(target, totalBytes);

    const dir = path.join(
      rootDir(),
      path.basename(target.organizationId),
      path.basename(target.ticketId),
    );
    await fs.promises.mkdir(dir, { recursive: true });

    const attachments: ISupportAttachment[] = [];
    for (const { file, result } of validated) {
      const key = [
        path.basename(target.organizationId),
        path.basename(target.ticketId),
        `${crypto.randomUUID()}.${result.extension}`,
      ].join('/');
      const absolute = path.join(rootDir(), key);

      if ((file as any).path) {
        await moveFile((file as any).path, absolute);
      } else {
        await fs.promises.writeFile(absolute, file.buffer);
      }

      attachments.push({
        storage_key: key,
        file_name: result.fileName,
        content_type: result.contentType,
        size_bytes: result.sizeBytes,
        kind: result.kind,
      });
    }

    return attachments;
  } catch (error) {
    await deleteTempFiles(files);
    throw error;
  }
};

export const attachmentExists = async (
  storageKey: string,
): Promise<boolean> => {
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

/** True when the attachment kind may be rendered inline by the browser. */
export const canPreviewAttachment = (
  kind: AttachmentKind | null | undefined,
  contentType?: string,
  fileName?: string,
): boolean => {
  if (kind) return isPreviewable(kind);
  const ext = fileName ? extensionOf(fileName) : '';
  const entry = EXTENSION_MAP[ext];
  if (entry) return entry.previewable;
  return Boolean(
    contentType?.startsWith('image/') || contentType?.startsWith('video/'),
  );
};

/* ------------------------------------------------------------------ */
/* Short-lived attachment access tokens                                */
/* ------------------------------------------------------------------ */

const tokenSecret = (): string =>
  String(
    supportConfig().mediaTokenSecret ||
      (config as any).jwt?.secret ||
      'scanflow-support-media-token',
  );

const tokenTtlSeconds = (): number =>
  Number(supportConfig().mediaTokenTtlSeconds) ||
  DEFAULT_CONFIG.tokenTTLSeconds;

const sign = (payload: string): string =>
  crypto.createHmac('sha256', tokenSecret()).update(payload).digest('hex');

interface TokenInput {
  userId: string;
  ticketId: string;
  messageId: string;
  index: number;
}

export const createAttachmentToken = (
  input: TokenInput,
): { token: string; expires_at: Date } => {
  const expires = Math.floor(Date.now() / 1000) + tokenTtlSeconds();
  const payload = [
    expires,
    input.userId,
    input.ticketId,
    input.messageId,
    input.index,
  ].join('.');
  return {
    token: `${expires}.${input.userId}.${sign(payload)}`,
    expires_at: new Date(expires * 1000),
  };
};

export const verifyAttachmentToken = (
  token: string,
  input: Omit<TokenInput, 'userId'>,
): boolean => {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return false;
  const [expiresRaw, userId, signature] = parts;
  const expires = Number(expiresRaw);
  if (!expires || !userId || !signature) return false;
  if (expires < Math.floor(Date.now() / 1000)) return false;

  const expected = sign(
    [expires, userId, input.ticketId, input.messageId, input.index].join('.'),
  );
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Kinds exposed to the serializer so the panel can render the right card. */
export const ATTACHMENT_KINDS = ATTACHMENT_REGISTRY.map((entry) => entry.kind);
