#!/usr/bin/env node
/**
 * ScanFlow webhook test receiver
 * ------------------------------
 * A tiny, dependency-free HTTP server that receives ScanFlow scan webhooks,
 * verifies the `x-scanflow-signature` (HMAC-SHA256 over the raw body), and
 * prints the decoded batch. Built for local testing — see
 * docs/webhooks-guide.md for the full walkthrough.
 *
 * Usage:
 *   node scripts/webhook-receiver.mjs
 *   npm run webhook:receiver
 *
 * Configuration (CLI flag takes precedence over env var):
 *   --port <n>      listen port            (env PORT,               default 4005)
 *   --path <p>      only accept this path  (env WEBHOOK_PATH,       default any path)
 *   --secret <s>    HMAC signing secret    (env WEBHOOK_SECRET,     default supersecret123)
 *   --status <n>    HTTP status to reply   (env WEBHOOK_RESPOND_STATUS, default 200)
 *   --fail <n>      fail the first N valid requests (env WEBHOOK_FAIL_FIRST, default 0)
 *   --log <file>    append received JSONL  (env WEBHOOK_LOG_FILE,   default none)
 *
 * Notes:
 *   - Signature is computed over the EXACT raw bytes of the body.
 *   - If --secret is set to an empty string, signature checks are skipped.
 *   - Run the ScanFlow worker (`npm run dev:worker`) or deliveries stay pending.
 *
 * Example:
 *   node scripts/webhook-receiver.mjs --port 4005 --secret supersecret123 --log /tmp/webhooks.jsonl
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULTS = {
  port: 4005,
  path: '',
  secret: 'supersecret123',
  status: 200,
  fail: 0,
  log: ''
};

const parseArgs = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const config = {
  port: toInt(args.port ?? process.env.PORT, DEFAULTS.port),
  path: String(args.path ?? process.env.WEBHOOK_PATH ?? DEFAULTS.path),
  secret: String(args.secret ?? process.env.WEBHOOK_SECRET ?? DEFAULTS.secret),
  status: toInt(args.status ?? process.env.WEBHOOK_RESPOND_STATUS, DEFAULTS.status),
  fail: toInt(args.fail ?? process.env.WEBHOOK_FAIL_FIRST, DEFAULTS.fail),
  log: String(args.log ?? process.env.WEBHOOK_LOG_FILE ?? DEFAULTS.log)
};

const stamp = () => new Date().toISOString();

const computeSignature = (raw) => crypto.createHmac('sha256', config.secret).update(raw).digest('hex');

const safeEqual = (a, b) => {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const verifySignature = (raw, header) => {
  if (config.secret === '') return { ok: true, skipped: true };
  if (!header || typeof header !== 'string') return { ok: false, reason: 'missing x-scanflow-signature header' };
  const expected = computeSignature(raw);
  if (safeEqual(expected, header)) return { ok: true, skipped: false };
  return { ok: false, reason: 'signature mismatch', expected, received: header };
};

let requestCount = 0;
let successCount = 0;
let failureCount = 0;

const logLine = (line) => {
  if (!config.log) return;
  try {
    fs.appendFileSync(config.log, `${line}\n`);
  } catch (err) {
    console.error(`[receiver] failed to write log file: ${err.message}`);
  }
};

const printEvents = (payload) => {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  console.log(`[receiver] batch contains ${events.length} event(s)`);
  events.forEach((event, index) => {
    console.log(`  #${index + 1} event_id=${event.event_id}`);
    console.log(`      scan_id=${event.scan_id} organization_id=${event.organization_id}`);
    console.log(`      barcode=${event.barcode} (${event.barcode_type ?? 'unknown'}) device_id=${event.device_id ?? '-'}`);
    console.log(`      scanned_at=${event.scanned_at ?? '-'}`);
  });
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(
      `ScanFlow webhook receiver is running.\n` +
        `  path filter : ${config.path || '(any path)'}\n` +
        `  status reply: ${config.status}\n` +
        `  secret set  : ${config.secret ? 'yes' : 'no (signatures skipped)'}\n` +
        `  requests    : ${requestCount} received, ${successCount} accepted, ${failureCount} failed\n`
    );
    return;
  }

  if (config.path && url.pathname !== config.path) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    requestCount += 1;
    const raw = Buffer.concat(chunks);
    const signature = req.headers['x-scanflow-signature'];
    const check = verifySignature(raw, signature);

    console.log('');
    console.log(`[receiver] ${stamp()} POST ${url.pathname} (${raw.length} bytes) #${requestCount}`);

    let payload = null;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      payload = null;
    }

    if (!payload) {
      failureCount += 1;
      console.log('[receiver] body is not valid JSON — responding 400');
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('invalid json');
      return;
    }

    if (!check.ok) {
      failureCount += 1;
      console.log(`[receiver] SIGNATURE INVALID (${check.reason}) — responding 401`);
      if (check.expected) console.log(`      expected: ${check.expected}\n      received: ${check.received}`);
      logLine(JSON.stringify({ ts: stamp(), path: url.pathname, valid: false, reason: check.reason, payload }));
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('bad signature');
      return;
    }

    console.log(`[receiver] signature valid${check.skipped ? ' (verification skipped)' : ''}`);
    printEvents(payload);

    const forcedFail = successCount < config.fail;
    const status = forcedFail ? 500 : config.status;

    if (forcedFail) {
      failureCount += 1;
      console.log(`[receiver] forced failure ${successCount + 1}/${config.fail} — responding ${status} (to exercise retries)`);
    } else {
      successCount += 1;
      console.log(`[receiver] acknowledged — responding ${status}`);
    }

    logLine(
      JSON.stringify({
        ts: stamp(),
        path: url.pathname,
        valid: true,
        status,
        forcedFail,
        eventCount: Array.isArray(payload.events) ? payload.events.length : 0,
        payload
      })
    );

    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(forcedFail ? 'forced failure' : 'ok');
  });
});

server.listen(config.port, () => {
  console.log('ScanFlow webhook receiver');
  console.log(`  listening   : http://localhost:${config.port}`);
  console.log(`  path filter : ${config.path || '(any path)'}`);
  console.log(`  status reply: ${config.status}`);
  console.log(`  secret      : ${config.secret ? config.secret : '(none — signatures skipped)'}`);
  console.log(`  fail first  : ${config.fail}`);
  console.log(`  log file    : ${config.log || '(console only)'}`);
  console.log('');
  console.log('Point a webhook config endpoint_url at this address, e.g.:');
  console.log(`  http://localhost:${config.port}${config.path || '/scanflow-webhook'}`);
  console.log('');
});

const shutdown = () => {
  console.log('\n[receiver] shutting down');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
