'use strict';
/**
 * The CONTENT origin: where published demos are served to viewers.
 *
 *   /p/<workspace>/<project>/<path>   the live release of a project
 *   /r/<previewKey>/<path>            one specific release (draft review links)
 *   /h/<workspace>/                   the workspace's help center (Team)
 *   /_v/v.js                          the viewer script injected into every page
 *   /_v/e     POST                    analytics beacon
 *   /_v/lead  POST                    lead-capture form
 *   /_v/unlock POST                   password form
 * and on a workspace's custom domain:
 *   /                                 help center, else a project index
 *   /<project>/<path>                 that project's live release
 *
 * Why a separate origin: published bundles are customer HTML with scripts.
 * Serving them on the dashboard's origin would hand any published page the
 * dashboard's cookies. Dev defaults keep the split real: the app answers on
 * 127.0.0.1 and content on localhost -- different hosts, so different cookie
 * jars (see server.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { json, readBody, serveFile, contentTypeFor, HttpError } = require('../httputil');
const { esc, inlineJson, hmac, parseCookies, serializeCookie, verifyPassword, normalizeEmail, id } = require('./util');
const { can, planOf } = require('./plans');
const { siteDir } = require('./publish');

const MAX_INJECT_BYTES = 8 * 1024 * 1024;
const VIEWER_JS = path.join(__dirname, '..', '..', 'public', 'v.js');

class RateLimiter {
  constructor({ limit, windowMs, now = () => Date.now() }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  allow(key) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      h = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, h);
      if (this.hits.size > 50000) this.sweep(t);
    }
    h.count += 1;
    return h.count <= this.limit;
  }

  sweep(t) {
    for (const [k, h] of this.hits) if (h.resetAt <= t) this.hits.delete(k);
  }
}

/** Insert `snippet` before the last </body>, or append it. */
function injectIntoHtml(html, snippet) {
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + snippet + html.slice(i) : html + snippet;
}

class ContentServer {
  constructor({ store, publisher, analytics, notifier, secretKey, log = () => {} }) {
    this.store = store;
    this.publisher = publisher;
    this.analytics = analytics;
    this.notifier = notifier;
    this.secretKey = secretKey;
    this.log = log;
    this.eventLimiter = new RateLimiter({ limit: 240, windowMs: 60000 });
    this.leadLimiter = new RateLimiter({ limit: 12, windowMs: 60000 });
    this.unlockLimiter = new RateLimiter({ limit: 20, windowMs: 60000 });
  }

  workspaceBySlug(slug) {
    return this.store.findOne('workspaces', (w) => w.slug === slug);
  }

  workspaceByDomain(hostname) {
    if (!hostname) return null;
    return this.store.findOne('workspaces', (w) => w.customDomain && w.customDomain === hostname && can(w, 'custom-domain'));
  }

  /**
   * @param {string[]} segments decoded path segments
   * @param {{customWorkspace?: object|null}} ctx
   * @returns {Promise<boolean>} false when the path is not a content route
   */
  async route(req, res, segments, { customWorkspace = null, ip = '' } = {}) {
    const head = segments[0];

    if (head === '_v') return this.viewerEndpoints(req, res, segments.slice(1), ip);

    if (customWorkspace) {
      if (segments.length === 0) return this.serveDomainRoot(req, res, customWorkspace);
      const project = this.publisher.projectBySlug(customWorkspace.id, segments[0]);
      if (!project) return notFound(res);
      return this.serveProject(req, res, customWorkspace, project, segments.slice(1), `/${project.slug}/`);
    }

    if (head === 'p' && segments.length >= 3) {
      const ws = this.workspaceBySlug(segments[1]);
      const project = ws && this.publisher.projectBySlug(ws.id, segments[2]);
      if (!project) return notFound(res);
      return this.serveProject(req, res, ws, project, segments.slice(3), `/p/${ws.slug}/${project.slug}/`);
    }

    if (head === 'r' && segments.length >= 2) {
      const rel = this.store.findOne('releases', (r) => r.previewKey === segments[1]);
      if (!rel) return notFound(res);
      const ws = this.store.get('workspaces', rel.workspaceId);
      const project = this.store.get('projects', rel.projectId);
      if (!ws || !project) return notFound(res);
      return this.serveRelease(req, res, ws, project, rel, segments.slice(2), `/r/${rel.previewKey}/`, { preview: true });
    }

    if (head === 'h' && segments.length >= 2) {
      const ws = this.workspaceBySlug(segments[1]);
      if (!ws || !can(ws, 'help-center')) return notFound(res);
      if (segments.length === 3 && segments[2] === 'search.json') {
        json(res, 200, { guides: this.helpIndex(ws, `/p/${ws.slug}/`) }, { 'access-control-allow-origin': '*' });
        return true;
      }
      if (segments.length > 2) return notFound(res);
      return this.serveHelpCenter(req, res, ws, `/p/${ws.slug}/`);
    }
    return false;
  }

