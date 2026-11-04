import path from 'path';
import httpStatus from 'http-status';
import { ApiError } from '../utils/ApiError.js';

export type AttachmentKind =
  'image' | 'video' | 'document' | 'text' | 'archive';

export type DetectedContent =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'pdf'
  | 'mp4'
  | 'mov'
  | 'webm'
  | 'zip'
  | 'text'
  | 'pe'
  | 'elf'
  | 'macho'
  | 'ole2'
  | 'unknown';

export interface AttachmentTypeEntry {
  kind: AttachmentKind;
  extensions: string[];
  canonicalMime: string;
  maxBytes: number;
  previewable: boolean;
  detector: (buffer: Buffer) => boolean;
}

const MB = 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Extension → canonical MIME for every allowed format. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  har: 'application/json',
  zip: 'application/zip',
};

export const MIME_BY_EXTENSION_MAP: Readonly<Record<string, string>> =
  MIME_BY_EXTENSION;

/**
 * Blocked file extensions. A double extension is judged by its last segment,
 * so `report.pdf.exe` is blocked as an executable.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Executables / scripts
  'exe',
  'msi',
  'bat',
  'cmd',
  'com',
  'scr',
  'ps1',
  'vbs',
  'vbe',
  'js',
  'mjs',
  'cjs',
  'jar',
  'sh',
  'bash',
  'apk',
  'dll',
  'lnk',
  'app',
  'pif',
  'cpl',
  'hta',
  // Macro-enabled / legacy Office
  'xlsm',
  'docm',
  'pptm',
  'xlsb',
  'xls',
  'doc',
  'ppt',
  'dot',
  'dotm',
  'xlt',
  'xltm',
  'pot',
  'potm',
  // Other archives
  'rar',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'iso',
  'dmg',
  'cab',
  // Active web content
  'html',
  'htm',
  'svg',
  'xml',
  'xhtml',
  'swf',
  // Not supported in v1
  'avi',
  'mkv',
  'wmv',
  'flv',
  'heic',
  'heif',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'm4a',
  'aac',
]);

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm'];
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx'];
const TEXT_EXTENSIONS = ['txt', 'csv', 'log', 'json', 'har'];
const ARCHIVE_EXTENSIONS = ['zip'];

const isImageContent = (buffer: Buffer): boolean => {
  const kind = detectContent(buffer);
  return kind === 'png' || kind === 'jpeg' || kind === 'gif' || kind === 'webp';
};

const isVideoContent = (buffer: Buffer): boolean => {
  const kind = detectContent(buffer);
  return kind === 'mp4' || kind === 'mov' || kind === 'webm';
};

const isDocumentContent = (buffer: Buffer): boolean => {
  const kind = detectContent(buffer);
  return kind === 'pdf' || kind === 'zip';
};

const isTextContent = (buffer: Buffer): boolean =>
  detectContent(buffer) === 'text';

const isArchiveContent = (buffer: Buffer): boolean =>
  detectContent(buffer) === 'zip';

/**
 * Central registry of allowed attachment types.
 * Drives the upload filter, the validator, the serializer (which returns `kind`
 * to the panel) and the config endpoint, so client and server cannot disagree.
 */
export const ATTACHMENT_REGISTRY: Readonly<AttachmentTypeEntry[]> = [
  {
    kind: 'image',
    extensions: IMAGE_EXTENSIONS,
    canonicalMime: 'image/png',
    maxBytes: 10 * MB,
    previewable: true,
    detector: isImageContent,
  },
  {
    kind: 'video',
    extensions: VIDEO_EXTENSIONS,
    canonicalMime: 'video/mp4',
    maxBytes: 100 * MB,
    previewable: true,
    detector: isVideoContent,
  },
  {
    kind: 'document',
    extensions: DOCUMENT_EXTENSIONS,
    canonicalMime: 'application/pdf',
    maxBytes: 25 * MB,
    previewable: true,
    detector: isDocumentContent,
  },
  {
    kind: 'text',
    extensions: TEXT_EXTENSIONS,
    canonicalMime: 'text/plain',
    maxBytes: 10 * MB,
    previewable: false,
    detector: isTextContent,
  },
  {
    kind: 'archive',
    extensions: ARCHIVE_EXTENSIONS,
    canonicalMime: 'application/zip',
    maxBytes: 50 * MB,
    previewable: false,
    detector: isArchiveContent,
  },
];

