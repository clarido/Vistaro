'use strict';
/**
 * Publishing: a customer uploads what the free CLI ALREADY BUILT (a guide
 * directory, a tour site, a reel embed, a video) and the Cloud hosts it as a
 * versioned release. Nothing is rendered here -- the bundle is static files.
 *
 * Layout on disk:
 *   <dataDir>/cloud/releases/<releaseId>/site/...    the served files
 *   <dataDir>/cloud/releases/<releaseId>/strings.json  strings.<locale>.json found in the bundle
 */

const fs = require('node:fs');
const path = require('node:path');
const { extractZip, looksLikeZip, ZipError } = require('../zip');
const { id, secret, slugify, SLUG_RE } = require('./util');
const { planOf, requireFeature, PlanError } = require('./plans');

const MAX_STRINGS_BYTES = 2 * 1024 * 1024;
const STRINGS_RE = /(?:^|\/)strings\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.json$/;

class PublishError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PublishError';
    this.status = status;
  }
}

function releasesRoot(dataDir) {
  return path.join(dataDir, 'cloud', 'releases');
}

function siteDir(dataDir, releaseId) {
  return path.join(releasesRoot(dataDir), releaseId, 'site');
}

function readJsonIf(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Decide what a bundle is and which file opens it. Pure over a file list +
 * a reader, so it is unit-testable without a disk.
 * @param {string[]} files posix paths relative to the bundle root
 * @param {(rel: string) => any} readJson parsed JSON of a bundle file, or null
 * @param {string|null} explicitEntry the publisher's --entry, if any
 */
function detectBundle(files, readJson, explicitEntry = null) {
  const has = new Set(files);
  const meta = { kind: 'page', entry: null, title: null, steps: [], locale: null, scenarios: [], generatedAt: null };

  const guidePath = has.has('guide/guide.json') ? 'guide/guide.json' : has.has('guide.json') ? 'guide.json' : null;
  const guide = guidePath ? readJson(guidePath) : null;
  const tours = has.has('tours.json') ? readJson('tours.json') : null;

  if (tours && has.has('index.html')) {
    meta.kind = 'tour';
    meta.entry = 'index.html';
    meta.title = (tours.product && tours.product.name) || null;
    const scen = Array.isArray(tours.scenarios) ? tours.scenarios : [];
    meta.scenarios = scen.map((s) => ({ slug: String(s.slug || ''), label: String(s.label || s.slug || '') })).slice(0, 200);
  } else if (guide && (has.has(guidePath.replace(/guide\.json$/, 'guide.html')))) {
    meta.kind = 'guide';
    meta.entry = guidePath.replace(/guide\.json$/, 'guide.html');
    meta.title = guide.title || null;
    meta.locale = guide.locale || null;
    meta.generatedAt = guide.generatedAt || null;
    meta.steps = (Array.isArray(guide.steps) ? guide.steps : []).map((s) => ({
      key: String(s.id != null ? s.id : s.index), number: s.number, title: String(s.title || ''),
    })).slice(0, 500);
  } else {
    const reel = files.find((f) => /^embed-(desktop|mobile)\.html$/.test(f));
    const video = files.find((f) => /^[^/]+\.mp4$/.test(f));
    if (reel) {
      meta.kind = 'reel';
      meta.entry = has.has('embed-desktop.html') ? 'embed-desktop.html' : reel;
    } else if (video && !has.has('index.html')) {
      meta.kind = 'video';
      meta.entry = video;
    } else if (has.has('index.html')) {
      meta.kind = 'page';
      meta.entry = 'index.html';
    }
  }

  if (explicitEntry) {
    const e = String(explicitEntry).replace(/^\/+/, '');
    if (!has.has(e)) throw new PublishError(400, `--entry ${e} is not in the bundle`);
    meta.entry = e;
  }
  if (!meta.entry) {
    throw new PublishError(400, 'nothing to open in this bundle: expected guide/guide.html, a tour (tours.json + index.html), embed-<device>.html, an .mp4 or index.html');
  }
  return meta;
}

/**
 * Freshness facts the CLI already computes (build-all --diff writes `stale`
 * per guide into index.json); the Cloud only reads them.
 */
function freshnessFrom(files, readJson) {
  const idx = files.includes('index.json') ? readJson('index.json') : null;
  const out = { stale: [], failed: [], checked: 0 };
  if (idx && Array.isArray(idx.guides)) {
    for (const g of idx.guides) {
      out.checked += 1;
      const label = `${g.slug || '?'}${g.locale ? ` (${g.locale})` : ''}`;
      if (g.stale) out.stale.push(label);
      if (g.status === 'failed') out.failed.push(label);
    }
  }
  return out;
}

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Many zips wrap the bundle in one folder; serve from inside it. */
function unwrap(dir) {
  const top = fs.readdirSync(dir, { withFileTypes: true });
  if (top.length === 1 && top[0].isDirectory()) {
    const inner = path.join(dir, top[0].name);
    for (const child of fs.readdirSync(inner)) fs.renameSync(path.join(inner, child), path.join(dir, child));
    fs.rmdirSync(inner);
  }
}

class Publisher {
  /**
   * @param {import('./store').Store} store
   * @param {import('./accounts').Accounts} accounts
   */
  constructor(store, accounts, { dataDir, now = () => Date.now() }) {
    this.store = store;
    this.accounts = accounts;
    this.dataDir = dataDir;
    this.now = now;
    fs.mkdirSync(releasesRoot(dataDir), { recursive: true });
  }

  projectsOf(workspaceId) {
    return this.store.find('projects', (p) => p.workspaceId === workspaceId);
  }

  projectBySlug(workspaceId, slug) {
    return this.store.findOne('projects', (p) => p.workspaceId === workspaceId && p.slug === slug);
  }

  releasesOf(projectId) {
    return this.store.find('releases', (r) => r.projectId === projectId).sort((a, b) => b.number - a.number);
  }

  /** Projects are created implicitly by the first publish to a new slug. */
  ensureProject(workspace, slugIn, title) {
    const slug = slugify(slugIn);
    if (!slug || !SLUG_RE.test(slug)) throw new PublishError(400, 'a project slug is required (letters, digits, dashes)');
    const existing = this.projectBySlug(workspace.id, slug);
    if (existing) return existing;
    const plan = planOf(workspace);
    if (this.projectsOf(workspace.id).length >= plan.projects) {
      throw new PlanError(`the ${plan.name} plan hosts ${plan.projects} live projects; delete one or upgrade`, { feature: 'projects', upgradeTo: 'pro' });
    }
    const p = {
      id: id('prj'), workspaceId: workspace.id, slug, title: String(title || slug).slice(0, 120), kind: null,
      liveReleaseId: null, createdAt: new Date(this.now()).toISOString(), updatedAt: null,
      settings: { gate: { enabled: false, fields: ['email'], headline: 'Enter your email to watch the demo' }, cta: null, passwordHash: null, passwordVersion: 0 },
      freshness: null,
    };
    return this.store.put('projects', p.id, p);
  }

  /**
   * @param {object} workspace
   * @param {Buffer} zipBuf
   * @param {{slug: string, title?: string, entry?: string, draft?: boolean, notes?: string, git?: object, actorId?: string|null}} opts
   */
  publish(workspace, zipBuf, opts) {
    if (!looksLikeZip(zipBuf)) throw new PublishError(400, 'the bundle must be a ZIP archive');
    const draft = Boolean(opts.draft) || Boolean(workspace.requireReview);
    if (draft) requireFeature(workspace, 'review');

    const project = this.ensureProject(workspace, opts.slug, opts.title);
    const releaseId = id('rel');
    const root = path.join(releasesRoot(this.dataDir), releaseId);
    const site = path.join(root, 'site');
    fs.mkdirSync(site, { recursive: true });
    try {
      let bytes = 0;
      extractZip(zipBuf, (entry) => {
        const target = path.join(site, ...entry.name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.data);
        bytes += entry.data.length;
      });
      unwrap(site);
      const files = listFiles(site);
      const readJson = (rel) => readJsonIf(path.join(site, ...rel.split('/')));
      const meta = detectBundle(files, readJson, opts.entry || null);
      const freshness = freshnessFrom(files, readJson);

      // Translation sources: every strings.<locale>.json, keyed by locale (root wins).
      const strings = {};
      let stringsBytes = 0;
      for (const f of files) {
        const m = STRINGS_RE.exec(f);
        if (!m) continue;
        const data = readJson(f);
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        stringsBytes += fs.statSync(path.join(site, ...f.split('/'))).size;
        if (stringsBytes > MAX_STRINGS_BYTES) break;
        const locale = m[1];
        if (strings[locale] && f.includes('/')) continue;
        const flat = {};
        for (const [k, v] of Object.entries(data)) if (typeof v === 'string') flat[k] = v;
        strings[locale] = flat;
      }
      fs.writeFileSync(path.join(root, 'strings.json'), JSON.stringify(strings));

      const prev = this.releasesOf(project.id);
      const release = {
        id: releaseId, projectId: project.id, workspaceId: workspace.id,
        number: (prev[0] ? prev[0].number : 0) + 1,
        status: draft ? 'draft' : 'live',
        kind: meta.kind, entry: meta.entry, title: meta.title || project.title, steps: meta.steps,
        scenarios: meta.scenarios, locale: meta.locale, generatedAt: meta.generatedAt,
        locales: Object.keys(strings).sort(),
        files: files.length, bytes, notes: opts.notes ? String(opts.notes).slice(0, 500) : null,
        git: sanitizeGit(opts.git), previewKey: secret('', 18),
        createdAt: new Date(this.now()).toISOString(), createdBy: opts.actorId || null,
      };
      this.store.put('releases', release.id, release);

      const patch = { kind: meta.kind, updatedAt: release.createdAt };
      if (!opts.title && meta.title && !project.liveReleaseId) patch.title = String(meta.title).slice(0, 120);
      if (freshness.checked) patch.freshness = { ...freshness, at: release.createdAt };
      if (!draft) {
        for (const r of prev) if (r.status === 'live') this.store.update('releases', r.id, { status: 'archived' });
        patch.liveReleaseId = release.id;
      }
      const updated = this.store.update('projects', project.id, patch);
      this.prune(workspace, updated);
      this.accounts.audit(workspace.id, opts.actorId, draft ? 'release.draft' : 'release.publish', { project: project.slug, number: release.number });
      return { project: updated, release, freshness };
    } catch (e) {
      fs.rmSync(root, { recursive: true, force: true });
      if (e instanceof ZipError) throw new PublishError(400, e.message);
      throw e;
    }
  }

  /** Make a draft or an archived release the live one (approval / rollback). */
  promote(workspace, project, releaseNumber, actorId, { rollback = false } = {}) {
    const rel = this.releasesOf(project.id).find((r) => r.number === Number(releaseNumber));
    if (!rel) throw new PublishError(404, `no release #${releaseNumber}`);
    if (rel.status === 'live') return rel;
    if (rel.status === 'archived') requireFeature(workspace, 'rollback');
    if (rel.status === 'draft') requireFeature(workspace, 'review');
    for (const r of this.releasesOf(project.id)) if (r.status === 'live') this.store.update('releases', r.id, { status: 'archived' });
    const live = this.store.update('releases', rel.id, { status: 'live', approvedBy: actorId || null, approvedAt: new Date(this.now()).toISOString() });
    this.store.update('projects', project.id, { liveReleaseId: rel.id, kind: rel.kind, updatedAt: live.approvedAt });
    this.accounts.audit(workspace.id, actorId, rollback || rel.status === 'archived' ? 'release.rollback' : 'release.approve', { project: project.slug, number: rel.number });
    return live;
  }

  /**
   * Keep the plan's release history (the live release counts toward it and is
   * never pruned; drafts awaiting review are not history and are kept).
   */
  prune(workspace, project) {
    const keep = planOf(workspace).releaseHistory;
    let kept = project.liveReleaseId ? 1 : 0;
    for (const r of this.releasesOf(project.id)) {
      if (r.id === project.liveReleaseId || r.status === 'draft') continue;
      if (kept >= keep) this.deleteRelease(r);
      else kept += 1;
    }
  }

  deleteRelease(r) {
    fs.rmSync(path.join(releasesRoot(this.dataDir), r.id), { recursive: true, force: true });
    this.store.remove('releases', r.id);
    this.store.removeWhere('comments', (c) => c.releaseId === r.id);
  }

  deleteProject(workspace, project, actorId) {
    for (const r of this.releasesOf(project.id)) this.deleteRelease(r);
    this.store.removeWhere('leads', (l) => l.projectId === project.id);
    const strings = this.store.get('strings', project.id);
    if (strings) this.store.remove('strings', project.id);
    this.store.remove('projects', project.id);
    this.accounts.audit(workspace.id, actorId, 'project.delete', { project: project.slug });
  }

  releaseStrings(releaseId) {
    return readJsonIf(path.join(releasesRoot(this.dataDir), releaseId, 'strings.json')) || {};
  }
}

function sanitizeGit(git) {
  if (!git || typeof git !== 'object') return null;
  const pick = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const out = { sha: pick(git.sha, 64), branch: pick(git.branch, 120), pr: pick(String(git.pr || ''), 20) };
  return out.sha || out.branch || out.pr ? out : null;
}

module.exports = { Publisher, PublishError, detectBundle, freshnessFrom, siteDir, releasesRoot };
