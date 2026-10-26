import { Model } from 'mongoose';
import * as os from 'node:os';
import { getRequestContext } from '../middlewares/request-context.js';
import type { SystemLogOperation } from '../models/system-log.model.js';

const getServerIpAddress = (): string => {
  try {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      if (!iface) continue;
      for (const alias of iface) {
        if (
          alias.family === 'IPv4' &&
          alias.address !== '127.0.0.1' &&
          !alias.internal &&
          !alias.address.startsWith('169.254.')
        ) {
          return alias.address;
        }
      }
    }
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      if (!iface) continue;
      for (const alias of iface) {
        if (alias.family === 'IPv4' && !alias.internal) {
          return alias.address;
        }
      }
    }
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      if (!iface) continue;
      for (const alias of iface) {
        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1') {
          return alias.address;
        }
      }
    }
  } catch {
    // ignore
  }
  return '0.0.0.0';
};

let globalSystemLogModel: Model<any> | null = null;

const MAX_PAYLOAD_CHARS = 16_384;
const REDACTED = '[redacted]';
const SENSITIVE_KEYS = new Set([
  'password',
  'newpassword',
  'confirmpassword',
  'password_hash',
  'passhash',
  'pin',
  'pin_hash',
  'hash_pin',
  'otp',
  'hash_otp',
  'otp_hash',
  'token',
  'access_token',
  'refresh_token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'webhook_secret',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
]);

export interface SystemLogInput {
  operation: SystemLogOperation;
  key: string;
  data?: unknown;
  existingData?: unknown;
  actorId?: unknown;
  actorRole?: string | null;
  organizationId?: unknown;
  ip?: string | null;
}

export const setSystemLogModel = (model: Model<any>) => {
  globalSystemLogModel = model;
};

const toPlain = (value: unknown) => {
  if (value && typeof (value as any).toObject === 'function') {
    return (value as any).toObject();
  }
  return value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const redact = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (depth > 8) return '[depth-limit]';
  if (typeof (value as any).toHexString === 'function') return value;

  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redact(item, seen, depth + 1);
  }
  return result;
};

const stableStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
};

const capPayload = (value: unknown): unknown => {
  const json = stableStringify(value);
  if (json.length <= MAX_PAYLOAD_CHARS) return value;
  return {
    _truncated: true,
    size: json.length,
    note: 'Payload exceeded the system log size limit.',
  };
};

const IGNORED_DIFF_KEYS = new Set(['__v', 'updated_at', 'updatedAt']);

const changedFields = (
  source: Record<string, unknown>,
  comparison: Record<string, unknown>,
) => {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (IGNORED_DIFF_KEYS.has(key)) continue;
    if (!(key in comparison)) continue;
    if (stableStringify(source[key]) !== stableStringify(comparison[key])) {
      changed[key] = source[key];
    }
  }
  return changed;
};

const buildOperationData = ({
  operation,
  data,
  existingData,
}: {
  operation: SystemLogOperation;
  data: unknown;
  existingData: unknown;
}) => {
  const next = toPlain(data);
  const previous = toPlain(existingData);

  if (operation === 'UPDATE' && existingData !== undefined) {
    if (!isPlainObject(next) || !isPlainObject(previous)) {
      return next ?? previous ?? null;
    }
    const oldData = changedFields(previous, next);
    const updatedData = changedFields(next, previous);
    if (!Object.keys(oldData).length && !Object.keys(updatedData).length) {
      return next;
    }
    if (previous._id !== undefined && oldData._id === undefined) {
      oldData._id = previous._id;
    }
    return { oldData, updatedData };
  }

  return next ?? null;
};

const toObjectId = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  return /^[0-9a-fA-F]{24}$/.test(str) ? str : null;
};

const writeLog = async (input: SystemLogInput) => {
  if (!globalSystemLogModel) {
    return;
  }

  const context = getRequestContext();
  const actorId = toObjectId(input.actorId ?? context?.actor_id);
  const organizationId = toObjectId(
    input.organizationId ?? context?.organization_id,
  );
  const actorRole = input.actorRole ?? context?.actor_role ?? null;
  const ip = getServerIpAddress();

  const operationData = buildOperationData({
    operation: input.operation,
    data: input.data,
    existingData: input.existingData,
  });

  await globalSystemLogModel.create({
    operation: input.operation,
    operation_by: actorId,
    actor_role: actorRole,
    organization_id: organizationId,
    key: input.key,
    operation_data: [capPayload(redact(operationData))],
    ip_address: ip,
  });
};

/**
 * Best-effort audit writer. A logging failure must never break the request it
 * is describing, so errors are swallowed after being surfaced to the console.
 */
export const systemLog = async (input: SystemLogInput): Promise<void> => {
  try {
    await writeLog(input);
  } catch (error) {
    console.error(
      `[SystemLog] Failed to record ${input.operation} ${input.key}`,
      error,
    );
  }
};
