'use strict';
/**
 * The APP origin's JSON API (/api/*), used by the dashboard (session cookie)
 * and by CI (workspace token, `Authorization: Bearer vt_...`).
 *
 * Cookie-authenticated writes must carry `x-vistaro-csrf: 1`: a custom header
 * cannot be sent cross-site without a CORS preflight, which this API never
 * grants, so a forged form post from another site is refused.
 *
 * Plan limits surface as 402 Payment Required with { feature, upgradeTo } so
 * the dashboard can turn every wall into an upgrade prompt.
 */

const { json, readBody, readJsonBody, HttpError } = require('../httputil');
const { parseCookies, serializeCookie, hashPassword, esc } = require('./util');
const { Accounts, AccountError, atLeast } = require('./accounts');
const { PLANS, FEATURES, SELF_SERVE, planOf, planView, can, requireFeature, PlanError } = require('./plans');
const { PublishError } = require('./publish');
const { validWebhookUrl } = require('./notify');
const billing = require('./billing');
const { id } = require('./util');

const SESSION_COOKIE = 'vs';
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

class Api {
  constructor({ store, accounts, publisher, analytics, notifier, env, appUrl, contentUrl, maxUploadBytes, log = () => {}, fetchImpl = (...a) => fetch(...a) }) {
    Object.assign(this, { store, accounts, publisher, analytics, notifier, env, appUrl, contentUrl, maxUploadBytes, log, fetchImpl });
    this.secureCookies = appUrl.startsWith('https:');
  }

  // ---- context ----------------------------------------------------------

  sessionToken(req) {
    return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
  }