/** Map from lowercased extension to the registry entry. */
export const EXTENSION_MAP: Readonly<Record<string, AttachmentTypeEntry>> =
  (() => {
    const map: Record<string, AttachmentTypeEntry> = {};
    for (const entry of ATTACHMENT_REGISTRY) {
      for (const ext of entry.extensions) {
        map[ext.toLowerCase()] = entry;
      }
    }
    return map;
  })();

export const getTypeByExtension = (
  ext: string,
): AttachmentTypeEntry | undefined =>
  EXTENSION_MAP[ext.replace(/^\./, '').toLowerCase()];

export const maxBytesForKind = (kind: AttachmentKind): number => {
  const entry = ATTACHMENT_REGISTRY.find((e) => e.kind === kind);
  return entry ? entry.maxBytes : 0;
};

export const isPreviewable = (kind: AttachmentKind): boolean => {
  const entry = ATTACHMENT_REGISTRY.find((e) => e.kind === kind);
  return entry ? entry.previewable : false;
};

/** MIME types allowed per kind (for the config endpoint and panel accept list). */
export const KIND_MIME_TYPES: Readonly<Record<AttachmentKind, string[]>> = {
  image: IMAGE_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext] as string),
  video: VIDEO_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext] as string),
  document: DOCUMENT_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext] as string),
  text: TEXT_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext] as string),
  archive: ARCHIVE_EXTENSIONS.map((ext) => MIME_BY_EXTENSION[ext] as string),
};

export interface AttachmentConfig {
  maxFiles: number;
  maxTotalMB: number;
  maxImageMB: number;
  maxDocumentMB: number;
  maxTextMB: number;
  maxArchiveMB: number;
  maxVideoMB: number;
  maxTicketStorageMB: number;
  maxOrgStorageMB: number;
  minFreeDiskMB: number;
  uploadMBPerHour: number;
  tokenTTLSeconds: number;
  allowedKinds: AttachmentKind[];
}

export const DEFAULT_CONFIG: AttachmentConfig = {
  maxFiles: 5,
  maxTotalMB: 100,
  maxImageMB: 10,
  maxDocumentMB: 25,
  maxTextMB: 10,
  maxArchiveMB: 50,
  maxVideoMB: 100,
  maxTicketStorageMB: 250,
  maxOrgStorageMB: 1024,
  minFreeDiskMB: 2048,
  uploadMBPerHour: 500,
  tokenTTLSeconds: 120,
  allowedKinds: ['image', 'document', 'text', 'video', 'archive'],
};

/** Config consumed by `GET /support/attachment-config`. */
export function getAttachmentConfig(config: AttachmentConfig = DEFAULT_CONFIG) {
  const kinds = ATTACHMENT_REGISTRY.filter((entry) =>
    config.allowedKinds.includes(entry.kind),
  ).map((entry) => ({
    kind: entry.kind,
    extensions: entry.extensions,
    maxBytes: entry.maxBytes,
    maxMB: Math.round(entry.maxBytes / MB),
    previewable: entry.previewable,
    mimeTypes: KIND_MIME_TYPES[entry.kind],
  }));

  return {
    max_files: config.maxFiles,
    max_total_mb: config.maxTotalMB,
    max_bytes: kinds.reduce((max, kind) => Math.max(max, kind.maxBytes), 0),
    kinds,
    hint:
      'Images, PDF, Excel/Word, CSV/TXT/LOG/JSON, ZIP and video (MP4, MOV, WebM). Up to ' +
      config.maxFiles +
      ' files, ' +
      config.maxTotalMB +
      ' MB total.',
  };
}

/* ------------------------------------------------------------------ */
/* Content detection                                                    */
/* ------------------------------------------------------------------ */

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  buffer.length >= offset + bytes.length &&
  bytes.every((byte, index) => buffer[offset + index] === byte);

const ascii = (buffer: Buffer, start: number, end: number): string =>
  buffer.subarray(start, end).toString('ascii');

