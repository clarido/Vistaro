'use strict';
/**
 * Viewer analytics for published demos: views, sessions, completion, dwell,
 * per-step drop-off, referrers. Cookieless by design -- the beacon keeps a
 * random per-visit id in sessionStorage and sends no personal data, so a
 * customer can embed a demo without a consent-banner change.
 *
 * Storage: one append-only JSONL file per project under
 * <dataDir>/cloud/analytics/<projectId>.jsonl. Queries read and aggregate the
 * window the plan retains (analyticsDays); a columnar store is a scale step.
 */

const fs = require('node:fs');
const path = require('node:path');

const TYPES = new Set(['view', 'step', 'complete', 'cta', 'leave', 'lead']);
const SESSION_RE = /^[A-Za-z0-9_-]{8,40}$/;
const DAY_MS = 24 * 3600 * 1000;

function clampStr(v, n) {
  return typeof v === 'string' ? v.slice(0, n) : null;
}

/**
 * Validate one beacon event. Returns the normalized record or null (dropped
 * silently: a beacon never gets an error it could act on).
 */
function normalizeEvent(raw, { now }) {
  if (!raw || typeof raw !== 'object') return null;
  if (!TYPES.has(raw.t)) return null;
  if (typeof raw.s !== 'string' || !SESSION_RE.test(raw.s)) return null;
  const ev = { ts: now, t: raw.t, s: raw.s };
  if (Number.isInteger(raw.r) && raw.r > 0) ev.r = raw.r;
  if (raw.t === 'step') {
    if (!Number.isInteger(raw.n) || raw.n < 0 || raw.n > 10000) return null;
    ev.n = raw.n;
    ev.l = clampStr(raw.l, 120) || '';
  }
  if (raw.t === 'leave' && Number.isFinite(raw.d)) ev.d = Math.max(0, Math.min(Math.round(raw.d), 6 * 3600 * 1000));
  const sc = clampStr(raw.sc, 80);
  if (sc) ev.sc = sc;
  const ref = clampStr(raw.ref, 120);
  if (ref && /^[a-z0-9.-]+$/i.test(ref)) ev.ref = ref.toLowerCase();
  return ev;
}

class Analytics {
  constructor({ dataDir, now = () => Date.now() }) {
    this.dir = path.join(dataDir, 'cloud', 'analytics');
    this.now = now;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(projectId) {
    return path.join(this.dir, `${projectId}.jsonl`);
  }

  record(projectId, raw) {
    const ev = normalizeEvent(raw, { now: this.now() });
    if (!ev) return false;
    fs.appendFileSync(this.file(projectId), `${JSON.stringify(ev)}\n`);
    return true;
  }

  events(projectId, sinceMs) {
    let text;
    try { text = fs.readFileSync(this.file(projectId), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.ts >= sinceMs) out.push(ev);
      } catch { /* a torn last line after a crash */ }
    }
    return out;
  }

  /**
   * @param {string} projectId
   * @param {{days: number, retentionDays: number, funnels: boolean}} opts
   */
  summary(projectId, { days = 30, retentionDays = 30, funnels = false } = {}) {
    const window = Math.max(1, Math.min(days, retentionDays));
    const now = this.now();
    const since = now - window * DAY_MS;
    const evs = this.events(projectId, since);

    const viewSessions = new Set();
    const completeSessions = new Set();
    const ctaSessions = new Set();
    const dwell = new Map();
    const refs = new Map();
    const steps = new Map();
    const daily = new Map();
    let views = 0;
    let leads = 0;

    for (let d = window - 1; d >= 0; d -= 1) daily.set(dayKey(now - d * DAY_MS), { views: 0, completions: 0 });

    for (const ev of evs) {
      const dk = dayKey(ev.ts);
      const bucket = daily.get(dk);
      if (ev.t === 'view') {
        views += 1;
        viewSessions.add(ev.s);
        if (bucket) bucket.views += 1;
        if (ev.ref) refs.set(ev.ref, (refs.get(ev.ref) || 0) + 1);
      } else if (ev.t === 'complete') {
        if (!completeSessions.has(ev.s) && bucket) bucket.completions += 1;
        completeSessions.add(ev.s);
      } else if (ev.t === 'cta') {
        ctaSessions.add(ev.s);
      } else if (ev.t === 'lead') {
        leads += 1;
      } else if (ev.t === 'leave' && ev.d != null) {
        dwell.set(ev.s, Math.max(dwell.get(ev.s) || 0, ev.d));
      } else if (ev.t === 'step') {
        const key = `${ev.sc || ''}\u0000${ev.n}`;
        let st = steps.get(key);
        if (!st) { st = { scenario: ev.sc || null, n: ev.n, label: ev.l, sessions: new Set() }; steps.set(key, st); }
        if (ev.l) st.label = ev.l;
        st.sessions.add(ev.s);
      }
    }

    const sessions = viewSessions.size;
    const dwellVals = [...dwell.values()];
    const out = {
      windowDays: window,
      totals: {
        views, sessions,
        completions: completeSessions.size,
        completionRate: sessions ? round(completeSessions.size / sessions) : 0,
        ctaClicks: ctaSessions.size,
        ctaRate: sessions ? round(ctaSessions.size / sessions) : 0,
        leads,
        medianDwellMs: median(dwellVals),
      },
      daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
      referrers: [...refs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([host, count]) => ({ host, count })),
      funnel: null,
    };
    if (funnels) {
      out.funnel = [...steps.values()]
        .sort((a, b) => String(a.scenario || '').localeCompare(String(b.scenario || '')) || a.n - b.n)
        .map((st) => ({
          scenario: st.scenario, n: st.n, label: st.label, sessions: st.sessions.size,
          reach: sessions ? round(st.sessions.size / sessions) : 0,
        }));
    }
    return out;
  }

  remove(projectId) {
    fs.rmSync(this.file(projectId), { force: true });
  }
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}

function median(vals) {
  if (!vals.length) return null;
  const s = vals.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

module.exports = { Analytics, normalizeEvent };
