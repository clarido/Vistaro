import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSaas, tempDir } from './saas-cloud-helpers';

// Unit tests for saas/lib/cloud/analytics.js with an injected clock.

const DAY = 24 * 3600 * 1000;

test('normalizeEvent keeps what the dashboard needs and drops everything else', async () => {
    const { normalizeEvent } = await loadSaas('cloud/analytics.js');
    const now = 1_000;
    assert.deepEqual(normalizeEvent({ t: 'view', s: 'abcdefgh', r: 2, ref: 'News.YC.com', email: 'x@y.z', p: 'prj_1' }, { now }),
        { ts: now, t: 'view', s: 'abcdefgh', r: 2, ref: 'news.yc.com' }, 'no personal field survives');
    assert.equal(normalizeEvent({ t: 'hack', s: 'abcdefgh' }, { now }), null);
    assert.equal(normalizeEvent({ t: 'view', s: 'short' }, { now }), null);
    assert.equal(normalizeEvent({ t: 'view', s: 'a b c d e f' }, { now }), null);
    assert.equal(normalizeEvent({ t: 'step', s: 'abcdefgh' }, { now }), null, 'a step needs its number');
    assert.equal(normalizeEvent({ t: 'view', s: 'abcdefgh', ref: 'evil<script>' }, { now }).ref, undefined);
    assert.equal(normalizeEvent({ t: 'leave', s: 'abcdefgh', d: 1e12 }, { now }).d, 6 * 3600 * 1000, 'dwell is capped');
    assert.equal(normalizeEvent(null, { now }), null);
});

test('summary: sessions, completion, CTA, dwell, referrers and the funnel', async (t) => {
    const { Analytics } = await loadSaas('cloud/analytics.js');
    let now = Date.parse('2026-10-18T12:00:00Z');
    const a = new Analytics({ dataDir: tempDir(t), now: () => now });
    const P = 'prj_x';
    for (const s of ['sess-aaaa', 'sess-bbbb', 'sess-cccc', 'sess-dddd']) {
        a.record(P, { t: 'view', s, ref: 'google.com' });
        a.record(P, { t: 'step', s, n: 0, l: 'Open' });
    }
    a.record(P, { t: 'view', s: 'sess-aaaa' }); // a reload: one more view, same visit
    a.record(P, { t: 'step', s: 'sess-aaaa', n: 1, l: 'Type' });
    a.record(P, { t: 'step', s: 'sess-bbbb', n: 1, l: 'Type' });
    a.record(P, { t: 'complete', s: 'sess-aaaa' });
    a.record(P, { t: 'complete', s: 'sess-aaaa' }); // replay does not double count
    a.record(P, { t: 'cta', s: 'sess-aaaa' });
    a.record(P, { t: 'leave', s: 'sess-aaaa', d: 30000 });
    a.record(P, { t: 'leave', s: 'sess-bbbb', d: 10000 });
    a.record(P, { t: 'leave', s: 'sess-cccc', d: 20000 });

    const s = a.summary(P, { days: 30, retentionDays: 365, funnels: true });
    assert.deepEqual(s.totals, { views: 5, sessions: 4, completions: 1, completionRate: 0.25, ctaClicks: 1, ctaRate: 0.25, leads: 0, medianDwellMs: 20000 });
    assert.deepEqual(s.referrers, [{ host: 'google.com', count: 4 }]);
    assert.deepEqual(s.funnel.map((f: { n: number; label: string; sessions: number; reach: number }) => [f.n, f.label, f.sessions, f.reach]), [[0, 'Open', 4, 1], [1, 'Type', 2, 0.5]]);
    assert.equal(s.daily.length, 30);
    assert.deepEqual(s.daily[29], { day: '2026-10-18', views: 5, completions: 1 });
    assert.equal(a.summary(P, { funnels: false }).funnel, null, 'funnels are withheld when the plan lacks them');

    now += 10 * DAY;
    const free = a.summary(P, { days: 30, retentionDays: 7 });
    assert.equal(free.windowDays, 7, 'the plan retention clamps the window');
    assert.equal(free.totals.views, 0, 'events older than the retained window are not shown');
});

test('tour steps are kept apart per scenario', async (t) => {
    const { Analytics } = await loadSaas('cloud/analytics.js');
    const a = new Analytics({ dataDir: tempDir(t) });
    a.record('p', { t: 'view', s: 'sess-aaaa' });
    a.record('p', { t: 'step', s: 'sess-aaaa', n: 0, l: 'A0', sc: 'alpha' });
    a.record('p', { t: 'step', s: 'sess-aaaa', n: 0, l: 'B0', sc: 'beta' });
    const f = a.summary('p', { funnels: true }).funnel;
    assert.deepEqual(f.map((x: { scenario: string; label: string }) => `${x.scenario}:${x.label}`), ['alpha:A0', 'beta:B0']);
});

test('a torn last line (crash mid-append) does not break the summary', async (t) => {
    const fs = await import('fs');
    const { Analytics } = await loadSaas('cloud/analytics.js');
    const a = new Analytics({ dataDir: tempDir(t) });
    a.record('p', { t: 'view', s: 'sess-aaaa' });
    fs.appendFileSync(a.file('p'), '{"ts":12,"t":"vi');
    assert.equal(a.summary('p').totals.views, 1);
});