export const detectContent = (buffer: Buffer): DetectedContent => {
  if (!buffer.length) return 'unknown';

  // Blocked executables / legacy containers, detected by content so a renamed
  // file cannot slip through.
  if (startsWith(buffer, [0x4d, 0x5a])) return 'pe'; // MZ
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
  if (
    startsWith(buffer, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(buffer, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(buffer, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(buffer, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(buffer, [0xca, 0xfe, 0xba, 0xbe])
  ) {
    return 'macho';
  }
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'ole2';
  }

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'png';
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (buffer.length >= 6) {
    const header = ascii(buffer, 0, 6);
    if (header === 'GIF87a' || header === 'GIF89a') return 'gif';
  }
  if (
    buffer.length >= 12 &&
    ascii(buffer, 0, 4) === 'RIFF' &&
    ascii(buffer, 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  if (buffer.length >= 5 && ascii(buffer, 0, 5) === '%PDF-') return 'pdf';

  // ISO BMFF (MP4 / QuickTime): `ftyp` at offset 4.
  if (buffer.length >= 12 && ascii(buffer, 4, 8) === 'ftyp') {
    const brand = ascii(buffer, 8, 12);
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  // Matroska / WebM (EBML).
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';

  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'zip';
  }

  // Text has no signature: accept valid UTF-8 without NUL or most control
  // bytes. HTML/SVG are plain text too, but their extension is blocked.
  if (!buffer.includes(0)) {
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

/* ------------------------------------------------------------------ */
/* ZIP / OOXML inspection                                               */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

interface ZipInspection {
  entries?: ZipEntry[];
  error?: string;
}

const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_UNCOMPRESSED_BYTES = 500 * MB;

/** Reads the ZIP central directory without extracting a single entry. */
const inspectZip = (buffer: Buffer): ZipInspection => {
  if (buffer.length < 22) return { error: 'The archive is empty or corrupt.' };

  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= searchStart; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { error: 'The archive is corrupt.' };

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  if (totalEntries === 0xffff || directoryOffset === 0xffffffff) {
    return { error: 'ZIP64 archives are not supported.' };
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    return {
      error: `The archive has more than ${MAX_ZIP_ENTRIES} entries.`,
    };
  }
  if (directoryOffset + directorySize > buffer.length) {
    return { error: 'The archive is corrupt.' };
  }

  const entries: ZipEntry[] = [];
  let pointer = directoryOffset;
  let declaredUncompressed = 0;

  for (let i = 0; i < totalEntries; i += 1) {
    if (pointer + 46 > buffer.length) {
      return { error: 'The archive is corrupt.' };
    }
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) {
      return { error: 'The archive is corrupt.' };
    }

    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);

    if (pointer + 46 + nameLength > buffer.length) {
      return { error: 'The archive is corrupt.' };
    }
    const name = buffer
      .subarray(pointer + 46, pointer + 46 + nameLength)
      .toString('utf8');

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      return { error: 'ZIP64 archives are not supported.' };
    }

    declaredUncompressed += uncompressedSize;
    entries.push({ name, flags, method, compressedSize, uncompressedSize });

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  if (declaredUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
    return { error: 'The archive expands beyond the 500 MB limit.' };
  }

  return { entries };
};

const hasBlockedZipEntry = (name: string): boolean => {
  const normalized = name.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    return true;
  }
  const ext = path.extname(normalized).replace(/^\./, '').toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
};

const isNestedArchiveName = (name: string): boolean => {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext);
};

/** Common checks for every ZIP-based file (macro-enabled Office or plain ZIP). */
export const validateZipSafety = (buffer: Buffer): string | null => {
  const inspection = inspectZip(buffer);
  if (inspection.error) return inspection.error;
  const entries = inspection.entries ?? [];

  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/');
    if (entry.flags & 0x1) {
      return 'Encrypted archives are not allowed.';
    }
    if (hasBlockedZipEntry(name)) {
      return `The archive contains a blocked file: ${path.basename(name)}.`;
    }
    if (isNestedArchiveName(name)) {
      return 'Nested archives are not allowed.';
    }
    if (/vbaproject\.bin$/i.test(name) || /\.bin$/i.test(name)) {
      return 'Macro-enabled Office files are not allowed.';
    }
    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize > 10 * MB &&
      entry.uncompressedSize / entry.compressedSize > 1000
    ) {
      return 'The archive has an implausible compression ratio.';
    }
  }

  return null;
};

const OOXML_REQUIRED_PART: Readonly<Record<string, string>> = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
};

export const validateOoxml = (
  buffer: Buffer,
  extension: string,
): string | null => {
  const safetyError = validateZipSafety(buffer);
  if (safetyError) return safetyError;

  const entries = inspectZip(buffer).entries ?? [];
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));

  if (!names.has('[content_types].xml')) {
    return `The file is not a valid .${extension} document.`;
  }

  const required = OOXML_REQUIRED_PART[extension];
  if (!required || !names.has(required)) {
    return `The file is not a valid .${extension} document.`;
  }

  return null;
};

export const validateArchive = (buffer: Buffer): string | null =>
  validateZipSafety(buffer);

/* ------------------------------------------------------------------ */
/* Filename handling and validation                                     */
/* ------------------------------------------------------------------ */

const RTL_OVERRIDE = /[\u202a-\u202e\u2066-\u2069]/g;

