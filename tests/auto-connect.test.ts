import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import config from '../src/config/config.js';
import { logger } from '../src/config/logger.js';
import {
  autoConnectProduct,
  AUTO_CONNECT_DELAYS_MS,
} from '../src/cron/management/auto-connect.js';

const originalEnv = config.env;
const originalAutoConnect = config.cronzivo.autoConnect;

const response = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

const beforeEachSetup = () => {
  config.env = 'development';
  config.cronzivo.autoConnect = {
    enabled: true,
    apiUrl: 'http://localhost:6000/api/v1/',
    publicBaseUrl: 'http://localhost:6001',
    productName: 'ScanFlow',
  };
};

beforeEach(beforeEachSetup);

afterEach(() => {
  config.env = originalEnv;
  config.cronzivo.autoConnect = originalAutoConnect;
  vi.restoreAllMocks();
});

describe('ScanFlow auto-connect client', () => {
  it('posts the registered payload with the global key', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(response(200, { ok: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await autoConnectProduct({
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      AUTO_CONNECT_DELAYS_MS[0],
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:6000/api/v1/products/auto-connect');
    const requestInit = init as RequestInit;
    expect(requestInit.method).toBe('POST');
    expect((requestInit.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.cronzivo.apiKey}`,
    );
    expect(JSON.parse(String(requestInit.body))).toEqual({
      code: 'SCANFLOW',
      name: 'ScanFlow',
      environment: 'PRODUCTION',
      base_url: 'http://localhost:6001',
      management_api_prefix: '/internal/cron',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      config.cronzivo.apiKey,
    );
  });

  it('registers on ports that fetch blocks (e.g. 6000)', async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    const received: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    // 6665 is on the Fetch spec "bad port" list, just like CronZivo's 6000.
    await new Promise<void>((resolve) =>
      server.listen(6665, '127.0.0.1', resolve),
    );
    config.cronzivo.autoConnect.apiUrl = 'http://127.0.0.1:6665/api/v1';
    try {
      await autoConnectProduct({ sleep: vi.fn().mockResolvedValue(undefined) });
      expect(received).toEqual([
        { method: 'POST', url: '/api/v1/products/auto-connect' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('logs a mismatch with registered values and does not retry', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      response(409, {
        details: {
          registered: {
            base_url: 'http://registered.example.com',
            management_api_prefix: '/internal/cron',
          },
        },
      }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await autoConnectProduct({
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('http://registered.example.com');
    expect(logged).not.toContain(config.cronzivo.apiKey);
  });

  it('retries network failures three times and never throws', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      autoConnectProduct({
        fetch: fetchMock as unknown as typeof fetch,
        sleep,
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(AUTO_CONNECT_DELAYS_MS.length);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([
      ...AUTO_CONNECT_DELAYS_MS,
    ]);
  });

  it('makes no call when disabled', async () => {
    config.cronzivo.autoConnect.enabled = false;
    const fetchMock = vi.fn();
    const sleep = vi.fn();

    await autoConnectProduct({
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('makes no call in the test environment', async () => {
    config.env = 'test';
    const fetchMock = vi.fn();
    const sleep = vi.fn();

    await autoConnectProduct({
      fetch: fetchMock as unknown as typeof fetch,
      sleep,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails fast when opt-in lacks the required URL and name values', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        "import('./src/config/config.ts').then(() => console.log('LOADED')).catch((error) => { console.error(error.message); process.exit(3); })",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MONGODB_URL: 'mongodb://127.0.0.1:27017/db_scanflow',
          CRONZIVO_AUTO_CONNECT: 'true',
          CRONZIVO_API_URL: '',
          CRONZIVO_PUBLIC_BASE_URL: '',
          CRONZIVO_PRODUCT_NAME: '',
        },
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /required when CRONZIVO_AUTO_CONNECT=true/,
    );
  });
});
