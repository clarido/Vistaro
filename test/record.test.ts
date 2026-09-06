import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { chromium, Browser } from 'playwright';
import { startLiveApp, LiveApp } from './fixtures/live-app/server';
import { parseTimeline } from '../src/engine/schema';
import { runTimeline, ensureRuntime, RunState } from '../src/engine/driver';
import { newDrivenPage } from '../src/browser';
import { bootOptions } from '../src/engine/inject';
import { probeDurationMs } from '../src/media/ffmpeg';
import { GuideJson } from '../src/guide/render';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
/** Async spawn: the live-app server runs in this process, so a sync spawn would block its event loop. */
function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}

/** The full flow: login (form POST + redirect), async list (waitFor), SPA route change, link navigation, typing on page 3. */
const loginFlow = (base: string) => ({
    meta: { title: 'Live app flow', slug: 'live-flow', app: 'Live app', url: `${base}/login`, cursor: 'mac', tailMs: 800 },
    steps: [
        { id: 'user', time: 0.5, action: 'type', target: '[data-help="login-user"]', value: 'ada', title: 'Enter your user name', subtitle: 'Type your user name.' },
        { id: 'pass', time: 1.4, action: 'type', target: '[data-help="login-pass"]', value: 'pw', title: 'Enter your password' },
        { id: 'submit', time: 2.2, action: 'click', target: '[data-help="login-submit"]', title: 'Sign in', subtitle: 'Sign in.' },
        { id: 'items', time: 3.2, action: 'highlight', target: '[data-help="items"] li:first-child', waitFor: '[data-help="items"] li', title: 'Your proposals' },
        { id: 'settings', time: 4.2, action: 'click', target: '[data-help="tab-settings"]', title: 'Open settings' },
        { id: 'panel', time: 5.0, action: 'highlight', target: '[data-help="settings-panel"]', title: 'Notification settings' },
        { id: 'details', time: 5.8, action: 'click', target: '[data-help="go-details"]', title: 'Open the details page' },
        { id: 'note', time: 6.8, action: 'type', target: '[data-help="detail-note"]', value: 'Looks good', waitFor: '[data-help="detail-title"]', title: 'Add a note' },
    ],
});

let app: LiveApp;
let slowApp: LiveApp;
let work: string;
let browser: Browser;

