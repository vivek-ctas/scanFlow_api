const MAX_SUMMARY_LENGTH = 200;

const JWT_SHAPE =
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PAIR =
  /((?:secret|token|otp|password|passwd|pin|api[_-]?key|authorization|auth)["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi;

const safeStringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Reduce an error payload to a short, secret-free summary safe to return from
 * the dashboard. Never returns full headers/bodies/tokens.
 */
export const scrubErrorSummary = (value: unknown): string => {
  let text = safeStringify(value ?? '')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(JWT_SHAPE, '[redacted-token]')
    .replace(SECRET_PAIR, '$1[redacted]');

  text = text.replace(/\s+/g, ' ').trim();

  return text.length > MAX_SUMMARY_LENGTH
    ? `${text.slice(0, MAX_SUMMARY_LENGTH)}…`
    : text;
};
