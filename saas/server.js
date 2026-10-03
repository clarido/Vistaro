'use strict';
/**
 * Demoforge SaaS — MVP backend. Zero runtime dependencies (node:http,
 * node:crypto, node:zlib, built-in fetch).
 *
 *   GET  /health                 liveness + queue/billing facts
 *   POST /v1/builds              upload a project .zip, queue an export (auth)
 *   GET  /v1/builds              list builds (auth)
 *   GET  /v1/builds/<id>         one build's status, artifacts, log (auth)
 *   POST /v1/billing/checkout    Stripe Checkout session (auth; 501 unconfigured)
 *   GET  /embed/<id>/<path>      a build's artifacts, public, Range-capable
 *   GET  /                       the dashboard (saas/public/index.html)
 *
 * Auth: Bearer keys from SAAS_API_KEYS (comma-separated). Everything under
 * /v1/* requires a key; /health, / and /embed/* are public.
 *
 * The export runner is serial (one browser-driven CLI at a time — AGENTS.md
 * warns concurrent runs corrupt each other) and lives in lib/queue.js.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const { json, readBody, readJsonBody, serveFile, HttpError } = require('./lib/httputil');
const { Auth, parseApiKeys } = require('./lib/auth');
const jobs = require('./lib/jobs');
const { unpackProject } = require('./lib/project');
const { ExportQueue } = require('./lib/queue');
const { createCheckoutSession, PLAN_ENV } = require('./lib/stripe');
const { looksLikeZip, ZipError } = require('./lib/zip');

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Environment (documented in saas/README.md)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(process.env.SAAS_REPO_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(
  process.env.SAAS_DATA_DIR || path.join(__dirname, 'data'),
);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const MAX_UPLOAD_BYTES =
  Number.parseInt(process.env.SAAS_MAX_UPLOAD_MB || '100', 10) * 1024 * 1024;
const EXPORT_TIMEOUT_MS = Number.parseInt(
  process.env.SAAS_EXPORT_TIMEOUT_MS || String(30 * 60 * 1000),
  10,
);
const RUNNER_DISABLED = process.env.SAAS_DISABLE_RUNNER === '1';

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const auth = new Auth(parseApiKeys(process.env.SAAS_API_KEYS));
fs.mkdirSync(jobs.jobsRoot(DATA_DIR), { recursive: true });

const log = (line) => process.stderr.write(`[demoforge] ${line}\n`);
const queue = new ExportQueue({
  dataDir: DATA_DIR,
  repoRoot: REPO_ROOT,
  timeoutMs: EXPORT_TIMEOUT_MS,
  disabled: RUNNER_DISABLED,
  log,
});
queue.markInterruptedJobs();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireAuth(req, res) {
  if (!auth.configured) {
    json(res, 401, {
      error: 'unauthorized',
      message: 'no API keys are configured on this server (set SAAS_API_KEYS)',
    });
    return false;
  }
  if (!auth.check(req.headers.authorization)) {
    json(res, 401, { error: 'unauthorized', message: 'missing or invalid Bearer key' }, {
      'www-authenticate': 'Bearer',
    });
    return false;
  }
  return true;
}

/** Job meta → public API shape (artifact paths become /embed URLs). */
function jobView(meta, { queuePosition = null } = {}) {
  const view = {
    id: meta.id,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  if (meta.startedAt) view.startedAt = meta.startedAt;
  if (meta.finishedAt) view.finishedAt = meta.finishedAt;
  if (meta.durationMs != null) view.durationMs = meta.durationMs;
  if (meta.uploadBytes != null) view.uploadBytes = meta.uploadBytes;
  if (meta.files != null) view.files = meta.files;
  if (meta.error) view.error = meta.error;
  if (meta.command) view.command = meta.command;
  if (meta.artifacts) {
    view.artifacts = Object.fromEntries(
      Object.entries(meta.artifacts).map(([k, rel]) => [k, `/embed/${meta.id}/${rel}`]),
    );
  }
  if (queuePosition != null) view.queuePosition = queuePosition;
  return view;
}

/**
 * Dev convenience ONLY: the forwarding headers are caller-controlled, so an authenticated
 * caller could aim post-payment redirects at any host. Production deployments set
 * STRIPE_SUCCESS_URL / STRIPE_CANCEL_URL (preferred at the call site above this fallback).
 */
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Serve saas/public/* — only the dashboard, nothing else, from a fixed path. */
function serveDashboard(req, res) {
  const file = path.join(__dirname, 'public', 'index.html');
  return serveFile(req, res, file, { cacheControl: 'no-store' });
}

// Files that are internal bookkeeping, never public artifacts.
const EMBED_DENYLIST = new Set(['job.json', 'upload.zip']);

/** GET /embed/<id>/<...path> — public artifact serving with traversal guards. */
async function serveEmbed(req, res, id, restSegments) {
  if (!jobs.JOB_ID_RE.test(id)) {
    json(res, 404, { error: 'not found' });
    return;
  }
  const dir = jobs.jobDir(DATA_DIR, id);
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  } catch {
    json(res, 404, { error: 'not found', message: `no build ${id}` });
    return;
  }

  // Index: /embed/<id> or /embed/<id>/
  if (restSegments.length === 0) {
    const links = meta.artifacts
      ? Object.entries(meta.artifacts).map(
          ([k, rel]) => `<li><a href="/embed/${id}/${rel}">${k}</a> — ${rel}</li>`,
        ).join('')
      : '<li>no artifacts yet</li>';
    const body = `<!doctype html><meta charset="utf-8"><title>Demoforge build ${id}</title>
<body style="font:14px/1.6 system-ui,sans-serif;background:#0b0d10;color:#e8eaed;max-width:640px;margin:48px auto;padding:0 16px">
<h1 style="font-size:18px">Demoforge build <code>${id}</code></h1>
<p>status: <strong>${meta.status}</strong>${meta.error ? ` — ${String(meta.error).replace(/</g, '&lt;')}` : ''}</p>
<ul>${links}</ul></body>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  // Decode each segment; reject traversal before it reaches the filesystem.
  for (const seg of restSegments) {
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\0') || seg.includes('%00')) {
      json(res, 400, { error: 'bad path' });
      return;
    }
  }
  const rel = restSegments.join('/');
  if (EMBED_DENYLIST.has(rel)) {
    json(res, 403, { error: 'forbidden', message: `${rel} is not a public artifact` });
    return;
  }
  const abs = path.join(dir, ...restSegments);
  // Belt-and-braces containment check (decoding tricks can't escape this).
  const resolved = path.resolve(abs);
  const root = path.resolve(dir) + path.sep;
  if (!(resolved + path.sep).startsWith(root) && resolved !== path.resolve(dir)) {
    json(res, 400, { error: 'bad path' });
    return;
  }
  const served = await serveFile(req, res, resolved);
  if (!served) json(res, 404, { error: 'not found', message: `no artifact ${rel}` });
}

// ---------------------------------------------------------------------------
// POST /v1/builds — the upload + queue endpoint
// ---------------------------------------------------------------------------

async function createBuild(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(contentType)) {
    json(res, 415, {
      error: 'unsupported media type',
      message: `send the project zip as the raw body with Content-Type: application/zip (got ${contentType || 'none'})`,
    });
    return;
  }

  const zipBuf = await readBody(req, MAX_UPLOAD_BYTES);

  const { id, dir } = jobs.createJobDirs(DATA_DIR);
  try {
    fs.writeFileSync(path.join(dir, 'upload.zip'), zipBuf);
    const { files, bytes } = unpackProject(zipBuf, dir);
    const meta = {
      id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      files,
      uploadBytes: bytes,
    };
    jobs.writeMeta(DATA_DIR, meta);
    queue.enqueue(meta);
    log(`job ${id}: accepted (${bytes} bytes, ${files} files); queue depth ${queue.depth}`);
    json(res, 202, {
      ...jobView(meta),
      message: RUNNER_DISABLED
        ? 'queued, but the runner is disabled on this server (SAAS_DISABLE_RUNNER=1)'
        : 'queued',
      links: { self: `/v1/builds/${id}`, embed: `/embed/${id}/` },
    });
  } catch (e) {
    jobs.deleteJob(DATA_DIR, id);
    if (e instanceof ZipError) {
      json(res, 400, { error: e.message });
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req, res) {
  let segments;
  try {
    const url = new URL(req.url, 'http://localhost');
    segments = url.pathname
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    // Malformed paths (`*`, `%zz`) must answer 400, not a 500 from the catch-all.
    json(res, 400, { error: 'malformed request path' });
    return;
  }

  // --- public ------------------------------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    if (!(await serveDashboard(req, res))) json(res, 404, { error: 'not found' });
    return;
  }

  if (segments[0] === 'health' && segments.length === 1) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    json(res, 200, {
      ok: true,
      service: 'demoforge-saas',
      version: VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      queue: { depth: queue.depth, running: queue.runningJob != null, runnerDisabled: RUNNER_DISABLED },
      billing: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not_configured',
      plans: Object.keys(PLAN_ENV),
    });
    return;
  }

  if (segments[0] === 'embed' && segments.length >= 2) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    await serveEmbed(req, res, segments[1], segments.slice(2));
    return;
  }

  // --- authenticated /v1/* -----------------------------------------------
  if (segments[0] === 'v1') {
    if (!requireAuth(req, res)) return;

    if (segments[1] === 'builds') {
      if (segments.length === 2 && req.method === 'POST') {
        await createBuild(req, res);
        return;
      }
      if (segments.length === 2 && req.method === 'GET') {
        const all = jobs.listJobs(DATA_DIR);
        json(res, 200, { jobs: all.map((m) => jobView(m, { queuePosition: queue.position(m.id) })) });
        return;
      }
      if (segments.length === 3 && req.method === 'GET') {
        if (!jobs.JOB_ID_RE.test(segments[2])) { json(res, 404, { error: 'not found' }); return; }
        const meta = jobs.readMeta(DATA_DIR, segments[2]);
        if (!meta) { json(res, 404, { error: 'not found', message: `no build ${segments[2]}` }); return; }
        json(res, 200, { ...jobView(meta, { queuePosition: queue.position(meta.id) }), log: meta.log || null });
        return;
      }
      json(res, segments.length === 3 ? 405 : 404, { error: 'not found' });
      return;
    }

    if (segments[1] === 'billing' && segments[2] === 'checkout' && segments.length === 3) {
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
      const body = await readJsonBody(req);
      const { status, body: payload } = await createCheckoutSession(body, process.env, {
        successUrl: process.env.STRIPE_SUCCESS_URL || `${requestOrigin(req)}/billing/success`,
        cancelUrl: process.env.STRIPE_CANCEL_URL || `${requestOrigin(req)}/pricing`,
      });
      json(res, status, payload);
      return;
    }

    json(res, 404, { error: 'not found' });
    return;
  }

  json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started} ms)`);
  });
  route(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) log(`ERROR ${req.method} ${req.url}: ${e && e.stack ? e.stack : e}`);
    if (!res.headersSent) {
      json(res, status, { error: e instanceof HttpError ? e.message : 'internal server error' });
    } else {
      res.destroy();
    }
  });
});

server.listen(PORT, HOST, () => {
  const addr = server.address();
  // stdout line is the boot contract: saas/smoke.mjs parses the port from it.
  process.stdout.write(`listening on http://${HOST}:${addr.port}\n`);
  log(`demoforge-saas ${VERSION}`);
  log(`repo root: ${REPO_ROOT}`);
  log(`data dir:  ${DATA_DIR}`);
  log(`api keys:  ${auth.configured ? `${auth.count} configured` : 'NONE — every /v1 request will 401 (set SAAS_API_KEYS)'}`);
  log(`runner:    ${RUNNER_DISABLED ? 'DISABLED (SAAS_DISABLE_RUNNER=1 — jobs stay queued)' : 'enabled (serial, one export at a time)'}`);
  log(`billing:   ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured (checkout returns 501)'}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received; closing server and killing any running export`);
  queue.shutdown();
  server.close(() => process.exit(0));
  // Nothing in a run may wait forever (repo house rule): force-exit if
  // connections or the child outstay their welcome.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