  bearer(req) {
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || '').trim());
    return m ? m[1] : null;
  }

  /** Who is calling, and as what, for workspace `slug` ('~' = the token's own). */
  context(req, slug) {
    const tok = this.bearer(req);
    if (tok && tok.startsWith('vt_')) {
      const ws = this.accounts.workspaceForToken(tok);
      if (!ws) throw new HttpError(401, 'invalid workspace token');
      if (slug !== '~' && slug !== ws.slug) throw new HttpError(403, 'this token belongs to another workspace');
      return { workspace: ws, user: null, role: 'editor', viaToken: true };
    }
    const user = this.accounts.userForSession(this.sessionToken(req));
    if (!user) throw new HttpError(401, 'sign in first');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-vistaro-csrf'] !== '1') {
      throw new HttpError(403, 'missing x-vistaro-csrf header');
    }
    const ws = this.store.findOne('workspaces', (w) => w.slug === slug);
    const role = ws && this.accounts.roleOf(ws.id, user.id);
    if (!ws || !role) throw new HttpError(404, 'no such workspace');
    return { workspace: ws, user, role, viaToken: false };
  }

  need(ctx, minRole) {
    if (!atLeast(ctx.role, minRole)) throw new HttpError(403, `this needs the ${minRole} role`);
  }

  setSession(res, userId) {
    const { token, maxAgeSec } = this.accounts.createSession(userId);
    res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: maxAgeSec, secure: this.secureCookies }));
  }

  // ---- views ------------------------------------------------------------

  urls(ws, project, rel = null) {
    const live = `${this.contentUrl}/p/${ws.slug}/${project.slug}/`;
    const out = { live, embed: embedSnippet(live, project.title) };
    if (ws.customDomain && can(ws, 'custom-domain')) out.customDomain = `https://${ws.customDomain}/${project.slug}/`;
    if (rel) out.preview = `${this.contentUrl}/r/${rel.previewKey}/`;
    return out;
  }

  workspaceView(ws, role) {
    const plan = planOf(ws);
    return {
      id: ws.id, slug: ws.slug, name: ws.name, role,
      plan: planView(plan),
      usage: { seats: this.accounts.seatsUsed(ws.id), projects: this.publisher.projectsOf(ws.id).length },
      customDomain: ws.customDomain, webhookUrl: atLeast(role, 'admin') ? ws.webhookUrl : null,
      requireReview: Boolean(ws.requireReview), brand: ws.brand,
      billing: ws.billing ? { status: ws.billing.status || null, hasCustomer: Boolean(ws.billing.customerId) } : null,
      urls: {
        helpCenter: can(ws, 'help-center') ? `${this.contentUrl}/h/${ws.slug}/` : null,
        contentHost: new URL(this.contentUrl).host,
      },
      billingConfigured: Boolean(this.env.STRIPE_SECRET_KEY),
      devPlanSwitch: this.env.VISTARO_ALLOW_PLAN_SWITCH === '1',
    };
  }

  releaseView(ws, project, r) {
    return {
      number: r.number, status: r.status, kind: r.kind, entry: r.entry, title: r.title,
      steps: r.steps ? r.steps.length : 0, locales: r.locales || [], files: r.files, bytes: r.bytes,
      notes: r.notes, git: r.git, createdAt: r.createdAt, approvedAt: r.approvedAt || null,
      preview: `${this.contentUrl}/r/${r.previewKey}/`,
      comments: this.store.find('comments', (c) => c.releaseId === r.id && !c.resolved).length,
    };
  }

  projectView(ws, p, { stats = true } = {}) {
    const live = p.liveReleaseId && this.store.get('releases', p.liveReleaseId);
    const view = {
      id: p.id, slug: p.slug, title: p.title, kind: p.kind, createdAt: p.createdAt, updatedAt: p.updatedAt,
      live: live ? live.number : null,
      drafts: this.store.find('releases', (r) => r.projectId === p.id && r.status === 'draft').length,
      settings: {
        gate: p.settings.gate, cta: p.settings.cta, password: Boolean(p.settings.passwordHash),
      },
      freshness: p.freshness,
      urls: this.urls(ws, p),
    };
    if (stats) {
      const s = this.analytics.summary(p.id, { days: 30, retentionDays: planOf(ws).analyticsDays });
      view.stats = { views: s.totals.views, completionRate: s.totals.completionRate, leads: this.store.find('leads', (l) => l.projectId === p.id).length };
    }
    return view;
  }

  // ---- router -------------------------------------------------------------

  /** @returns {Promise<boolean>} false when the path is not an /api route */
  async route(req, res, seg) {
    if (seg[0] !== 'api') return false;
    try {
      await this.dispatch(req, res, seg.slice(1));
    } catch (e) {
      if (e instanceof PlanError) {
        json(res, 402, { error: e.message, feature: e.feature, upgradeTo: e.upgradeTo, upgradeUrl: `${this.appUrl}/#billing` });
      } else if (e instanceof AccountError || e instanceof PublishError) {
        json(res, e.status, { error: e.message });
      } else {
        throw e;
      }
    }
    return true;
  }

  async dispatch(req, res, s) {
    const m = req.method;
    const one = s[0];

    if (one === 'plans' && s.length === 1 && m === 'GET') {
      return json(res, 200, { plans: Object.values(PLANS).map(planView), features: FEATURES, selfServe: SELF_SERVE });
    }
    if (one === 'signup' && m === 'POST') {
      const body = await readJsonBody(req);
      const { user, workspace } = this.accounts.signup(body);
      this.setSession(res, user.id);
      return json(res, 201, { user: userView(user), workspace: this.workspaceView(workspace, this.accounts.roleOf(workspace.id, user.id)) });
    }
    if (one === 'login' && m === 'POST') {
      const body = await readJsonBody(req);
      const user = this.accounts.login(body);
      this.setSession(res, user.id);
      return json(res, 200, { user: userView(user) });
    }
    if (one === 'logout' && m === 'POST') {
      this.accounts.destroySession(this.sessionToken(req));
      res.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: this.secureCookies }));
      return json(res, 200, { ok: true });
    }
    if (one === 'me' && m === 'GET') {
      const user = this.accounts.userForSession(this.sessionToken(req));
      if (!user) return json(res, 401, { error: 'sign in first' });
      return json(res, 200, {
        user: userView(user),
        workspaces: this.accounts.workspacesOf(user.id).map(({ workspace, role }) => ({ slug: workspace.slug, name: workspace.name, role, plan: workspace.plan })),
      });
    }
    if (one === 'billing' && s[1] === 'webhook' && m === 'POST') return this.stripeWebhook(req, res);
    if (one === 'w' && s.length >= 2) return this.workspaceRoutes(req, res, s[1], s.slice(2));
    throw new HttpError(404, 'not found');
  }

  async workspaceRoutes(req, res, slug, s) {
    const ctx = this.context(req, slug);
    const ws = ctx.workspace;
    const m = req.method;

    if (s.length === 0) {
      if (m === 'GET') return json(res, 200, this.workspaceView(ws, ctx.role));
      if (m === 'PATCH') return this.patchWorkspace(req, res, ctx);
    }
    if (s[0] === 'projects') {
      if (s.length === 1 && m === 'GET') {
        return json(res, 200, { projects: this.publisher.projectsOf(ws.id).map((p) => this.projectView(ws, p)) });
      }
      if (s.length >= 2) {
        const pslug = s[1];
        // Publishing may create the project, so it resolves before the lookup.
        if (s[2] === 'releases' && s.length === 3 && m === 'POST') return this.publish(req, res, ctx, pslug);
        const project = this.publisher.projectBySlug(ws.id, pslug);
        if (!project) throw new HttpError(404, `no project ${pslug}`);
        return this.projectRoutes(req, res, ctx, project, s.slice(2));
      }
    }
    if (s[0] === 'members') return this.memberRoutes(req, res, ctx, s.slice(1));
    if (s[0] === 'tokens') return this.tokenRoutes(req, res, ctx, s.slice(1));
    if (s[0] === 'audit' && m === 'GET') {
      this.need(ctx, 'admin');
      requireFeature(ws, 'audit-log');
      const users = (uid) => { const u = uid && this.store.get('users', uid); return u ? u.email : null; };
      return json(res, 200, { entries: this.accounts.auditOf(ws.id).map((a) => ({ ...a, actor: users(a.actorId) })) });
    }
    if (s[0] === 'billing') return this.billingRoutes(req, res, ctx, s.slice(1));
    throw new HttpError(404, 'not found');
  }

  async patchWorkspace(req, res, ctx) {
    this.need(ctx, 'admin');
    const ws = ctx.workspace;
    const b = await readJsonBody(req);
    const patch = {};
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
    if ('customDomain' in b) {
      if (b.customDomain) {
        requireFeature(ws, 'custom-domain');
        const host = String(b.customDomain).trim().toLowerCase().replace(/\.$/, '');
        if (!HOST_RE.test(host)) throw new HttpError(400, 'custom domain must be a hostname like help.example.com');
        const own = [new URL(this.appUrl).hostname, new URL(this.contentUrl).hostname];
        if (own.includes(host)) throw new HttpError(400, 'that hostname belongs to Vistaro');
        const taken = this.store.findOne('workspaces', (w) => w.id !== ws.id && w.customDomain === host);
        if (taken) throw new HttpError(409, 'that domain is used by another workspace');
        patch.customDomain = host;
      } else patch.customDomain = null;
    }
    if ('webhookUrl' in b) {
      if (b.webhookUrl) {
        requireFeature(ws, 'webhooks');
        if (!validWebhookUrl(b.webhookUrl, { allowHttp: this.env.VISTARO_ALLOW_HTTP_WEBHOOKS === '1' })) throw new HttpError(400, 'webhook URL must be https://');
        patch.webhookUrl = String(b.webhookUrl);
      } else patch.webhookUrl = null;
    }
    if ('requireReview' in b) {
      if (b.requireReview) requireFeature(ws, 'review');
      patch.requireReview = Boolean(b.requireReview);
    }
    if (b.brand && typeof b.brand === 'object') {
      const brand = { ...ws.brand };
      if (typeof b.brand.accent === 'string' && /^#[0-9a-f]{6}$/i.test(b.brand.accent)) brand.accent = b.brand.accent;
      if (typeof b.brand.logoText === 'string') brand.logoText = b.brand.logoText.slice(0, 40);
      patch.brand = brand;
    }
    const next = this.store.update('workspaces', ws.id, patch);
    this.accounts.audit(ws.id, ctx.user && ctx.user.id, 'workspace.update', { fields: Object.keys(patch) });
    if (b.webhookTest && next.webhookUrl) await this.notifier.send(next, 'webhook.test', 'Webhook connected. Leads, publishes and stale guides will arrive here.');
    return json(res, 200, this.workspaceView(next, ctx.role));
  }

  async publish(req, res, ctx, pslug) {
    this.need(ctx, 'editor');
    const ws = ctx.workspace;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(type)) {
      throw new HttpError(415, 'send the bundle zip as the raw body with Content-Type: application/zip');
    }
    const q = new URL(req.url, 'http://x').searchParams;
    const zip = await readBody(req, this.maxUploadBytes);
    const { project, release, freshness } = this.publisher.publish(ws, zip, {
      slug: pslug, title: q.get('title') || undefined, entry: q.get('entry') || undefined,
      draft: q.get('draft') === '1' || q.get('draft') === 'true', notes: q.get('notes') || undefined,
      git: { sha: q.get('sha'), branch: q.get('branch'), pr: q.get('pr') },
      actorId: ctx.user ? ctx.user.id : null,
    });
    const urls = this.urls(ws, project, release);
    if (release.status === 'draft') {
      this.notifier.send(ws, 'release.review', `"${project.title}" #${release.number} is waiting for review: ${urls.preview}`, { project: project.slug, number: release.number, preview: urls.preview });
    } else {
      this.notifier.send(ws, 'release.published', `"${project.title}" #${release.number} is live: ${urls.live}`, { project: project.slug, number: release.number, url: urls.live });
    }
    if (freshness.stale.length) {
      this.notifier.send(ws, 'guides.stale', `${freshness.stale.length} guide(s) in "${project.title}" no longer match the product: ${freshness.stale.join(', ')}`, { project: project.slug, stale: freshness.stale });
    }
    return json(res, 201, { project: this.projectView(ws, project, { stats: false }), release: this.releaseView(ws, project, release), urls });
  }

  async projectRoutes(req, res, ctx, project, s) {
    const ws = ctx.workspace;
    const m = req.method;
    if (s.length === 0) {
      if (m === 'GET') {
        return json(res, 200, { project: this.projectView(ws, project), releases: this.publisher.releasesOf(project.id).map((r) => this.releaseView(ws, project, r)) });
      }
      if (m === 'PATCH') return this.patchProject(req, res, ctx, project);
      if (m === 'DELETE') {
        this.need(ctx, 'admin');
        this.publisher.deleteProject(ws, project, ctx.user && ctx.user.id);
        this.analytics.remove(project.id);
        return json(res, 200, { ok: true });
      }
    }
    if (s[0] === 'analytics' && m === 'GET') {
      this.need(ctx, 'editor');
      const days = Number(new URL(req.url, 'http://x').searchParams.get('days')) || 30;
      const plan = planOf(ws);
      const sum = this.analytics.summary(project.id, { days, retentionDays: plan.analyticsDays, funnels: can(ws, 'step-funnels') });
      sum.retentionDays = Number.isFinite(plan.analyticsDays) ? plan.analyticsDays : null;
      sum.funnelsLocked = !can(ws, 'step-funnels');
      return json(res, 200, sum);
    }
    if (s[0] === 'leads' && m === 'GET') {
      this.need(ctx, 'editor');
      const leads = this.store.find('leads', (l) => l.projectId === project.id).reverse();
      if (new URL(req.url, 'http://x').searchParams.get('format') === 'csv') {
        requireFeature(ws, 'csv-export');
        const rows = [['email', 'name', 'company', 'referrer', 'at'], ...leads.map((l) => [l.email, l.name, l.company, l.referrer, l.at])];
        const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${project.slug}-leads.csv"`, 'cache-control': 'no-store' });
        res.end(csv);
        return;
      }
      return json(res, 200, { leads });
    }
    if (s[0] === 'releases' && s.length >= 2) {
      const rel = this.publisher.releasesOf(project.id).find((r) => r.number === Number(s[1]));
      if (!rel) throw new HttpError(404, `no release #${s[1]}`);
      if (s[2] === 'promote' && m === 'POST') {
        this.need(ctx, ctx.viaToken ? 'editor' : (rel.status === 'draft' ? 'admin' : 'editor'));
        const live = this.publisher.promote(ws, project, rel.number, ctx.user && ctx.user.id);
        const fresh = this.store.get('projects', project.id);
        this.notifier.send(ws, 'release.published', `"${project.title}" #${live.number} is live`, { project: project.slug, number: live.number });
        return json(res, 200, { release: this.releaseView(ws, fresh, live) });
      }
      if (s[2] === 'comments') return this.commentRoutes(req, res, ctx, project, rel, s.slice(3));
    }
    if (s[0] === 'strings') return this.stringRoutes(req, res, ctx, project, s.slice(1));
    throw new HttpError(404, 'not found');
  }

  async patchProject(req, res, ctx, project) {
    this.need(ctx, 'editor');
    const ws = ctx.workspace;
    const b = await readJsonBody(req);
    const settings = { ...project.settings };
    const patch = {};
    if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 120);
    if (b.gate && typeof b.gate === 'object') {
      if (b.gate.enabled) requireFeature(ws, 'lead-capture');
      const fields = Array.isArray(b.gate.fields) ? b.gate.fields.filter((f) => ['email', 'name', 'company'].includes(f)) : settings.gate.fields;
      settings.gate = {
        enabled: Boolean(b.gate.enabled),
        fields: fields.includes('email') ? fields : ['email', ...fields],
        headline: typeof b.gate.headline === 'string' ? b.gate.headline.slice(0, 140) : settings.gate.headline,
      };
    }
    if ('cta' in b) {
      if (b.cta && b.cta.url) {
        requireFeature(ws, 'cta');
        let u;
        try { u = new URL(String(b.cta.url)); } catch { throw new HttpError(400, 'CTA url must be a full http(s) URL'); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'CTA url must be http(s)');
        settings.cta = { label: String(b.cta.label || 'Get started').slice(0, 40), url: u.toString() };
      } else settings.cta = null;
    }
    if ('password' in b) {
      if (b.password) {
        requireFeature(ws, 'password');
        if (String(b.password).length < 4) throw new HttpError(400, 'the password needs at least 4 characters');
        settings.passwordHash = hashPassword(String(b.password));
      } else settings.passwordHash = null;
      settings.passwordVersion = (settings.passwordVersion || 0) + 1;
    }
    patch.settings = settings;
    const next = this.store.update('projects', project.id, patch);
    this.accounts.audit(ws.id, ctx.user && ctx.user.id, 'project.update', { project: project.slug, fields: Object.keys(b) });
    return json(res, 200, { project: this.projectView(ws, next, { stats: false }) });
  }

  async commentRoutes(req, res, ctx, project, rel, s) {
    const ws = ctx.workspace;
    requireFeature(ws, 'review');
    if (s.length === 0 && req.method === 'GET') {
      const list = this.store.find('comments', (c) => c.releaseId === rel.id).map((c) => {
        const u = c.authorId && this.store.get('users', c.authorId);
        return { ...c, author: u ? u.name || u.email : 'CI' };
      });
      return json(res, 200, { comments: list });
    }
    if (s.length === 0 && req.method === 'POST') {
      const b = await readJsonBody(req);
      const body = typeof b.body === 'string' ? b.body.trim().slice(0, 4000) : '';
      if (!body) throw new HttpError(400, 'a comment needs a body');
      const c = {
        id: id('cmt'), releaseId: rel.id, projectId: project.id, authorId: ctx.user ? ctx.user.id : null,
        body, step: typeof b.step === 'string' ? b.step.slice(0, 80) : null, resolved: false, at: new Date().toISOString(),
      };
      this.store.put('comments', c.id, c);
      return json(res, 201, { comment: c });
    }
    if (s.length === 1 && req.method === 'PATCH') {
      const c = this.store.get('comments', s[0]);
      if (!c || c.releaseId !== rel.id) throw new HttpError(404, 'no such comment');
      const b = await readJsonBody(req);
      return json(res, 200, { comment: this.store.update('comments', c.id, { resolved: Boolean(b.resolved) }) });
    }
    throw new HttpError(404, 'not found');
  }

  /**
   * Translation workspace. Sources are the strings.<locale>.json files the
   * live release shipped; edits are stored as overrides and pulled back into
   * the repo by CI (GET .../strings/<locale>), so the CLI stays the renderer.
   */
  async stringRoutes(req, res, ctx, project, s) {
    const ws = ctx.workspace;
    requireFeature(ws, 'translations');
    const rel = project.liveReleaseId && this.store.get('releases', project.liveReleaseId);
    const shipped = rel ? this.publisher.releaseStrings(rel.id) : {};
    const overrides = this.store.get('strings', project.id) || {};
    const locales = [...new Set([...Object.keys(shipped), ...Object.keys(overrides)])].sort();
    const base = shipped.en ? 'en' : (rel && rel.locale && shipped[rel.locale] ? rel.locale : locales[0] || null);
    // Read the store at call time: a PUT below must answer with what it just saved.
    const merged = (loc) => {
      const out = { ...(shipped[loc] || {}) };
      const now = this.store.get('strings', project.id) || {};
      for (const [k, v] of Object.entries(now[loc] || {})) out[k] = v.value;
      return out;
    };

    if (s.length === 0 && req.method === 'GET') {
      this.need(ctx, 'translator');
      const baseStrings = base ? merged(base) : {};
      const keys = Object.keys(baseStrings).sort();
      const table = {};
      for (const loc of locales) {
        const m = merged(loc);
        table[loc] = { values: m, missing: keys.filter((k) => !(k in m) || m[k] === '').length, edited: Object.keys(overrides[loc] || {}).length };
      }
      return json(res, 200, { base, keys, locales: table });
    }
    if (s.length === 1 && req.method === 'GET') {
      this.need(ctx, 'translator');
      const loc = s[0];
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(loc)) throw new HttpError(400, 'bad locale');
      const body = JSON.stringify(sortKeys(merged(loc)), null, 2) + '\n';
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    if (s.length === 1 && req.method === 'PUT') {
      this.need(ctx, 'translator');
      const loc = s[0];
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(loc)) throw new HttpError(400, 'bad locale');
      const b = await readJsonBody(req);
      if (!b.values || typeof b.values !== 'object') throw new HttpError(400, 'send {"values": {"key": "text"}}');
      const all = { ...overrides };
      const cur = { ...(all[loc] || {}) };
      let n = 0;
      for (const [k, v] of Object.entries(b.values)) {
        if (typeof k !== 'string' || k.length > 200) continue;
        if (v === null || v === '') delete cur[k];
        else if (typeof v === 'string') cur[k] = { value: v.slice(0, 5000), by: ctx.user ? ctx.user.id : null, at: new Date().toISOString() };
        n += 1;
      }
      all[loc] = cur;
      this.store.put('strings', project.id, all);
      this.accounts.audit(ws.id, ctx.user && ctx.user.id, 'strings.edit', { project: project.slug, locale: loc, keys: n });
      return json(res, 200, { locale: loc, changed: n, values: merged(loc) });
    }
    throw new HttpError(404, 'not found');
  }

  async memberRoutes(req, res, ctx, s) {
    const ws = ctx.workspace;
    if (ctx.viaToken) throw new HttpError(403, 'tokens cannot manage members');
    if (s.length === 0 && req.method === 'GET') {
      const members = this.accounts.membersOf(ws.id).map((mm) => {
        const u = this.store.get('users', mm.userId);
        return { userId: mm.userId, email: u && u.email, name: u && u.name, role: mm.role };
      });
      const invites = this.store.find('invites', (i) => i.workspaceId === ws.id).map((i) => ({ email: i.email, role: i.role, createdAt: i.createdAt }));
      return json(res, 200, { members, invites, seats: { used: this.accounts.seatsUsed(ws.id), limit: Number.isFinite(planOf(ws).seats) ? planOf(ws).seats : null } });
    }
    this.need(ctx, 'admin');
    if (s.length === 0 && req.method === 'POST') {
      const b = await readJsonBody(req);
      const out = this.accounts.invite(ws, b, ctx.user.id);
      const link = out.token ? `${this.appUrl}/#signup?invite=${encodeURIComponent(b.email)}` : null;
      return json(res, 201, { ...out, token: undefined, link });
    }
    if (s.length === 1 && req.method === 'DELETE') {
      if (s[0].includes('@')) {
        const n = this.store.removeWhere('invites', (i) => i.workspaceId === ws.id && i.email === s[0].toLowerCase());
        if (!n) throw new HttpError(404, 'no such invite');
        return json(res, 200, { ok: true });
      }
      this.accounts.removeMember(ws, s[0], ctx.user.id);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  }

  async tokenRoutes(req, res, ctx, s) {
    const ws = ctx.workspace;
    if (ctx.viaToken) throw new HttpError(403, 'tokens cannot manage tokens');
    this.need(ctx, 'admin');
    if (s.length === 0 && req.method === 'GET') return json(res, 200, { tokens: this.accounts.tokensOf(ws.id) });
    if (s.length === 0 && req.method === 'POST') {
      const b = await readJsonBody(req);
      const { token, record } = this.accounts.createToken(ws, b.name, ctx.user.id);
      return json(res, 201, { token, record });
    }
    if (s.length === 1 && req.method === 'DELETE') {
      this.accounts.revokeToken(ws, s[0], ctx.user.id);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  }

  async billingRoutes(req, res, ctx, s) {
    const ws = ctx.workspace;
    if (ctx.viaToken) throw new HttpError(403, 'tokens cannot manage billing');
    this.need(ctx, 'owner');
    const b = req.method === 'POST' ? await readJsonBody(req) : {};
    if (s[0] === 'checkout' && req.method === 'POST') {
      const out = await billing.checkout(ws, { plan: b.plan, interval: b.interval || 'monthly', email: ctx.user.email }, this.env, {
        successUrl: `${this.appUrl}/#billing?upgraded=1`, cancelUrl: `${this.appUrl}/#billing`, fetchImpl: this.fetchImpl,
      });
      return json(res, out.status, out.body);
    }
    if (s[0] === 'portal' && req.method === 'POST') {
      const out = await billing.portal(ws, this.env, { returnUrl: `${this.appUrl}/#billing`, fetchImpl: this.fetchImpl });
      return json(res, out.status, out.body);
    }
    if (s[0] === 'dev-plan' && req.method === 'POST') {
      // Demo/self-host switch: lets a trial workspace see every tier without Stripe.
      if (this.env.VISTARO_ALLOW_PLAN_SWITCH !== '1') throw new HttpError(403, 'plan switching is disabled on this server');
      if (!PLANS[b.plan]) throw new HttpError(400, 'unknown plan');
      const next = this.store.update('workspaces', ws.id, { plan: b.plan });
      this.accounts.audit(ws.id, ctx.user.id, 'billing.dev-plan', { plan: b.plan });
      return json(res, 200, this.workspaceView(next, ctx.role));
    }
    throw new HttpError(404, 'not found');
  }

  async stripeWebhook(req, res) {
    const raw = await readBody(req, 1024 * 1024);
    const event = billing.verifyWebhook(raw, req.headers['stripe-signature'], this.env.STRIPE_WEBHOOK_SECRET);
    if (!event) return json(res, 400, { error: 'bad signature' });
    const out = billing.applyEvent(
      event,
      (wid) => (wid ? this.store.get('workspaces', wid) : null),
      (sub) => this.store.findOne('workspaces', (w) => w.billing && w.billing.subscriptionId === sub),
    );
    if (out) {
      this.store.update('workspaces', out.workspace.id, out.patch);
      this.accounts.audit(out.workspace.id, null, 'billing.plan', { plan: out.patch.plan, event: event.type });
      this.log(`billing: ${out.workspace.slug} → ${out.patch.plan} (${event.type})`);
    }
    return json(res, 200, { received: true, applied: Boolean(out) });
  }
}

function userView(u) {
  return { id: u.id, email: u.email, name: u.name };
}

function embedSnippet(url, title) {
  return `<iframe src="${esc(url)}" title="${esc(title)}" style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px" allow="fullscreen" loading="lazy"></iframe>`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Leading =+-@ would run as a formula when the CSV opens in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

module.exports = { Api, csvCell, SESSION_COOKIE };
