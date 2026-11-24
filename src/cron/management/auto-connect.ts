import http from 'node:http';
import https from 'node:https';
import config from '../../config/config.js';
import { logger } from '../../config/logger.js';

export const AUTO_CONNECT_DELAYS_MS = [2_000, 10_000, 30_000] as const;
const AUTO_CONNECT_TIMEOUT_MS = 5_000;

type FetchLike = typeof fetch;
type SleepLike = (ms: number) => Promise<void>;

/**
 * CronZivo listens on port 6000 by design. Node's fetch (undici) rejects that
 * port as a spec-defined "bad port", so the real transport uses http/https
 * directly. The shape matches fetch closely enough for the retry logic below.
 */
const nodeFetchLike: FetchLike = async (input, init) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const body = init?.body == null ? undefined : String(init.body);
  const headers: Record<string, string> = {
    ...((init?.headers ?? {}) as Record<string, string>),
  };
  if (body !== undefined) {
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }

  return new Promise<Response>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: init?.method ?? 'GET',
        headers,
        timeout: AUTO_CONNECT_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () =>
              JSON.parse(Buffer.concat(chunks).toString('utf8')),
          } as Response);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
};

export interface AutoConnectOptions {
  fetch?: FetchLike;
  sleep?: SleepLike;
}

const defaultSleep: SleepLike = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const registeredSuffix = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as {
      details?: { registered?: unknown };
    };
    const registered = body?.details?.registered;
    return registered ? ` registered=${JSON.stringify(registered)}` : '';
  } catch {
    return '';
  }
};

/**
 * Registers this ScanFlow instance with CronZivo after boot. Best-effort only:
 * it never throws, never blocks startup, and never logs the API key.
 */
export const autoConnectProduct = async (
  options: AutoConnectOptions = {},
): Promise<void> => {
  if (config.env === 'test' || !config.cronzivo.autoConnect.enabled) return;

  const code = config.cronzivo.productCode;
  const environment = config.cronzivo.environment;
  const fetchFn = options.fetch ?? nodeFetchLike;
  const sleepFn = options.sleep ?? defaultSleep;
  const url = `${config.cronzivo.autoConnect.apiUrl.replace(/\/+$/, '')}/products/auto-connect`;

  const payload = {
    code,
    name: config.cronzivo.autoConnect.productName,
    environment,
    base_url: config.cronzivo.autoConnect.publicBaseUrl,
    management_api_prefix: config.cronzivo.mgmtPrefix,
  };

  try {
    for (const [attempt, delay] of AUTO_CONNECT_DELAYS_MS.entries()) {
      await sleepFn(delay);
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.cronzivo.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(AUTO_CONNECT_TIMEOUT_MS),
        });
      } catch {
        continue;
      }

      if (response.ok) {
        logger.info(
          `[AUTO_CONNECT] result=CONNECTED code=${code} environment=${environment} attempt=${attempt + 1}`,
        );
        return;
      }

      if (response.status === 409) {
        const suffix = await registeredSuffix(response);
        logger.warn(
          `[AUTO_CONNECT] result=MISMATCH code=${code} environment=${environment}${suffix}`,
        );
        return;
      }
    }

    logger.error(
      `[AUTO_CONNECT] result=FAILED code=${code} environment=${environment} attempts=${AUTO_CONNECT_DELAYS_MS.length}`,
    );
  } catch (error) {
    logger.error(
      `[AUTO_CONNECT] result=FAILED code=${code} environment=${environment} reason=${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
};
