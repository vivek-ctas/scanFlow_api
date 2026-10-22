#!/usr/bin/env node
/**
 * ScanFlow real-API load rig
 * --------------------------
 * Exercises the running API over HTTP (not supertest) so ingestion latency and
 * the quota boundary can be measured before/after deploying the support module.
 *
 * Usage:
 *   npm run load:throughput -- --token <jwt>
 *   npm run load:quota-boundary -- --token <jwt> --requests 120 --expected-accepted 100
 *
 * Auth (first match wins):
 *   --token <jwt>              or env LOAD_TOKEN
 *   --operator-id <id> --pin <6 digits>   or LOAD_OPERATOR_ID / LOAD_OPERATOR_PIN
 *
 * Common options:
 *   --base-url <url>           default http://localhost:3000/api
 *   --timeout <ms>             per-request timeout, default 15000
 *   --concurrency <n>          in-flight requests, default 20 (throughput) / 5 (quota)
 *
 * Throughput options:
 *   --requests <n>             operations to run, default 500
 *   --batch <1..50>            scans per request (POST /scans/batch), default 1
 *   --p95-budget-ms <n>        fail when scan p95 exceeds this (optional)
 *
 * Quota-boundary options:
 *   --requests <n>             scans to attempt, default 120
 *   --expected-accepted <n>    fail unless exactly this many are accepted (optional)
 *
 * Support isolation (optional, throughput mode):
 *   --support-token <jwt>      org-admin token used to create tickets in parallel
 *   --support-tickets <n>      tickets to create, default 10
 *   --support-category <c>     default bug
 *
 * Notes:
 *   - Quota exhaustion is HTTP 403 `FORBIDDEN_QUOTA_EXCEEDED` — not 429.
 *   - The rig never writes anything outside the API; use a disposable org/plan.
 */
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULTS = {
  baseUrl: 'http://localhost:3000/api',
  timeout: 15000,
  requests: 500,
  concurrency: 20,
  batch: 1,
  supportTickets: 10,
  supportCategory: 'bug',
  quotaRequests: 120,
  quotaConcurrency: 5
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const eqIdx = keyValue.indexOf('=');
    if (eqIdx >= 0) {
      out[keyValue.slice(0, eqIdx)] = keyValue.slice(eqIdx + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[keyValue] = true;
    } else {
      out[keyValue] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const mode = String(args.mode ?? 'throughput');
const baseUrl = String(args['base-url'] ?? process.env.LOAD_BASE_URL ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
const timeout = toInt(args.timeout ?? process.env.LOAD_TIMEOUT, DEFAULTS.timeout);

const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const log = (message) => console.log(message);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : 0,
    mean: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : 0
  };
}

async function requestJson(path, { method = 'GET', token, body, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const startedAt = performance.now();

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    return {
      status: response.status,
      ok: response.ok,
      payload,
      latencyMs: performance.now() - startedAt,
      raw,
      path
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      payload: { message: error.name === 'AbortError' ? 'timeout' : error.message },
      latencyMs: performance.now() - startedAt,
      raw,
      path
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveToken() {
  const direct = args.token ?? process.env.LOAD_TOKEN;
  if (direct) return String(direct);

  const operatorId = args['operator-id'] ?? process.env.LOAD_OPERATOR_ID;
  const pin = args.pin ?? process.env.LOAD_OPERATOR_PIN;
  if (!operatorId || !pin) return null;

  const res = await requestJson('/auth/login-pin', {
    method: 'POST',
    body: { operator_id: String(operatorId), pin: String(pin) }
  });

  if (!res.ok) {
    throw new Error(`Operator login failed (${res.status}): ${res.payload?.message ?? 'unknown error'}`);
  }

  const token = res.payload?.data?.tokens?.access_token;
  if (!token) throw new Error('Operator login succeeded but no access_token was returned.');
  return token;
}

function scanBody(index, batchSize) {
  if (batchSize > 1) {
    return {
      scans: Array.from({ length: batchSize }, (_, offset) => {
        const n = index * batchSize + offset;
        return {
          client_scan_id: `${runId}-${n}`,
          barcode: `LOAD-${runId}-${n}`,
          barcode_type: 'ZBAR_EAN13',
          device_id: 'load-rig'
        };
      })
    };
  }

  return {
    client_scan_id: `${runId}-${index}`,
    barcode: `LOAD-${runId}-${index}`,
    barcode_type: 'ZBAR_EAN13',
    device_id: 'load-rig'
  };
}

async function createSupportTicket(token, index) {
  return requestJson('/support/tickets', {
    method: 'POST',
    token,
    body: {
      subject: `Load rig ticket ${runId}-${index}`,
      category: String(args['support-category'] ?? DEFAULTS.supportCategory),
      priority: 'normal',
      description: `Created by the load rig (${runId}) while scans were in flight.`
    }
  });
}

/**
 * Runs `total` jobs with at most `concurrency` in flight. Returns the results in
 * completion order; the caller only aggregates, so order does not matter.
 */
async function runPool(total, concurrency, job) {
  const results = new Array(total);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= total) return;
      results[index] = await job(index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  return results;
}

function tally(results) {
  const byStatus = {};
  let errors = 0;
  for (const result of results) {
    const key = String(result.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
    if (!result.ok) errors += 1;
  }
  return { byStatus, errors };
}

async function runThroughput(token) {
  const requests = toInt(args.requests, DEFAULTS.requests);
  const concurrency = toInt(args.concurrency, DEFAULTS.concurrency);
  const batch = Math.min(50, Math.max(1, toInt(args.batch, DEFAULTS.batch)));
  const supportToken = args['support-token'] ?? process.env.LOAD_SUPPORT_TOKEN;
  const supportTickets = supportToken ? toInt(args['support-tickets'], DEFAULTS.supportTickets) : 0;

  const path = batch > 1 ? '/scans/batch' : '/scans';

  log(`mode=throughput base=${baseUrl} requests=${requests} concurrency=${concurrency} batch=${batch}`);
  if (supportTickets) log(`support tickets in parallel: ${supportTickets}`);

  const startedAt = performance.now();

  const supportJob = async (index) => createSupportTicket(String(supportToken), index);
  const scanJob = async (index) =>
    requestJson(path, { method: 'POST', token, body: scanBody(index, batch) });

  const [scanResults, supportResults] = await Promise.all([
    runPool(requests, concurrency, scanJob),
    supportTickets ? runPool(supportTickets, Math.min(3, supportTickets), supportJob) : Promise.resolve([])
  ]);

  const wallMs = performance.now() - startedAt;
  const scanLatencies = scanResults.map((result) => result.latencyMs);
  const scanStats = summarize(scanLatencies);
  const scans = tally(scanResults);
  const scansAccepted = (scans.byStatus['202'] ?? 0) + (scans.byStatus['200'] ?? 0);
  const totalScans = requests * batch;

  const report = {
    mode,
    run_id: runId,
    base_url: baseUrl,
    requests,
    concurrency,
    batch,
    wall_ms: Number(wallMs.toFixed(1)),
    requests_per_second: Number(((requests / wallMs) * 1000).toFixed(1)),
    scans_per_second: Number(((totalScans / wallMs) * 1000).toFixed(1)),
    accepted_requests: scansAccepted,
    total_scans: totalScans,
    statuses: scans.byStatus,
    errors: scans.errors,
    latency_ms: {
      min: Number(scanStats.min.toFixed(1)),
      mean: Number(scanStats.mean.toFixed(1)),
      p50: Number(scanStats.p50.toFixed(1)),
      p95: Number(scanStats.p95.toFixed(1)),
      p99: Number(scanStats.p99.toFixed(1)),
      max: Number(scanStats.max.toFixed(1))
    },
    support: supportTickets
      ? {
          requested: supportTickets,
          statuses: tally(supportResults).byStatus,
          errors: tally(supportResults).errors,
          latency_ms: (() => {
            const stats = summarize(supportResults.map((result) => result.latencyMs));
            return {
              p50: Number(stats.p50.toFixed(1)),
              p95: Number(stats.p95.toFixed(1)),
              p99: Number(stats.p99.toFixed(1))
            };
          })()
        }
      : null
  };

  log(JSON.stringify(report, null, 2));

  const failed = scanResults.filter((result) => !result.ok);
  if (failed.length) {
    const sample = failed.slice(0, 5).map((result) => `${result.status} ${result.payload?.message ?? ''}`);
    log(`\nFAIL: ${failed.length} scan request(s) failed.`);
    sample.forEach((line) => log(`  ${line}`));
    return 1;
  }

  const budget = toInt(args['p95-budget-ms'], 0);
  if (budget && report.latency_ms.p95 > budget) {
    log(`\nFAIL: scan p95 ${report.latency_ms.p95}ms exceeds budget ${budget}ms.`);
    return 1;
  }

  log('\nPASS');
  return 0;
}

async function runQuotaBoundary(token) {
  const requests = toInt(args.requests, DEFAULTS.quotaRequests);
  const concurrency = toInt(args.concurrency, DEFAULTS.quotaConcurrency);

  log(`mode=quota-boundary base=${baseUrl} requests=${requests} concurrency=${concurrency}`);

  const startedAt = performance.now();
  const results = await runPool(requests, concurrency, (index) =>
    requestJson('/scans', { method: 'POST', token, body: scanBody(index, 1) })
  );
  const wallMs = performance.now() - startedAt;

  const accepted = results.filter((result) => result.status === 202 || result.status === 200);
  const quotaExceeded = results.filter(
    (result) => result.status === 403 && result.payload?.message === 'FORBIDDEN_QUOTA_EXCEEDED'
  );
  const unexpected = results.filter(
    (result) =>
      !(result.status === 202 || result.status === 200) &&
      !(result.status === 403 && result.payload?.message === 'FORBIDDEN_QUOTA_EXCEEDED')
  );

  const acceptedStats = summarize(accepted.map((result) => result.latencyMs));
  const rejectedStats = summarize(quotaExceeded.map((result) => result.latencyMs));

  const report = {
    mode,
    run_id: runId,
    base_url: baseUrl,
    requests,
    concurrency,
    wall_ms: Number(wallMs.toFixed(1)),
    accepted: accepted.length,
    quota_exceeded: quotaExceeded.length,
    unexpected: unexpected.length,
    statuses: tally(results).byStatus,
    accepted_latency_ms: {
      p50: Number(acceptedStats.p50.toFixed(1)),
      p95: Number(acceptedStats.p95.toFixed(1)),
      p99: Number(acceptedStats.p99.toFixed(1)),
      max: Number(acceptedStats.max.toFixed(1))
    },
    rejected_latency_ms: {
      p50: Number(rejectedStats.p50.toFixed(1)),
      p95: Number(rejectedStats.p95.toFixed(1)),
      p99: Number(rejectedStats.p99.toFixed(1)),
      max: Number(rejectedStats.max.toFixed(1))
    }
  };

  log(JSON.stringify(report, null, 2));

  if (unexpected.length) {
    log(`\nFAIL: ${unexpected.length} unexpected response(s); expected only 2xx or 403 FORBIDDEN_QUOTA_EXCEEDED.`);
    unexpected.slice(0, 5).forEach((result) => {
      log(`  ${result.status} ${result.payload?.message ?? ''}`);
    });
    return 1;
  }

  const expected = toInt(args['expected-accepted'], -1);
  if (expected >= 0 && accepted.length !== expected) {
    log(`\nFAIL: accepted ${accepted.length}, expected ${expected}.`);
    return 1;
  }

  if (quotaExceeded.length && accepted.length === 0) {
    log('\nFAIL: every request was rejected; the org had no quota headroom to measure the boundary.');
    return 1;
  }

  log('\nPASS');
  return 0;
}

async function main() {
  if (!['throughput', 'quota-boundary'].includes(mode)) {
    console.error(`Unknown --mode "${mode}". Use throughput or quota-boundary.`);
    return 2;
  }

  const token = await resolveToken();
  if (!token) {
    console.error(
      'No credentials. Pass --token <jwt>, or --operator-id <id> --pin <pin>, or set LOAD_TOKEN.'
    );
    return 2;
  }

  if (args['support-token'] || process.env.LOAD_SUPPORT_TOKEN) {
    if (mode !== 'throughput') {
      log('Note: --support-token is ignored outside throughput mode.');
    }
  }

  await delay(0);
  return mode === 'throughput' ? runThroughput(token) : runQuotaBoundary(token);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
