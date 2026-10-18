#!/usr/bin/env node
/**
 * vistaro-cloud -- publish what the free CLI built to Vistaro Cloud, and pull
 * translations back. Zero dependencies; the CLI itself is untouched.
 *
 *   vistaro-cloud publish <dir> --project <slug> [--title T] [--entry path] [--draft] [--notes text]
 *   vistaro-cloud pull-strings <dir> --project <slug> --locale <code> [--out file]
 *
 * Environment:
 *   VISTARO_TOKEN   a workspace token (dashboard → Publish from CI)      required
 *   VISTARO_URL     the Cloud's app URL (default http://127.0.0.1:8787)
 * In GitHub Actions the commit SHA, branch and PR number are attached to the
 * release automatically (GITHUB_SHA, GITHUB_HEAD_REF/GITHUB_REF_NAME, GITHUB_REF).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writeZip } = require('../lib/zipwrite.js');

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
// Never shipped: VCS, dependencies, and the CLI's own scratch/diff state.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.temp-video', '.cache', '.previous']);
const SKIP_FILES = /(^|\/)(\.DS_Store|anim\.manifest\.json|.*\.tmp)$/;

function usage(code) {
  process.stderr.write(`usage:
  vistaro-cloud publish <dir> --project <slug> [--title T] [--entry path] [--draft] [--notes text]
  vistaro-cloud pull-strings <dir> --project <slug> --locale <code> [--out file]
env: VISTARO_TOKEN (required), VISTARO_URL (default http://127.0.0.1:8787)
`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--draft') out.draft = true;
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { process.stderr.write(`missing value for ${a}\n`); usage(2); }
      out[a.slice(2)] = v;
      i += 1;
    } else out._.push(a);
  }
  return out;
}

/** Every file under `dir`, as zip entries with posix names. */
export function collect(dir) {
  const entries = [];
  const walk = (abs, rel) => {
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) walk(path.join(abs, d.name), r);
      } else if (d.isFile() && !SKIP_FILES.test(r)) {
        entries.push({ name: r, data: fs.readFileSync(path.join(abs, d.name)) });
      }
    }
  };
  walk(dir, '');
  return entries;
}

function gitFromEnv(env) {
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF || '');
  return {
    sha: env.VISTARO_GIT_SHA || env.GITHUB_SHA || '',
    branch: env.VISTARO_GIT_BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || '',
    pr: env.VISTARO_GIT_PR || (pr ? pr[1] : ''),
  };
}

async function call(method, url, token, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) || text.slice(0, 300) || `HTTP ${res.status}`;
    const hint = res.status === 402 && data && data.upgradeTo ? ` (upgrade to ${data.upgradeTo}: ${data.upgradeUrl})` : '';
    throw new Error(`${res.status} ${msg}${hint}`);
  }
  return { data, text };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage(2);
  const args = parseArgs(rest);
  const token = process.env.VISTARO_TOKEN;
  const base = (process.env.VISTARO_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!token) { process.stderr.write('VISTARO_TOKEN is not set (create one in the dashboard: Publish from CI)\n'); process.exit(2); }
  const dir = args._[0];
  if (!dir || !args.project) usage(2);

  if (cmd === 'publish') {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { process.stderr.write(`${dir} is not a directory\n`); process.exit(2); }
    const entries = collect(dir);
    if (!entries.length) { process.stderr.write(`${dir} is empty\n`); process.exit(2); }
    const zip = writeZip(entries);
    const q = new URLSearchParams();
    if (args.title) q.set('title', args.title);
    if (args.entry) q.set('entry', args.entry);
    if (args.notes) q.set('notes', args.notes);
    if (args.draft) q.set('draft', '1');
    const git = gitFromEnv(process.env);
    for (const k of ['sha', 'branch', 'pr']) if (git[k]) q.set(k, git[k]);
    const url = `${base}/api/w/~/projects/${encodeURIComponent(args.project)}/releases?${q}`;
    process.stderr.write(`publishing ${entries.length} files (${(zip.length / 1048576).toFixed(1)} MB) to ${base} …\n`);
    const { data } = await call('POST', url, token, zip, { 'content-type': 'application/zip' });
    const r = data.release;
    const where = r.status === 'draft' ? `review link: ${data.urls.preview}` : `live at ${data.urls.live}`;
    process.stdout.write(`${data.project.title} #${r.number} (${r.kind}, ${r.status}) — ${where}\n`);
    if (data.project.freshness && data.project.freshness.stale && data.project.freshness.stale.length) {
      process.stdout.write(`warning: stale guides reported by build-all --diff: ${data.project.freshness.stale.join(', ')}\n`);
    }
    return;
  }

  if (cmd === 'pull-strings') {
    if (!args.locale) usage(2);
    const url = `${base}/api/w/~/projects/${encodeURIComponent(args.project)}/strings/${encodeURIComponent(args.locale)}`;
    const { text } = await call('GET', url, token);
    const out = args.out || path.join(dir, `strings.${args.locale}.json`);
    fs.writeFileSync(out, text);
    process.stdout.write(`wrote ${out}\n`);
    return;
  }
  usage(2);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    process.stderr.write(`vistaro-cloud: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  });
}