export const sanitizeFileName = (name: string): string => {
  const base = path
    .basename(String(name ?? ''))
    .replace(RTL_OVERRIDE, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'file';
};

export const extensionOf = (name: string): string =>
  path.extname(sanitizeFileName(name)).replace(/^\./, '').toLowerCase();

export interface AttachmentValidationInput {
  buffer: Buffer;
  originalname: string;
  size?: number;
  declaredMime?: string;
}

export interface AttachmentValidationResult {
  kind: AttachmentKind;
  extension: string;
  contentType: string;
  fileName: string;
  sizeBytes: number;
}

const reject = (message: string): never => {
  throw new ApiError(httpStatus.BAD_REQUEST, message);
};

/**
 * Validates an uploaded file using its detected content and its extension.
 * The declared MIME type is recorded for compatibility only and never trusted.
 */
export const validateAttachment = (
  input: AttachmentValidationInput,
  allowedKinds: readonly AttachmentKind[] = DEFAULT_CONFIG.allowedKinds,
): AttachmentValidationResult => {
  const buffer = input.buffer;
  const size = input.size ?? buffer.length;
  const fileName = sanitizeFileName(input.originalname);

  if (!size || !buffer.length) {
    return reject('Attachment is empty.');
  }

  const extension = extensionOf(fileName);
  if (!extension) {
    return reject(`Files must have an extension: ${fileName}`);
  }

  if (BLOCKED_EXTENSIONS.has(extension)) {
    return reject(
      `This file type is not allowed: .${extension}. Save it in a supported format and try again.`,
    );
  }

  const entry = EXTENSION_MAP[extension];
  if (!entry) {
    return reject(`Unsupported attachment type: .${extension}`);
  }
  if (!allowedKinds.includes(entry.kind)) {
    return reject(
      `Attachments of kind "${entry.kind}" are currently disabled.`,
    );
  }

  const detected = detectContent(buffer);

  if (
    detected === 'pe' ||
    detected === 'elf' ||
    detected === 'macho' ||
    detected === 'ole2'
  ) {
    return reject(
      `Attachment content is not allowed: ${fileName}. Save it in a supported format and try again.`,
    );
  }

  if (entry.kind === 'image') {
    const matches =
      (extension === 'png' && detected === 'png') ||
      ((extension === 'jpg' || extension === 'jpeg') && detected === 'jpeg') ||
      (extension === 'gif' && detected === 'gif') ||
      (extension === 'webp' && detected === 'webp');
    if (!matches) {
      return reject(
        `Attachment content does not match its extension: ${fileName}`,
      );
    }
  } else if (entry.kind === 'video') {
    const matches =
      (extension === 'webm' && detected === 'webm') ||
      (extension === 'mp4' && detected === 'mp4') ||
      (extension === 'mov' && (detected === 'mov' || detected === 'mp4'));
    if (!matches) {
      return reject(
        `Attachment content does not match its extension: ${fileName}`,
      );
    }
  } else if (entry.kind === 'document') {
    if (extension === 'pdf') {
      if (detected !== 'pdf') {
        return reject(
          `Attachment content does not match its extension: ${fileName}`,
        );
      }
    } else {
      if (detected !== 'zip') {
        return reject(
          `Attachment content does not match its extension: ${fileName}`,
        );
      }
      const ooxmlError = validateOoxml(buffer, extension);
      if (ooxmlError) return reject(ooxmlError);
    }
  } else if (entry.kind === 'text') {
    if (detected !== 'text') {
      return reject(
        `Attachment content does not match its extension: ${fileName}`,
      );
    }
  } else if (entry.kind === 'archive') {
    if (detected !== 'zip') {
      return reject(
        `Attachment content does not match its extension: ${fileName}`,
      );
    }
    const archiveError = validateArchive(buffer);
    if (archiveError) return reject(archiveError);
  }

  if (size > entry.maxBytes) {
    return reject(
      `Attachment is larger than ${Math.round(entry.maxBytes / MB)} MB for its kind.`,
    );
  }

  return {
    kind: entry.kind,
    extension,
    contentType: MIME_BY_EXTENSION[extension] ?? entry.canonicalMime,
    fileName,
    sizeBytes: size,
  };
};

/** Best-effort kind for attachments stored before the registry existed. */
export const kindForAttachment = (
  contentType?: string,
  fileName?: string,
): AttachmentKind | null => {
  const ext = fileName ? extensionOf(fileName) : '';
  if (ext && EXTENSION_MAP[ext]) return EXTENSION_MAP[ext].kind;

  const mime = String(contentType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  if (mime === 'application/zip') return 'archive';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return null;
};
