#!/usr/bin/env node
/**
 * Smoke test for Vistaro Cloud — no browser, no CLI spawn.
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
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { writeZip } = createRequire(import.meta.url)('./lib/zipwrite.js');
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


// ---------------------------------------------------------------------------
// Vistaro Cloud checks. Content-origin requests set the Host header to
// localhost:<port> while connecting to 127.0.0.1, so no IPv6 resolution of
// "localhost" can make the smoke flaky.
// ---------------------------------------------------------------------------

function raw(port, method, urlPath, { host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    if (body) req.write(body);
    req.end();
  });
}

function jsonOf(r) {
  try { return JSON.parse(r.text); } catch { return {}; }
}

async function cloudChecks(base, port) {
  const content = `localhost:${port}`;
  const J = { 'content-type': 'application/json' };
  const CSRF = { 'x-vistaro-csrf': '1' };

  let r = await raw(port, 'POST', '/api/signup', { headers: J, body: JSON.stringify({ email: 'owner@smoke.test', password: 'smoke-password-1', workspaceName: 'Smoke Co' }) });
  const cookie = String(r.headers['set-cookie'] || '').split(';')[0];
  const ws = jsonOf(r).workspace || {};
  check('cloud: signup → 201, HttpOnly session cookie, free workspace',
    r.status === 201 && cookie.startsWith('vs=') && /HttpOnly/.test(String(r.headers['set-cookie'])) && ws.slug === 'smoke-co' && ws.plan && ws.plan.id === 'free');
  const C = { cookie };

  r = await raw(port, 'GET', '/api/me', { headers: C });
  check('cloud: /api/me with the cookie → 200', r.status === 200 && jsonOf(r).user.email === 'owner@smoke.test');
  r = await raw(port, 'GET', '/api/me');
  check('cloud: /api/me without a cookie → 401', r.status === 401);
  r = await raw(port, 'PATCH', '/api/w/smoke-co', { headers: { ...C, ...J }, body: '{"name":"x"}' });
  check('cloud: cookie write without x-vistaro-csrf → 403', r.status === 403);

  r = await raw(port, 'POST', '/api/w/smoke-co/tokens', { headers: { ...C, ...J, ...CSRF }, body: '{"name":"smoke"}' });
  const token = jsonOf(r).token;
  check('cloud: create a CI token → 201 vt_…', r.status === 201 && /^vt_/.test(token || ''));
  const T = { authorization: `Bearer ${token}` };

  const bundle = writeZip([
    { name: 'guide/guide.json', data: Buffer.from(JSON.stringify({ title: 'Smoke guide', locale: 'en', steps: [{ id: 'a', number: 1, title: 'First' }] })) },
    { name: 'guide/guide.html', data: Buffer.from('<!doctype html><html><body><section class="step"><h2>First</h2></section></body></html>') },
    { name: 'index.json', data: Buffer.from(JSON.stringify({ guides: [{ slug: 'smoke', locale: 'en', stale: true }] })) },
  ]);
  r = await raw(port, 'POST', '/api/w/~/projects/smoke-guide/releases?sha=abc123&branch=main', { headers: { ...T, 'content-type': 'application/zip', 'content-length': bundle.length }, body: bundle });
  const pub = jsonOf(r);
  check('cloud: publish a CLI-built guide with the token → 201 live #1, stale guide reported',
    r.status === 201 && pub.release && pub.release.number === 1 && pub.release.status === 'live' && pub.project.freshness.stale[0] === 'smoke (en)');
  r = await raw(port, 'POST', '/api/w/~/projects/x/releases', { headers: { authorization: 'Bearer vt_forged', 'content-type': 'application/zip' }, body: bundle });
  check('cloud: publish with a forged token → 401', r.status === 401);

  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/', { host: content });
  check('cloud: content /p/<ws>/<project>/ → 302 to the entry', r.status === 302 && r.headers.location === '/p/smoke-co/smoke-guide/guide/guide.html');
  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/guide/guide.html', { host: content });
  check('cloud: published page carries the viewer script and, on free, the badge',
    r.status === 200 && r.text.includes('/_v/v.js') && /"badge":true/.test(r.text));
  const projectId = (/"p":"(prj_[0-9a-f]+)"/.exec(r.text) || [])[1];
  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/guide/guide.html');
  check('cloud: the app host never serves published HTML (302 to the content origin)', r.status === 302 && String(r.headers.location).startsWith(`http://localhost:${port}/p/`));
  r = await raw(port, 'GET', '/api/me', { host: content, headers: C });
  check('cloud: the content host never serves the API', r.status === 404);
  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/..%2f..%2fstrings.json', { host: content });
  check('cloud: traversal out of a release → 400/404', r.status === 400 || r.status === 404);

  r = await raw(port, 'POST', '/_v/e', { host: content, body: JSON.stringify([{ p: projectId, t: 'view', s: 'smoke-sess-1' }, { p: projectId, t: 'complete', s: 'smoke-sess-1' }]) });
  check('cloud: beacon → 204', r.status === 204);
  r = await raw(port, 'GET', '/api/w/smoke-co/projects/smoke-guide/analytics', { headers: C });
  const an = jsonOf(r);
  check('cloud: analytics count the beacon (1 view, 100% completion) and lock funnels on free',
    r.status === 200 && an.totals.views === 1 && an.totals.completionRate === 1 && an.funnelsLocked === true);

  r = await raw(port, 'PATCH', '/api/w/smoke-co/projects/smoke-guide', { headers: { ...C, ...J, ...CSRF }, body: '{"gate":{"enabled":true}}' });
  check('cloud: lead gate on free → 402 naming Pro', r.status === 402 && jsonOf(r).upgradeTo === 'pro');

  r = await raw(port, 'PUT', '/v1/workspaces/smoke-co/plan', { headers: { authorization: `Bearer ${API_KEY}`, ...J }, body: '{"plan":"team"}' });
  check('cloud: operator sets a plan by hand → 200', r.status === 200 && jsonOf(r).plan === 'team');
  r = await raw(port, 'PUT', '/v1/workspaces/smoke-co/plan', { headers: J, body: '{"plan":"enterprise"}' });
  check('cloud: operator plan endpoint without the operator key → 401', r.status === 401);

  r = await raw(port, 'PATCH', '/api/w/smoke-co/projects/smoke-guide', { headers: { ...C, ...J, ...CSRF }, body: '{"gate":{"enabled":true,"fields":["email","company"]},"cta":{"label":"Try it","url":"https://example.com/signup"}}' });
  check('cloud: lead gate + CTA on Team → 200', r.status === 200 && jsonOf(r).project.settings.gate.enabled === true);
  r = await raw(port, 'POST', '/_v/lead', { host: content, headers: J, body: JSON.stringify({ p: projectId, email: 'Buyer@Corp.test', company: '=SUM(A1)' }) });
  check('cloud: a viewer leaves a lead → 201', r.status === 201);
  r = await raw(port, 'GET', '/api/w/smoke-co/projects/smoke-guide/leads?format=csv', { headers: C });
  check('cloud: leads export as CSV with formulas defused', r.status === 200 && r.text.includes('buyer@corp.test') && r.text.includes("'=SUM(A1)"));

  r = await raw(port, 'GET', '/h/smoke-co/', { host: content });
  check('cloud: Team help center → 200 listing the guide', r.status === 200 && r.text.includes('Smoke guide'));

  r = await raw(port, 'PATCH', '/api/w/smoke-co/projects/smoke-guide', { headers: { ...C, ...J, ...CSRF }, body: '{"password":"open-sesame"}' });
  check('cloud: set a demo password → 200', r.status === 200 && jsonOf(r).project.settings.password === true);
  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/guide/guide.html', { host: content });
  check('cloud: protected demo without the unlock cookie → 401 form', r.status === 401 && r.text.includes('/_v/unlock'));
  r = await raw(port, 'POST', '/_v/unlock', { host: content, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `p=${projectId}&password=wrong&next=/p/smoke-co/smoke-guide/` });
  check('cloud: wrong password → 403', r.status === 403);
  r = await raw(port, 'POST', '/_v/unlock', { host: content, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `p=${projectId}&password=open-sesame&next=/p/smoke-co/smoke-guide/` });
  const unlock = String(r.headers['set-cookie'] || '').split(';')[0];
  check('cloud: right password → 303 with an unlock cookie', r.status === 303 && /^vp_/.test(unlock));
  r = await raw(port, 'GET', '/p/smoke-co/smoke-guide/guide/guide.html', { host: content, headers: { cookie: unlock } });
  check('cloud: the unlock cookie opens the demo → 200', r.status === 200);

  r = await raw(port, 'POST', '/api/billing/webhook', { headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
  check('cloud: Stripe webhook with a bad signature → 400', r.status === 400);
  r = await raw(port, 'POST', '/api/w/smoke-co/billing/checkout', { headers: { ...C, ...J, ...CSRF }, body: '{"plan":"pro"}' });
  check('cloud: checkout without Stripe keys → 501', r.status === 501);
  r = await raw(port, 'GET', '/_v/v.js', { host: content });
  check('cloud: viewer script served on the content origin', r.status === 200 && r.text.includes('__vistaro'));
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vistaro-smoke-'));
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
    check('GET /health → 200 ok:true', res.status === 200 && body.ok === true && body.service === 'vistaro-cloud');

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
    const timelineConfig = JSON.stringify({
      meta: { title: 'Smoke screen', slug: 'smoke', tailMs: 500 },
      steps: [
        { id: 'intro', time: '0s', action: 'fadeIn', target: 'body' },
        { id: 'go', time: '0.5s', action: 'click', target: '#go' },
      ],
    });
    const zip = zipOf([
      { name: 'index.html', data: Buffer.from(indexHtml), deflate: false },
      { name: 'vistaro.config.json', data: Buffer.from(timelineConfig), deflate: true },
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

    // 9. Dashboards: the customer app at /, the operator console at /ops
    res = await fetch(`${base}/`);
    const dash = await res.text();
    check('GET / → 200 Vistaro Cloud dashboard',
      res.status === 200 && dash.includes('Vistaro Cloud') && res.headers.get('content-type').includes('text/html'));
    res = await fetch(`${base}/ops`);
    check('GET /ops → 200 operator console', res.status === 200 && (await res.text()).includes('Vistaro ops'));

    // 10. Vistaro Cloud end to end over real HTTP (lib/cloud). The app answers on
    // 127.0.0.1, published content on localhost: two hosts, two cookie jars.
    await cloudChecks(base, port);

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