  // ---- projects & releases ---------------------------------------------

  async serveProject(req, res, ws, project, rest, base) {
    const rel = project.liveReleaseId && this.store.get('releases', project.liveReleaseId);
    if (!rel) return htmlPage(res, 404, 'Not published yet', `<p>${esc(project.title)} has no live release yet.</p>`);
    return this.serveRelease(req, res, ws, project, rel, rest, base, { preview: false });
  }

  async serveRelease(req, res, ws, project, rel, rest, base, { preview }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return true; }
    // The bare project URL opens the release's entry file.
    if (rest.length === 0) {
      if (!req.url.split('?')[0].endsWith('/')) return redirect(res, `${base}`);
      if (rel.entry !== 'index.html') return redirect(res, `${base}${rel.entry.split('/').map(encodeURIComponent).join('/')}`);
      rest = ['index.html'];
    }
    for (const seg of rest) {
      if (seg === '' || seg === '.' || seg === '..' || seg.includes('\0')) { json(res, 400, { error: 'bad path' }); return true; }
    }

    if (!preview && project.settings.passwordHash && can(ws, 'password') && !this.unlocked(req, project)) {
      return this.servePasswordPage(res, project, base);
    }

    const root = siteDir(this.publisher.dataDir, rel.id);
    const abs = path.resolve(root, ...rest);
    if (!abs.startsWith(path.resolve(root) + path.sep)) { json(res, 400, { error: 'bad path' }); return true; }
    let st;
    try { st = fs.statSync(abs); } catch { return notFound(res); }
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (!fs.existsSync(idx)) return notFound(res);
      if (!req.url.split('?')[0].endsWith('/')) return redirect(res, `${req.url.split('?')[0]}/`);
      return this.serveHtml(req, res, idx, ws, project, rel, preview);
    }
    if (contentTypeFor(abs).startsWith('text/html') && st.size <= MAX_INJECT_BYTES) {
      return this.serveHtml(req, res, abs, ws, project, rel, preview);
    }
    await serveFile(req, res, abs, { cacheControl: preview ? 'no-store' : 'public, max-age=300' });
    return true;
  }

  viewerConfig(ws, project, rel, preview) {
    const s = project.settings || {};
    const cfg = {
      p: project.id, r: rel.number, kind: rel.kind, title: project.title,
      preview: Boolean(preview), track: !preview,
      badge: !can(ws, 'remove-badge'),
      accent: (ws.brand && ws.brand.accent) || '#E4632B',
      gate: null, cta: null,
    };
    if (!preview && s.gate && s.gate.enabled && can(ws, 'lead-capture')) {
      cfg.gate = { headline: String(s.gate.headline || '').slice(0, 140), fields: (s.gate.fields || ['email']).filter((f) => ['email', 'name', 'company'].includes(f)) };
      if (!cfg.gate.fields.includes('email')) cfg.gate.fields.unshift('email');
    }
    if (s.cta && s.cta.url && can(ws, 'cta')) cfg.cta = { label: String(s.cta.label || 'Get started').slice(0, 40), url: s.cta.url };
    return cfg;
  }

  serveHtml(req, res, abs, ws, project, rel, preview) {
    const html = fs.readFileSync(abs, 'utf8');
    const cfg = this.viewerConfig(ws, project, rel, preview);
    const snippet = `\n<script>window.__vistaro=${inlineJson(cfg)};</script><script src="/_v/v.js" async></script>\n`;
    const body = Buffer.from(injectIntoHtml(html, snippet), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...(preview ? { 'x-robots-tag': 'noindex' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  // ---- password -------------------------------------------------------

  unlockCookieName(project) {
    return `vp_${project.id.slice(4)}`;
  }

  unlockValue(project) {
    return hmac(this.secretKey, `${project.id}:${project.settings.passwordVersion}`);
  }

  unlocked(req, project) {
    const c = parseCookies(req.headers.cookie)[this.unlockCookieName(project)];
    return typeof c === 'string' && c === this.unlockValue(project);
  }

  servePasswordPage(res, project, base) {
    return htmlPage(res, 401, `${project.title} is protected`, `
<form method="post" action="/_v/unlock" style="display:grid;gap:12px;max-width:320px">
  <input type="hidden" name="p" value="${esc(project.id)}"><input type="hidden" name="next" value="${esc(base)}">
  <label>Password<br><input name="password" type="password" required autofocus style="width:100%;padding:10px;border-radius:8px;border:1px solid #ccc;font:inherit"></label>
  <button style="padding:10px;border-radius:8px;border:0;background:#E4632B;color:#fff;font:600 15px system-ui">Open the demo</button>
</form>`);
  }

  // ---- viewer endpoints -----------------------------------------------

  async viewerEndpoints(req, res, rest, ip) {
    const name = rest.join('/');
    if (name === 'v.js') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return true; }
      await serveFile(req, res, VIEWER_JS, { cacheControl: 'public, max-age=300' });
      return true;
    }
    if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true; }

    if (name === 'e') {
      if (!this.eventLimiter.allow(ip)) { res.writeHead(204); res.end(); return true; }
      const raw = await readBody(req, 8 * 1024);
      let batch;
      try { batch = JSON.parse(raw.toString('utf8')); } catch { batch = null; }
      const list = Array.isArray(batch) ? batch.slice(0, 20) : [batch];
      for (const ev of list) {
        const project = ev && typeof ev.p === 'string' && this.store.get('projects', ev.p);
        if (project) this.analytics.record(project.id, ev);
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return true;
    }

    if (name === 'lead') {
      if (!this.leadLimiter.allow(ip)) { json(res, 429, { error: 'too many requests' }); return true; }
      const body = await readForm(req);
      const project = typeof body.p === 'string' && this.store.get('projects', body.p);
      const ws = project && this.store.get('workspaces', project.workspaceId);
      if (!project || !ws || !project.settings.gate || !project.settings.gate.enabled || !can(ws, 'lead-capture')) {
        json(res, 404, { error: 'this demo does not collect leads' });
        return true;
      }
      const email = normalizeEmail(body.email);
      if (!email) { json(res, 400, { error: 'a valid email is required' }); return true; }
      const lead = {
        id: id('lead'), projectId: project.id, workspaceId: ws.id, email,
        name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
        company: typeof body.company === 'string' ? body.company.slice(0, 120) : null,
        session: typeof body.s === 'string' ? body.s.slice(0, 40) : null,
        referrer: typeof body.ref === 'string' ? body.ref.slice(0, 120) : null,
        at: new Date().toISOString(),
      };
      this.store.put('leads', lead.id, lead);
      if (lead.session) this.analytics.record(project.id, { t: 'lead', s: lead.session });
      this.notifier.send(ws, 'lead.created', `New lead on "${project.title}": ${email}${lead.company ? ` (${lead.company})` : ''}`, {
        project: project.slug, email, name: lead.name, company: lead.company,
      });
      json(res, 201, { ok: true });
      return true;
    }

    if (name === 'unlock') {
      if (!this.unlockLimiter.allow(ip)) { json(res, 429, { error: 'too many attempts, wait a minute' }); return true; }
      const body = await readForm(req);
      const project = typeof body.p === 'string' && this.store.get('projects', body.p);
      const next = typeof body.next === 'string' && /^\/[A-Za-z0-9/_.~-]*$/.test(body.next) ? body.next : '/';
      if (!project || !project.settings.passwordHash || !verifyPassword(String(body.password || ''), project.settings.passwordHash)) {
        return htmlPage(res, 403, 'Wrong password', `<p><a href="${esc(next)}">Try again</a></p>`);
      }
      res.writeHead(303, {
        location: next,
        'set-cookie': serializeCookie(this.unlockCookieName(project), this.unlockValue(project), { maxAge: 7 * 24 * 3600, secure: req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' }),
        'cache-control': 'no-store',
      });
      res.end();
      return true;
    }
    return notFound(res);
  }

  // ---- help center ----------------------------------------------------

  helpIndex(ws, base) {
    const out = [];
    for (const p of this.publisher.projectsOf(ws.id)) {
      if (p.settings.passwordHash && can(ws, 'password')) continue;
      const rel = p.liveReleaseId && this.store.get('releases', p.liveReleaseId);
      if (!rel) continue;
      out.push({
        slug: p.slug, title: p.title, kind: rel.kind, locale: rel.locale || null,
        url: `${base}${p.slug}/`, updatedAt: rel.createdAt,
        steps: (rel.steps || []).map((s) => s.title).filter(Boolean),
        stale: Boolean(p.freshness && p.freshness.stale && p.freshness.stale.length),
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  serveHelpCenter(req, res, ws, base) {
    const guides = this.helpIndex(ws, base);
    const accent = (ws.brand && /^#[0-9a-f]{3,8}$/i.test(ws.brand.accent || '')) ? ws.brand.accent : '#E4632B';
    const name = (ws.brand && ws.brand.logoText) || ws.name;
    const locales = [...new Set(guides.map((g) => g.locale).filter(Boolean))].sort();
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} help center</title>
<style>
:root{--accent:${accent};--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f8fafc;--card:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#e8eaed;--muted:#94a3b8;--line:#263041;--bg:#0b101b;--card:#121a29}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--accent);color:#fff;padding:48px 16px 64px;text-align:center}
header h1{margin:0 0 6px;font-size:clamp(26px,4vw,38px)}header p{margin:0 0 20px;opacity:.9}
.search{max-width:620px;margin:0 auto;display:flex;gap:8px}
.search input{flex:1;padding:14px 16px;border-radius:12px;border:0;font:inherit;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.search select{padding:0 10px;border-radius:12px;border:0;font:inherit}
main{max-width:960px;margin:-32px auto 64px;padding:0 16px;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}
a.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;text-decoration:none;color:inherit}
a.card:hover{border-color:var(--accent)}
.card h2{font-size:17px;margin:0 0 6px}.card p{margin:0;color:var(--muted);font-size:14px}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);margin-right:6px}
.empty{grid-column:1/-1;text-align:center;color:var(--muted);padding:40px}
footer{text-align:center;color:var(--muted);font-size:13px;padding:0 16px 32px}
</style></head><body>
<header><h1>${esc(name)} help center</h1><p>Step-by-step guides, tours and videos, always rebuilt from the current product.</p>
<div class="search"><input id="q" type="search" placeholder="Search guides and steps…" aria-label="Search guides">
${locales.length > 1 ? `<select id="loc" aria-label="Language"><option value="">All languages</option>${locales.map((l) => `<option>${esc(l)}</option>`).join('')}</select>` : ''}</div></header>
<main id="list"></main>
<footer>${can(ws, 'remove-badge') ? '' : 'Help center by <a href="https://vistaro.dev/?ref=helpcenter">Vistaro</a>'}</footer>
<script>
var G=${inlineJson(guides)};
var list=document.getElementById('list'),q=document.getElementById('q'),loc=document.getElementById('loc');
function card(g,hit){var a=document.createElement('a');a.className='card';a.href=g.url;
var h=document.createElement('h2');h.textContent=g.title;a.appendChild(h);
var t=document.createElement('div');[g.kind,g.locale,g.steps.length?g.steps.length+' steps':''].filter(Boolean).forEach(function(x){var s=document.createElement('span');s.className='tag';s.textContent=x;t.appendChild(s)});a.appendChild(t);
var p=document.createElement('p');p.textContent=hit||g.steps.slice(0,3).join(' · ');a.appendChild(p);return a}
function render(){var term=(q.value||'').trim().toLowerCase(),l=loc?loc.value:'';list.textContent='';var n=0;
G.forEach(function(g){if(l&&g.locale!==l)return;var hit='';if(term){if(g.title.toLowerCase().indexOf(term)<0){hit=g.steps.filter(function(s){return s.toLowerCase().indexOf(term)>=0})[0]||'';if(!hit)return}}
list.appendChild(card(g,hit));n++});
if(!n){var e=document.createElement('p');e.className='empty';e.textContent=G.length?'No guide matches that search.':'Nothing is published yet.';list.appendChild(e)}}
q.addEventListener('input',render);if(loc)loc.addEventListener('change',render);render();
</script></body></html>`;
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  serveDomainRoot(req, res, ws) {
    if (can(ws, 'help-center')) return this.serveHelpCenter(req, res, ws, '/');
    const items = this.helpIndex(ws, '/').map((g) => `<li><a href="${esc(g.url)}">${esc(g.title)}</a></li>`).join('');
    return htmlPage(res, 200, ws.name, `<ul>${items || '<li>Nothing is published yet.</li>'}</ul>`);
  }
}

async function readForm(req) {
  const raw = (await readBody(req, 16 * 1024)).toString('utf8');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type === 'text/plain') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { throw new HttpError(400, 'body is not valid JSON'); }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function notFound(res) {
  json(res, 404, { error: 'not found' });
  return true;
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
  return true;
}

function htmlPage(res, status, title, inner) {
  const body = Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font:16px/1.55 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#0f172a;background:#fff">
<h1 style="font-size:22px">${esc(title)}</h1>${inner}</body></html>`, 'utf8');
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

module.exports = { ContentServer, RateLimiter, injectIntoHtml };
