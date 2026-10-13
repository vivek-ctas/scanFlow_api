const MAX_SUMMARY_LENGTH = 150;
const JWT_SHAPE =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PAIR =
  /((?:secret|token|otp|password|passwd|pin|api[_-]?key|authorization|auth)["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;
const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const OBJECT_ID = /\b[0-9a-fA-F]{24}\b/g;

// Absolute server paths that must never leave the server (POSIX roots, Windows
// drives, file:// URLs). Anything without a project anchor is dropped entirely.
const ABSOLUTE_PATH =
  /(?:\bfile:\/\/\/?|\b[A-Za-z]:\\|\/(?:home|Users|var|usr|opt|root|etc|srv|mnt|tmp|workspace|builds)\/)[^\s"',)]*/g;

// Project-relative anchors we deliberately keep so developers can find the file.
const RELATIVE_ANCHOR =
  /(?:^|\/)((?:src|tests?|dist|lib|config|scripts|packages|server)\/.+)$/;

const FRAME = /at\s+(?:\S+\s+\()?([^()\s]+?):(\d+)(?::\d+)?\)?/;

const safeStringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  const seen = new WeakSet();

  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack,
        };
      }

      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }

      return currentValue;
    });
  } catch {
    return String(value);
  }
};

/** Reduce an absolute path to a project-relative one, or a safe placeholder. */
const toRelativePath = (input: string): string => {
  const normalized = input.replace(/\\/g, '/').trim();

  if (!normalized) {
    return '';
  }

  if (/^node:/i.test(normalized)) {
    return '[internal]';
  }

  const anchored = normalized.match(RELATIVE_ANCHOR);

  if (anchored?.[1]) {
    return anchored[1];
  }

  // No project anchor — never leak server directories, keep only the basename.
  return normalized.split('/').pop() || '[path]';
};

/** First stack frame that points at project code (skips node internals). */
const firstAppFrame = (stack: unknown): string | null => {
  if (typeof stack !== 'string') {
    return null;
  }

  for (const line of stack.split('\n')) {
    if (/node_modules|node:internal/i.test(line)) {
      continue;
    }

    const match = line.match(FRAME);

    if (!match?.[1]) {
      continue;
    }

    const relative = toRelativePath(match[1]);

    if (!relative || relative === '[internal]' || relative === '[path]') {
      continue;
    }

    return `${relative}:${match[2]}`;
  }

  return null;
};

/** Normalise any stored error payload into a message plus an optional stack. */
const coerceError = (value: unknown): { message: string; stack?: string } => {
  if (value instanceof Error) {
    return {
      message: value.message || value.name || String(value),
      stack: value.stack,
    };
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const message =
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.error === 'string' && obj.error) ||
      '';
    const stack = typeof obj.stack === 'string' ? obj.stack : undefined;

    if (message || stack) {
      const name = typeof obj.name === 'string' ? obj.name : '';
      const prefixed =
        name && name !== 'Error' && !message.startsWith(name)
          ? `${name}: ${message}`
          : message;

      return { message: prefixed || name, stack };
    }

    return { message: safeStringify(value) };
  }

  const raw = String(value ?? '').trim();

  if (!raw) {
    return { message: '' };
  }

  // error_data is usually a JSON string produced by the system-error handler.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return coerceError(JSON.parse(raw));
    } catch {
      // Not valid JSON — treat it as a plain message.
    }
  }

  return { message: raw };
};

/**
 * Scrub an error payload into a short, secret-free summary safe to return from
 * the dashboard. Absolute server paths are removed while project-relative paths
 * (e.g. `src/middlewares/auth.ts:42`) are preserved for debugging.
 */
export const scrubSensitiveText = (value: unknown): string => {
  const { message, stack } = coerceError(value);
  const frame = firstAppFrame(stack);
  const text = frame ? `${message} at ${frame}` : message;

  return text
    .replace(/"stack"\s*:\s*"(?:\\.|[^"\\])*"/gi, '')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT_SHAPE, '[redacted-token]')
    .replace(SECRET_PAIR, '[redacted]')
    .replace(UUID, ':id')
    .replace(OBJECT_ID, ':id')
    .replace(ABSOLUTE_PATH, '[path]')
    .replace(/\s+/g, ' ')
    .trim();
};

/** Scrubbed, whitespace-collapsed summary truncated to `max` characters. */
export const scrubErrorSummary = (
  value: unknown,
  max: number = MAX_SUMMARY_LENGTH,
): string => {
  const text = scrubSensitiveText(value);

  return text.length > max ? `${text.slice(0, max)}…` : text;
};