before(async () => {
    if (skip) return;
    app = await startLiveApp({ listDelayMs: 300 });
    slowApp = await startLiveApp({ listDelayMs: 1800 });
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-record-'));
    browser = await chromium.launch({ headless: true });
});
after(async () => {
    if (browser) await browser.close();
    if (app) await app.close();
    if (slowApp) await slowApp.close();
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

function writeDir(name: string, config: unknown): string {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(config, null, 2));
    return dir;
}

test('record: login flow with navigations, waitFor, SPA route and link; every step lands with actualMs', { skip }, async () => {
    const dir = writeDir('flow', loginFlow(app.url));
    const out = path.join(work, 'flow.mp4');
    const r = await cli(['record', dir, '-o', out, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Survived 2 navigations/);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.equal(ev.command, 'record');
    assert.equal(ev.url, `${app.url}/login`);
    assert.equal(ev.navigations, 2);
    assert.equal(ev.steps.length, 8);
    for (const s of ev.steps) {
        assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);
        assert.ok(Number.isFinite(s.actualMs), `step ${s.index} actualMs`);
    }
    // the login click and the details link navigated (execution context destroyed or load observed)
    assert.equal(ev.steps[2].navigated, true, 'login submit navigated');
    assert.equal(ev.steps[6].navigated, true, 'details link navigated');
    // relative spacing of the written timeline holds (no waitFor overrun with a 300ms list)
    for (let i = 1; i < ev.steps.length; i++) {
        const written = loginFlow(app.url).steps[i].time - loginFlow(app.url).steps[i - 1].time;
        const got = (ev.steps[i].actualMs - ev.steps[i - 1].actualMs) / 1000;
        assert.ok(Math.abs(got - written) < 0.25, `spacing ${i}: ${got}s vs ${written}s`);
    }
    assert.ok(Math.abs(probeDurationMs(out) - ev.duration * 1000) <= 750);
    assert.ok(app.hits.includes('POST /login') && app.hits.includes('GET /details/1'), app.hits.join(','));
    assert.ok(fs.existsSync(path.join(work, 'flow.vtt')));
});

test('record: waitFor absorbs an async delay and later steps keep their relative spacing', { skip }, async () => {
    const dir = writeDir('slow', loginFlow(slowApp.url));
    const out = path.join(work, 'slow.mp4');
    const r = await cli(['record', dir, '-o', out, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /waitFor delays shifted the timeline by \d+ms/);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    const items = ev.steps[3], settings = ev.steps[4], submit = ev.steps[2];
    assert.equal(items.error, undefined, items.error);
    // the list appears ~1.8s after the dashboard loaded (~2.3s), i.e. after the written 3.2s
    assert.ok(items.actualMs > 3600, `items step waited for the list: ${items.actualMs}ms`);
    assert.ok(items.actualMs - submit.actualMs > 1500);
    assert.ok(Math.abs((settings.actualMs - items.actualMs) - 1000) < 250, `spacing after the shift: ${settings.actualMs - items.actualMs}ms`);
    assert.ok(ev.shiftMs > 300, `shift recorded: ${ev.shiftMs}`);
    assert.ok(probeDurationMs(out) > 7600 + 300, 'recording extended by the shift');
});

test('record: with --storage-state the login is skipped and the dashboard flow records', { skip }, async () => {
    const state = path.join(work, 'auth.json');
    const host = new URL(app.url).hostname;
    fs.writeFileSync(state, JSON.stringify({ cookies: [{ name: 'session', value: '1', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
    const flow = loginFlow(app.url);
    const dir = writeDir('authed', { meta: { ...flow.meta, url: `${app.url}/dashboard` }, steps: flow.steps.slice(3).map(s => ({ ...s, time: s.time - 2.7 })) });
    const out = path.join(work, 'authed.mp4');
    const hitsBefore = app.hits.length;
    const r = await cli(['record', dir, '-o', out, '--storage-state', state, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.equal(ev.steps.length, 5);
    for (const s of ev.steps) assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);
    assert.equal(ev.storageState, '../auth.json');
    // the reachability probe has no cookie and gets the 302 (not followed); the browser itself never lands on /login
    assert.ok(!app.hits.slice(hitsBefore).includes('GET /login'), `no redirect to the login page: ${app.hits.slice(hitsBefore).join(', ')}`);
    assert.ok(fs.existsSync(out));
});

test('record --guide: badges on the post-navigation pages, video linked, actual times from the recording', { skip }, async () => {
    const dir = writeDir('guided', loginFlow(app.url));
    const out = path.join(work, 'guided.mp4');
    const r = await cli(['record', dir, '-o', out, '--guide', '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const g: GuideJson = JSON.parse(fs.readFileSync(path.join(dir, 'guide', 'guide.json'), 'utf8'));
    assert.equal(g.steps.length, 8);
    assert.ok(g.video && g.video.file === '../../guided.mp4', g.video?.file);
    for (const s of g.steps) {
        assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);
        assert.ok(s.image && fs.existsSync(path.join(dir, 'guide', s.image)));
    }
    const items = g.steps.find(s => s.id === 'items')!;     // /dashboard after the login navigation
    const note = g.steps.find(s => s.id === 'note')!;       // /details/1 after the link navigation
    assert.ok(items.callout && items.rect && items.rect.width > 100, JSON.stringify(items));
    assert.ok(note.callout && note.rect && note.rect.width > 100, JSON.stringify(note));
    assert.ok(Math.abs(items.actualMs - 3200) < 300, `actualMs from the recording: ${items.actualMs}`);
    assert.ok(g.video!.chapters.length >= 6);
});

test('runTimeline(live): cursor re-appears at its last point after a navigation; no step lost to a destroyed context', { skip }, async () => {
    const tl = parseTimeline(loginFlow(app.url));
    const driven = await newDrivenPage(browser, { width: 1280, height: 800, runtime: true });
    try {
        await driven.page.goto(`${app.url}/login`, { waitUntil: 'load' });
        await ensureRuntime(driven.page, tl, { drift: false });
        const state: RunState = { t0Wall: 0, shiftMs: 0, lastPoint: null, navigations: 0 };
        const pointsBefore: Record<string, { x: number; y: number } | null> = {};
        const results = await runTimeline(driven.page, tl, {
            mode: 'step', settleMs: 50, live: { boot: bootOptions(tl, { drift: false }, false) }, state,
            beforeStep: async (s) => { pointsBefore[s.id] = await driven.page.evaluate(() => (window as any).__anim.getState().point); },
        });
        for (const r of results) assert.equal(r.error, undefined, `step ${r.index}: ${r.error}`);
        assert.equal(state.navigations, 2);
        assert.equal(results[2].navigated, true);
        assert.ok(Number.isFinite(results[2].actualMs));
        // after the login navigation, the new document's cursor starts exactly where the submit click left it
        assert.deepEqual(pointsBefore['items'], results[2].point, 'cursor restored after the form navigation');
        assert.deepEqual(pointsBefore['note'], results[6].point, 'cursor restored after the link navigation');
        assert.equal(await driven.page.inputValue('[data-help="detail-note"]'), 'Looks good');
        assert.equal(driven.page.url(), `${app.url}/details/1`);
    } finally {
        await driven.close();
    }
});

test('record fails fast on an unreachable URL and on a missing storage state', { skip }, async () => {
    const dir = writeDir('unreachable', { ...loginFlow('http://127.0.0.1:1'), meta: { url: 'http://127.0.0.1:1/login', cursor: 'mac' } });
    const started = Date.now();
    const r = await cli(['record', dir, '-o', path.join(work, 'x.mp4')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /URL unreachable/);
    assert.ok(Date.now() - started < 15000, 'fails before recording');
    const m = await cli(['record', dir, '--url', `${app.url}/login`, '--storage-state', path.join(work, 'nope.json'), '-o', path.join(work, 'x.mp4')]);
    assert.equal(m.status, 1);
    assert.match(m.stderr, /storage state file not found/);
    const n = await cli(['record', writeDir('nourl', { steps: [] }), '-o', path.join(work, 'x.mp4')]);
    assert.equal(n.status, 1);
    assert.match(n.stderr, /no URL/);
});
