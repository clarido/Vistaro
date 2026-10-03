#!/usr/bin/env node
/**
 * Smoke test for the Demoforge SaaS MVP — no browser, no CLI spawn.
 *
 * Boots saas/server.js on an ephemeral port with SAAS_DISABLE_RUNNER=1
 * (jobs are accepted and queued but the repo's CLI is never invoked, so this
 * runs without node_modules/Playwright/ffmpeg) and asserts the HTTP contract:
 *
 *   /health                     → 200 ok
 *   /v1/* without a Bearer key  → 401
 *   /v1/builds with a key       → 200 (empty list)
 *   /v1/billing/checkout, no STRIPE_SECRET_KEY → 501 "billing not configured"
 *   POST /v1/builds with a real zip (built here in-memory) → 202, queued
 *   bad zip → 400; embed serving incl. Range + traversal guard → checked
 *   GET / → the dashboard
 *
 * ALWAYS kills the server, removes its temp data dir, and exits — PASS or not.
 * Usage: node saas/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(ROOT, 'server.js');
const API_KEY = 'smoke-test-key-dfk_123';
const OVERALL_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// A tiny ZIP writer (test-side only) so the extractor is exercised for real.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const method = deflate ? 8 : 0;
    const payload = deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);    // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38); // regular file, 0644 (<<16 would overflow int32)
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const cdStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);  // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForBoot(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      reject(new Error(`server did not print its boot line within ${timeoutMs} ms`));
    }, timeoutMs);
    rl.on('line', (line) => {
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(line);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'demoforge-smoke-'));
  const env = {
    ...process.env,
    PORT: '0', // ephemeral
    HOST: '127.0.0.1',
    SAAS_API_KEYS: API_KEY,
    SAAS_DATA_DIR: dataDir,
    SAAS_DISABLE_RUNNER: '1', // no browser, no CLI: jobs stay queued
  };
  delete env.STRIPE_SECRET_KEY; // the 501 stub is asserted below

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOut = '';
  child.stdout.on('data', (d) => { serverOut += d; });
  child.stderr.on('data', (d) => { process.stderr.write(d); }); // pass boot logs through

  // Shared by the finally and the watchdog, so no exit path leaks the temp data dir
  // (an orphaned listener or a leaked dir is what hangs a CI runner).
  const cleanup = () => {
    watchdog.unref();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      const exited = Promise.race([
        new Promise((r) => child.on('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      exited.then((code) => { if (code === undefined) child.kill('SIGKILL'); });
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  const watchdog = setTimeout(() => {
    console.error('FAIL  smoke test exceeded 30 s — aborting');
    child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
    const port = await waitForBoot(child, 10000);
    const base = `http://127.0.0.1:${port}`;
    const authed = { authorization: `Bearer ${API_KEY}` };

    // 1. Health
    let res = await fetch(`${base}/health`);
    let body = await res.json();
    check('GET /health → 200 ok:true', res.status === 200 && body.ok === true && body.service === 'demoforge-saas');

    // 2. /v1/* unauthenticated → 401
    res = await fetch(`${base}/v1/builds`);
    check('GET /v1/builds without a key → 401', res.status === 401);
    res = await fetch(`${base}/v1/builds`, { headers: { authorization: 'Bearer wrong-key' } });
    check('GET /v1/builds with a wrong key → 401', res.status === 401);
    res = await fetch(`${base}/v1/billing/checkout`, { method: 'POST' });
    check('POST /v1/billing/checkout without a key → 401', res.status === 401);

    // 3. Authenticated list → 200
    res = await fetch(`${base}/v1/builds`, { headers: authed });
    body = await res.json();
    check('GET /v1/builds with the key → 200, empty jobs list',
      res.status === 200 && Array.isArray(body.jobs) && body.jobs.length === 0);

    // 4. Checkout stub (no STRIPE_SECRET_KEY) → 501 "billing not configured"
    res = await fetch(`${base}/v1/billing/checkout`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'builder' }),
    });
    body = await res.json();
    check('POST /v1/billing/checkout without STRIPE_SECRET_KEY → 501 "billing not configured"',
      res.status === 501 && body.error === 'billing not configured');

    // 5. Upload a real zip (built above) → 202, queued; runner disabled so no CLI
    const indexHtml = '<!doctype html><meta charset="utf-8"><title>smoke screen</title><button id="go">go</button>';
    const animConfig = JSON.stringify({
      meta: { title: 'Smoke screen', slug: 'smoke', tailMs: 500 },
      steps: [
        { id: 'intro', time: '0s', action: 'fadeIn', target: 'body' },
        { id: 'go', time: '0.5s', action: 'click', target: '#go' },
      ],
    });
    const zip = zipOf([
      { name: 'index.html', data: Buffer.from(indexHtml), deflate: false },
      { name: 'anim.config.json', data: Buffer.from(animConfig), deflate: true },
    ]);
    res = await fetch(`${base}/v1/builds`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/zip' },
      body: zip,
    });
    body = await res.json();
    const jobId = body.id;
    check('POST /v1/builds with a zip → 202 queued',
      res.status === 202 && body.status === 'queued' && typeof jobId === 'string' && jobId.startsWith('bld_'));

    // 6. Detail endpoint knows the job
    res = await fetch(`${base}/v1/builds/${jobId}`, { headers: authed });
    body = await res.json();
    check('GET /v1/builds/<id> → 200 status queued',
      res.status === 200 && body.status === 'queued' && body.id === jobId);
    res = await fetch(`${base}/v1/builds/bld_doesnotexist`, { headers: authed });
    check('GET /v1/builds/<unknown> → 404', res.status === 404);

    // 7. Embed serving: index page, extracted project file, Range support
    res = await fetch(`${base}/embed/${jobId}/`);
    const embedIndex = await res.text();
    check('GET /embed/<id>/ → 200 HTML index',
      res.status === 200 && embedIndex.includes(jobId));
    res = await fetch(`${base}/embed/${jobId}/project/index.html`);
    check('GET /embed/<id>/project/index.html → 200 extracted file',
      res.status === 200 && (await res.text()).includes('smoke screen'));
    res = await fetch(`${base}/embed/${jobId}/project/index.html`, {
      headers: { range: 'bytes=0-1' },
    });
    const rangeBody = Buffer.from(await res.arrayBuffer());
    check('Range request → 206 with first 2 bytes ("<!")',
      res.status === 206
      && rangeBody.length === 2
      && rangeBody.toString('latin1') === '<!'
      && (res.headers.get('content-range') || '').startsWith('bytes 0-1/'));
    res = await fetch(`${base}/embed/${jobId}/job.json`);
    check('GET /embed/<id>/job.json → 403 (internal bookkeeping is not an artifact)',
      res.status === 403);
    res = await fetch(`${base}/embed/${jobId}/..%2f..%2f..%2fetc%2fpasswd`);
    check('path traversal via %2f → 400', res.status === 400 || res.status === 404);

    // 8. Bad upload → 400
    res = await fetch(`${base}/v1/builds`, {
      method: 'POST',
      headers: { ...authed, 'content-type': 'application/zip' },
      body: Buffer.from('this is definitely not a zip file'),
    });
    body = await res.json();
    check('POST /v1/builds with a non-zip body → 400',
      res.status === 400 && typeof body.error === 'string');

    // 9. Dashboard
    res = await fetch(`${base}/`);
    const dash = await res.text();
    check('GET / → 200 Demoforge dashboard',
      res.status === 200 && dash.includes('Demoforge') && res.headers.get('content-type').includes('text/html'));

    // The server was told PORT=0; the boot line must carry the real port.
    check('server booted on an ephemeral port', port > 0 && port !== 8787);
  } finally {
    cleanup();
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('FAILED:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  console.log('PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL (unexpected error):', e);
  process.exit(1);
});
