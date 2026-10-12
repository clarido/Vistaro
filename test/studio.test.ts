import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { assertRan, CLI_TIMEOUT_MS, CliSpawnResult } from './assert-ran';
import { scanProjects } from '../src/commands/studio';
import { chromium } from 'playwright';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'test', 'fixtures', 'basic');
/**
 * Bound per CALL like every spawn in this suite (see record.test.ts): a wedged studio server must
 * be reported here by name, not hang the runner. Generous: it boots tsx + a server.
 */
const SPAWN_TIMEOUT_MS = 30000;
/** The export test re-encodes a video; browser.test.ts pays the same class of cost per export. */
const EXPORT_WAIT_MS = 180000;

interface Server { child: ChildProcess; port: number; url: string; result: Promise<CliSpawnResult>; teardown: boolean; exitedBeforeTeardown: boolean }

/** The three bounds on the suite's CLI children (spawn-bounds.test.ts): the timeout + killSignal
 *  ride the spawn's options window, and assertRan reads the close result in after(). */
function startStudio(dir: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts', 'studio', dir], { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
        const server: Server = { child, port: 0, url: '', teardown: false, exitedBeforeTeardown: false, result: new Promise<CliSpawnResult>((resolveResult) => {
            child.on('close', (status, signal) => {
                if (!server.teardown) server.exitedBeforeTeardown = true;
                resolveResult({ status, signal, stdout: '', stderr: '' });
            });
            child.on('error', (error) => resolveResult({ status: null, signal: null, stdout: '', stderr: '', error }));
        }) };
        let boot = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('studio server did not boot in time')); }, SPAWN_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => {
            boot += d.toString('utf8');
            const m = /studio listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(boot);
            if (m) {
                clearTimeout(timer);
                server.port = Number(m[1]); server.url = `http://127.0.0.1:${m[1]}`;
                resolve(server);
            }
        });
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`studio server exited early (${code})`)); });
    });
}

async function stopServer(server: Server | undefined, args: string[]): Promise<void> {
    if (!server) return;
    // Deliberate teardown kills the server by design; assertRan guards only a child that died
    // on its own before we tore it down (a crash or an overrun of CLI_TIMEOUT_MS).
    server.teardown = true;
    try { server.child.kill('SIGKILL'); } catch { /* already gone */ }
    const result = await server.result;
    if (server.exitedBeforeTeardown) assertRan(result, args);
}

let work: string;
let server: Server;
/** The editor URL for the server's default (boot-argument) project -- `/` alone is the picker now. */
async function editorUrl(): Promise<string> {
    const list = await (await fetch(server.url + '/api/projects')).json();
    return server.url + '/?project=' + encodeURIComponent(list.defaultId);
}

before(async () => {
    // The server boots even under SKIP_BROWSER: the API-only tests below have no browser of
    // their own, and the server itself spawns none unless check/export are called.
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-studio-'));
    fs.cpSync(fixture, path.join(work, 'demo'), { recursive: true });
    // A strings file with a key on the step this suite renames: the save must move the key.
    fs.writeFileSync(path.join(work, 'demo', 'strings.en.json'),
        JSON.stringify({ 'meta.title': 'Basic fixture', 'steps.intro.title': 'Overview' }, null, 2) + '\n');
    server = await startStudio(path.join(work, 'demo'));
});

after(async () => {
    await stopServer(server, ['studio', path.join(work ?? '.', 'demo')]);
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('studio API: PUT round-trips unknown fields and moves strings keys on an id rename; invalid input is refused with issues', { skip }, async () => {
    const got = await (await fetch(server.url + '/api/timeline')).json();
    assert.equal(got.exists, true);
    assert.equal(got.raw.steps.length, 9);

    // The schema is open: a field nothing knows about must survive the studio round-trip.
    const raw = got.raw;
    raw.steps[0].__custom = 'keep-me';
    const oldId = raw.steps[0].id;
    raw.steps[0].id = 'intro-renamed';
    const put = await fetch(server.url + '/api/timeline', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, renames: [{ from: oldId, to: 'intro-renamed' }] }),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));
    const onDisk = JSON.parse(fs.readFileSync(path.join(work, 'demo', 'anim.config.json'), 'utf8'));
    assert.equal(onDisk.steps[0].__custom, 'keep-me', 'unknown field round-trips');
    assert.equal(onDisk.steps[0].id, 'intro-renamed');
    const strings = JSON.parse(fs.readFileSync(path.join(work, 'demo', 'strings.en.json'), 'utf8'));
    assert.equal(strings['steps.intro-renamed.title'], 'Overview', 'the key followed the rename');
    assert.equal(strings['steps.intro.title'], undefined, 'the old key is gone');

    // Invalid timelines are refused with the issue list, and the file is untouched.
    const before = fs.readFileSync(path.join(work, 'demo', 'anim.config.json'), 'utf8');
    const bad = JSON.parse(JSON.stringify(onDisk));
    bad.steps[1].action = 'teleport';
    const refused = await fetch(server.url + '/api/timeline', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: bad }),
    });
    assert.equal(refused.status, 422);
    const body = await refused.json();
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0, 'issues come back');
    assert.equal(fs.readFileSync(path.join(work, 'demo', 'anim.config.json'), 'utf8'), before, 'refused save wrote nothing');
});

test('studio preview: the full stack boots (runtime + tour bridge + studio bridge), reload swaps steps live, pick returns a selector', { skip }, async () => {
    const html = await (await fetch(server.url + '/preview')).text();
    assert.ok(html.includes('<!-- anim-cli-runtime:end -->'), 'tour block injected');
    assert.ok(html.includes('window.__studio'), 'studio bridge injected after it');

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        // Messages the bridges post to `parent` land on `window` in a top-level page (parent ===
        // window), so a plain init listener can observe them. String predicates only: page.evaluate
        // callbacks must stay straight-line (the __name rule).
        await page.addInitScript(
            'window.__seen = [];' +
            'window.addEventListener("message", function (e) { if (e.data && e.data.source) window.__seen.push(e.data); });'
        );
        await page.goto(server.url + '/preview', { waitUntil: 'networkidle' });
        const booted = await page.evaluate('({ anim: !!window.__anim, tour: !!window.__tour, studio: !!window.__studio, total: window.__tour ? window.__tour.state().total : -1 })') as { anim: boolean; tour: boolean; studio: boolean; total: number };
        assert.ok(booted.anim && booted.tour && booted.studio, 'runtime, tour bridge and studio bridge boot');
        assert.equal(booted.total, 9, 'the timeline is loaded (9 steps)');

        // reload: swap to a two-step timeline in place; the scheduler must adopt it.
        await page.evaluate('window.postMessage({ source: "anim-studio", type: "reload", steps: [' +
            '{ id: "a", time: "0s", action: "fadeIn", target: "body" },' +
            '{ id: "b", time: "1s", action: "click", target: "#btn" }], meta: {} }, location.origin)');
        await page.waitForFunction('window.__tour.state().total === 2', null, { timeout: 8000 });
        const readyAgain = await page.evaluate('window.__seen.filter(function (m) { return m.source === "anim-tour" && m.type === "ready"; }).length') as number;
        assert.ok(readyAgain >= 2, 'boot posted a fresh ready after the reload');

        // pick: enable, click the button in the page, expect the picked selector back.
        await page.evaluate('window.postMessage({ source: "anim-studio", type: "pick", enable: true }, location.origin)');
        await page.waitForFunction('document.documentElement.style.cursor === "crosshair"', null, { timeout: 8000 });
        await page.locator('#btn').click();
        await page.waitForFunction('window.__seen.some(function (m) { return m.source === "anim-studio" && m.type === "picked"; })', null, { timeout: 8000 });
        const picked = await page.evaluate('window.__seen.filter(function (m) { return m.type === "picked"; })[0]') as { selector: string };
        assert.match(picked.selector, /#btn/);
    } finally {
        await browser.close();
    }
});

test('studio editor page: boots the step list, inspector and palette with no console errors', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        assert.equal(await page.locator('#steps .step').count(), 9, 'one row per step');
        await page.locator('#steps .step').nth(1).click();
        await page.waitForTimeout(400);
        // Minimal + disclosure: the compact set (identity + action + set fields) plus the toggle.
        const compact = await page.locator('#fields .field').count();
        assert.ok(compact >= 5 && compact <= 10, 'compact inspector renders a small field set, got ' + compact);
        const disclosure = page.locator('#fields .disclosure');
        assert.ok((await disclosure.count()) === 1, 'the all-fields disclosure is offered');
        await disclosure.click();
        await page.waitForTimeout(200);
        assert.ok((await page.locator('#fields .field').count()) > compact + 4, 'the disclosure reveals the full registry');
        const unlabeled = await page.evaluate("Array.from(document.querySelectorAll('#fields input:not([type=checkbox]), #fields select, #fields textarea')).filter(function (el) { return !document.querySelector('label[for=' + el.id + ']'); }).length") as number;
        assert.equal(unlabeled, 0, 'every inspector control has a label[for]');
        await page.locator('.tab[data-tab=\'palette\']').click();
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#palette').isVisible(), true, 'palette tab shows');
        assert.ok((await page.locator('.pal-item').count()) >= 10, 'presets render');
        assert.equal(await page.locator('#t-pos').textContent(), '2 / 9 \u00b7 1', 'transport synced after selection seek, with the authored time');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio editor page: the header links back to the project picker', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        const back = page.locator('#top a.back');
        assert.equal(await back.count(), 1, 'the editor header carries one back link');
        assert.equal(await back.getAttribute('href'), '/', 'it targets the picker route, dropping the project id');
        await back.click();
        await page.waitForURL(server.url + '/');
        assert.equal(await page.locator('#picker-main').isVisible(), true, 'clicking it lands on the picker page');
    } finally {
        await browser.close();
    }
});

test('studio quick-open: ⌘K switches projects from the keyboard, and the tab title names the project', { skip }, async () => {
    // A second project with a distinct title, so the palette has somewhere to go. It lives
    // beside the boot dir (outside the workspace), so it joins the index the way any outside
    // folder does: through the open endpoint.
    fs.cpSync(fixture, path.join(work, 'demo2'), { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(work, 'demo2', 'anim.config.json'), 'utf8'));
    cfg.meta.title = 'Second fixture';
    fs.writeFileSync(path.join(work, 'demo2', 'anim.config.json'), JSON.stringify(cfg, null, 2) + '\n');
    const opened = await (await fetch(server.url + '/api/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'demo2') }),
    })).json();
    assert.match(String(opened.id), /^[0-9a-f]{10}$/, 'the second project registered');
    const list = await (await fetch(server.url + '/api/projects')).json();
    const target = list.projects.find((p: { id: string }) => p.id === opened.id);
    assert.ok(target, 'the second project is listed');

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        assert.match(await page.title(), /Basic fixture/, 'the tab title names the open project');

        const palette = page.locator('#quickopen');
        // Control works everywhere (mac Chromium included): the chord listens for meta OR ctrl.
        await page.keyboard.press('Control+k');
        assert.equal(await palette.isVisible(), true, '⌘K opens the quick-open palette');
        await page.waitForSelector('.qo-item', { state: 'visible' });
        await page.keyboard.press('Escape');
        assert.equal(await palette.isVisible(), false, 'Esc closes it');
        await page.click('#qo-open');
        assert.equal(await palette.isVisible(), true, 'the header button opens it too');
        await page.waitForSelector('.qo-item', { state: 'visible' });
        await page.fill('#qo-input', 'Second');
        await page.waitForFunction("document.querySelectorAll('#qo-list .qo-item').length === 1");
        await page.keyboard.press('Enter');
        await page.waitForURL((url: URL) => url.searchParams.get('project') === target.id);
        await page.waitForFunction("document.getElementById('dir') && document.getElementById('dir').textContent.indexOf('demo2') !== -1");
        assert.match(await page.title(), /Second fixture/, 'the title follows the switch');
    } finally {
        await browser.close();
    }
});

test('studio check endpoint returns the Issue array from a real browser pass', { skip }, async () => {
    const res = await fetch(server.url + '/api/check', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.issues), 'issues is an array');
    for (const issue of body.issues) {
        assert.ok(typeof issue.level === 'string' && typeof issue.message === 'string');
    }
});

test('studio export endpoint encodes the video and lists the artifacts', { skip, timeout: EXPORT_WAIT_MS }, async () => {
    const res = await fetch(server.url + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exitCode, 0, String(body.log || '').slice(-1500));
    assert.ok(body.artifacts.includes('studio.mp4'), 'the video is listed');
    assert.ok(fs.existsSync(path.join(work, 'demo', 'studio.mp4')), 'the video is on disk');
});

test('studio direct manipulation: a drag on the selected element authors the animate step, Alt-drag nudges the cursor', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);

        // Step 2 becomes an animate step via the Raw tab (the honest escape hatch).
        await page.locator("#steps .step").nth(1).click();
        await page.waitForTimeout(400);
        await page.locator(".tab[data-tab='raw']").click();
        const raw = JSON.parse(await page.locator('#raw-text').inputValue());
        raw.action = 'animate';
        raw.from = { opacity: 1 };
        raw.to = { opacity: 1 };
        await page.locator('#raw-text').fill(JSON.stringify(raw, null, 2));
        await page.locator('#raw-apply').click();
        await page.waitForTimeout(700);

        // Click-select #btn in the preview, then drag the selection frame.
        await page.frameLocator('#preview').locator('#btn').click();
        await page.waitForTimeout(400);
        const frameBox = await page.frameLocator('#preview').locator('[data-studio-frame] > div:first-child').boundingBox();
        assert.ok(frameBox, 'the selection frame is up over the element');
        const cx = frameBox!.x + frameBox!.width / 2;
        const cy = frameBox!.y + frameBox!.height / 2;
        // Derive the authored expectation from the preview iframe's actual transform scale, so
        // neither an editor CSS change nor a note-text change breaks the expectation silently.
        const transform = await page.evaluate("document.getElementById('preview').style.transform || 'scale(1)'") as string;
        const fit = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1) || 1;
        const dragX = 73, dragY = 37; // parent-page px; the iframe reports them in its own coords
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dragX, cy + dragY, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        await page.locator(".tab[data-tab='raw']").click();
        const step2 = JSON.parse(await page.locator('#raw-text').inputValue());
        assert.equal(step2.action, 'animate');
        assert.equal(step2.to.opacity, 1, 'the drag merges into to, never clobbers sibling keys');
        const expectX = Math.round(dragX / fit), expectY = Math.round(dragY / fit);
        assert.ok(Math.abs(step2.to.x - expectX) <= 4 && Math.abs(step2.to.y - expectY) <= 4,
            `to.x/to.y carry the authored delta (want ~${expectX}/${expectY}, got ${step2.to.x}/${step2.to.y})`);
        assert.ok(await page.locator('#dirty').isVisible(), 'the drag marked the timeline dirty');

        // Alt-drag the cursor glyph (seek to a click step parks it on its target).
        await page.locator("#steps .step").nth(2).click();
        await page.waitForTimeout(900);
        const cursorBox = await page.frameLocator('#preview').locator('#anim-cli-cursor').boundingBox();
        assert.ok(cursorBox, 'the cursor glyph is on screen after the seek');
        await page.mouse.move(cursorBox!.x + 4, cursorBox!.y + 4);
        await page.keyboard.down('Alt');
        await page.mouse.down();
        await page.mouse.move(cursorBox!.x + 40, cursorBox!.y - 22, { steps: 5 });
        await page.mouse.up();
        await page.keyboard.up('Alt');
        await page.waitForTimeout(500);
        await page.locator(".tab[data-tab='raw']").click();
        const step3 = JSON.parse(await page.locator('#raw-text').inputValue());
        assert.ok(typeof step3.xOffset === 'number' && step3.xOffset > 10, `xOffset written (got ${step3.xOffset})`);
        assert.ok(typeof step3.yOffset === 'number' && step3.yOffset < -5, `yOffset written (got ${step3.yOffset})`);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio mockup API: style patches land byte-clean, stale mtime and structure drift refuse', { skip }, async () => {
    const t = await (await fetch(server.url + '/api/timeline')).json();
    const patch = async (body: unknown) => ({
        status: (await fetch(server.url + '/api/mockup', {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })).status,
    });
    // A flow element can be patched at the API level (the BRIDGE refuses flow elements in the UI;
    // the server's contract is the guarded file write). Prove the guard rails, not taste.
    const ok = await patch({ patches: [{ tag: 'button', index: 0, domCount: countTags('button'), patch: { left: '120px', width: '200px' } }], mtime: t.mockupMtimeMs });
    assert.equal(ok.status, 200);
    const html = fs.readFileSync(path.join(work, 'demo', 'index.html'), 'utf8');
    const btn = /<button[^>]*>/.exec(html)![0];
    assert.match(btn, /style="left: 120px; width: 200px;"/);
    assert.match(btn, /id="btn"/, 'other attributes survive byte-identical');

    const stale = await patch({ patches: [{ tag: 'button', index: 0, domCount: 1, patch: { left: '1px' } }], mtime: 12345 });
    assert.equal(stale.status, 409);

    const drift = await patch({ patches: [{ tag: 'div', index: 0, domCount: 999, patch: { left: '1px' } }], mtime: freshMockupMtime() });
    assert.equal(drift.status, 422);

    // Repatching the same element merges (left updates, width survives).
    const again = await patch({ patches: [{ tag: 'button', index: 0, domCount: countTags('button'), patch: { left: '140px' } }], mtime: freshMockupMtime() });
    assert.equal(again.status, 200);
    const btn2 = /<button[^>]*>/.exec(fs.readFileSync(path.join(work, 'demo', 'index.html'), 'utf8'))![0];
    assert.match(btn2, /left: 140px/);
    assert.match(btn2, /width: 200px/);

    function countTags(tag: string): number {
        const h = fs.readFileSync(path.join(work, 'demo', 'index.html'), 'utf8');
        return (h.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) ?? []).length;
    }
    function freshMockupMtime(): number {
        return fs.statSync(path.join(work, 'demo', 'index.html')).mtimeMs;
    }
});

test('studio device support: the mapping reflects drop and overrides, the preview resolves per device', async () => {
    // Craft a timeline with one mobile-only step and one mobile override. Snapshot BEFORE the
    // mutation (got.raw is a reference, and the restore PUTs the snapshot, not the live object).
    const got = await (await fetch(server.url + '/api/timeline')).json();
    const restore = JSON.parse(JSON.stringify(got.raw));
    const restoreMtime = async () => (await (await fetch(server.url + '/api/timeline')).json()).mtimeMs;
    const raw = got.raw;
    raw.steps[2].only = 'mobile';               // step 3 leaves the desktop build
    raw.steps[3].mobile = { time: '9.9s' };     // step 4 carries a mobile override
    try {
    const put = await fetch(server.url + '/api/timeline', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw, mtime: got.mtimeMs }),
    });
    const putBody = await put.json();
    assert.equal(put.status, 200, JSON.stringify(putBody));

    const after = await (await fetch(server.url + '/api/timeline')).json();
    assert.deepEqual(after.devices.desktop.positions, [1, 2, 4, 5, 6, 7, 8, 9], 'desktop drops the mobile-only step');
    assert.deepEqual(after.devices.mobile.positions, [1, 2, 3, 4, 5, 6, 7, 8, 9], 'mobile keeps every step');

    const desktop = await (await fetch(server.url + '/preview?device=desktop')).text();
    const mobile = await (await fetch(server.url + '/preview?device=mobile')).text();
    const stepIds = (html: string) => [...html.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(!stepIds(desktop).includes('name'), 'the mobile-only step is not in the desktop preview');
    assert.ok(stepIds(mobile).includes('name'), 'it is in the mobile preview');
    assert.match(mobile, /"timeMs":9900/, 'the mobile override merged (time 9.9s)');
    } finally {
        // Runs even on failure: a leaked `only` step would poison every later test.
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: restore, mtime: await restoreMtime() }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio API: the timeline GET carries a computed ruler block (durations, subtitles, per-device resolution)', async () => {
    // The numbers are derived from the fixture by the same schema helpers export runs, so they
    // are exact: tailMs 1000, caret's typing 4 chars / 50cps = 80ms, camera 0.3s, fades 0.8s.
    const got = await (await fetch(server.url + '/api/timeline')).json();
    assert.ok(got.computed, 'the computed block is present');
    const desktop = got.computed.desktop;
    assert.equal(desktop.durationMs, 6300, 'duration = last interaction + intrinsic + tail');
    assert.equal(desktop.steps.length, 9);
    assert.equal(desktop.steps[2].timeMs, 2000, 'name types at 2s');
    assert.equal(desktop.steps[2].intrinsicMs, 60, '3 chars at 50cps = 60ms of typing');
    assert.equal(desktop.steps[3].intrinsicMs, 300, 'the camera pan lasts its authored 0.3s');
    assert.equal(desktop.steps[6].intrinsicMs, 800, 'fadeIn keeps the default 0.8s');
    assert.equal(desktop.steps[8].timeMs, 5000);
    assert.ok(desktop.steps.every((s: { dropped?: boolean }) => !s.dropped), 'nothing is dropped without only:');
    assert.deepEqual(desktop.subtitles, [
        { index: 1, startMs: 0, endMs: 1000 },
        { index: 2, startMs: 1000, endMs: 5000 },
    ], 'cue 1 until cue 2; cue 2 holds its 4s maximum');
    assert.equal(got.computed.mobile.durationMs, 6300, 'the fixture has no device variation, both resolve alike');

    // Device variation: an only: step is flagged dropped (authored time kept), an override moves
    // its device's resolved time and stretches that device's duration.
    const restore = JSON.parse(JSON.stringify(got.raw));
    const restoreMtime = async () => (await (await fetch(server.url + '/api/timeline')).json()).mtimeMs;
    const raw = got.raw;
    raw.steps[2].only = 'mobile';
    raw.steps[3].mobile = { time: '9.9s' };
    try {
        const put = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw, mtime: got.mtimeMs }),
        });
        assert.equal(put.status, 200, JSON.stringify(await put.json()));
        const after = await (await fetch(server.url + '/api/timeline')).json();
        const d = after.computed.desktop;
        assert.equal(d.steps[2].dropped, true, 'the mobile-only step is flagged on desktop');
        assert.equal(d.steps[2].timeMs, 2000, 'a dropped step keeps its authored time (dimmed marker)');
        assert.equal(d.steps[2].intrinsicMs, 0, 'a dropped step draws no duration bar');
        assert.equal(d.steps[3].timeMs, 2500, 'the override does not touch desktop');
        assert.equal(d.durationMs, 6300);
        const m = after.computed.mobile;
        assert.ok(!m.steps[2].dropped, 'mobile keeps the only: step');
        assert.equal(m.steps[3].timeMs, 9900, 'the override is the resolved time on mobile');
        assert.equal(m.durationMs, 11200, "9.9s + 300ms camera beats screen2's 5.3s, + 1s tail");
    } finally {
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: restore, mtime: await restoreMtime() }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: markers, duration bars, subtitle windows and ticks render from the computed block; a marker click selects and seeks', { skip }, async () => {
    const browser = await chromium.launch();
    // Left positions as percents of the 6300ms total, read off the inline styles.
    const pct = (page: import('playwright').Page, sel: string, which: 'left' | 'width' = 'left') =>
        page.locator(sel).evaluate((el, w) => parseFloat((el as HTMLElement).style[w] || 'nan'), which);
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });
        assert.equal(await page.locator('#ruler .tl-marker').count(), 9, 'one marker per authored step');
        assert.equal(await page.locator('#ruler .tl-marker.is-dropped').count(), 0, 'nothing is dropped in the base fixture');

        const nameLeft = await pct(page, '#ruler .tl-marker[data-i="2"]');
        assert.ok(Math.abs(nameLeft - (2000 / 6300) * 100) < 0.5, 'the name marker sits at its resolved time, got ' + nameLeft);
        assert.equal(await page.locator('#ruler .tl-bar').count(), 6, 'typing + two cameras + two fades + transitionScreen draw bars');
        const zoomLeft = await pct(page, '#ruler .tl-bar[data-i="3"]');
        const zoomWidth = await pct(page, '#ruler .tl-bar[data-i="3"]', 'width');
        assert.ok(Math.abs(zoomLeft - (2500 / 6300) * 100) < 0.5, 'a camera bar starts at its step time');
        assert.ok(Math.abs(zoomWidth - (300 / 6300) * 100) < 0.5, 'and spans its authored 0.3s');

        assert.equal(await page.locator('#ruler-subs .tl-sub').count(), 2, 'two subtitle cues');
        const subLeft = await pct(page, '#ruler-subs .tl-sub >> nth=1');
        const subWidth = await pct(page, '#ruler-subs .tl-sub >> nth=1', 'width');
        assert.ok(Math.abs(subLeft - (1000 / 6300) * 100) < 0.5, 'cue 2 starts when cue 1 ends');
        assert.ok(Math.abs(subWidth - (4000 / 6300) * 100) < 0.5, 'cue 2 holds its 4s maximum');
        assert.ok(await page.locator('.ruler-ticks .tl-tick').count() >= 8, 'time ticks render');

        const label = await page.locator('#ruler .tl-marker[data-i="2"]').getAttribute('aria-label');
        assert.match(label ?? '', /^step 3 \u00b7 2s \u00b7 type/, 'a screen reader can name the marker');

        await page.locator('#ruler .tl-marker[data-i="3"]').click();
        await page.waitForFunction("document.getElementById('t-pos').textContent.indexOf('4 / 9') !== -1", null, { timeout: 8000 });
        const markerClass = String(await page.locator('#ruler .tl-marker[data-i="3"]').getAttribute('class'));
        assert.ok(markerClass.includes('is-selected'), 'the clicked marker shows its selection');
        assert.ok(await page.locator('#steps .step').nth(3).evaluate((el) => el.classList.contains('is-selected')), 'the step list follows the marker click');
        const phLeft = await pct(page, '#tl-playhead');
        assert.ok(Math.abs(phLeft - (2500 / 6300) * 100) < 0.5, 'the playhead anchors at the seeked step, got ' + phLeft);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio ruler: dropped steps are dimmed and inert, an empty-track click seeks the step at or before, playback advances the playhead', { skip }, async () => {
    const got = await (await fetch(server.url + '/api/timeline')).json();
    const restore = JSON.parse(JSON.stringify(got.raw));
    const restoreMtime = async () => (await (await fetch(server.url + '/api/timeline')).json()).mtimeMs;
    got.raw.steps[2].only = 'mobile';
    const put = await fetch(server.url + '/api/timeline', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: got.raw, mtime: got.mtimeMs }),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));
    const pct = (page: import('playwright').Page, sel: string) =>
        page.locator(sel).evaluate((el) => parseFloat((el as HTMLElement).style.left || 'nan'));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });

        const dropped = page.locator('#ruler .tl-marker[data-i="2"]');
        assert.ok(String(await dropped.getAttribute('class')).includes('is-dropped'), 'the mobile-only step renders dimmed on desktop');
        assert.equal(await dropped.isDisabled(), true, 'a dropped marker is inert');
        await dropped.click({ force: true });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#t-pos').textContent(), '\u2013 / 8', 'clicking a dropped marker seeks nowhere');

        await page.locator('#ruler .tl-marker[data-i="1"]').click();
        await page.waitForFunction("document.getElementById('t-pos').textContent.indexOf('2 / 8') !== -1", null, { timeout: 8000 });
        const phOpen = await pct(page, '#tl-playhead');
        assert.ok(Math.abs(phOpen - (1000 / 6300) * 100) < 0.5, 'the playhead anchors at the open step, got ' + phOpen);

        // An empty-track click at 75% = 4725ms: the last step at or before it is screen2 (4.5s).
        const track = await page.locator('#ruler-track').boundingBox();
        assert.ok(track, 'the track lane is measurable');
        await page.mouse.click(track!.x + track!.width * 0.75, track!.y + track!.height / 2);
        await page.waitForFunction("document.getElementById('t-pos').textContent.indexOf('7 / 8') !== -1", null, { timeout: 8000 });
        assert.ok(await page.locator('#steps .step').nth(7).evaluate((el) => el.classList.contains('is-selected')), 'the step list landed on screen2');
        const phTrack = await pct(page, '#tl-playhead');
        assert.ok(Math.abs(phTrack - (4500 / 6300) * 100) < 0.5, 'the playhead followed the track seek, got ' + phTrack);

        // Playback: the playhead advances past the anchor; pause stops it where it is. The
        // bridge's natural end (1s tail) may land before the second click — both stop playback,
        // and the transport flipping back to "play" is what says so, before the frozen value.
        await page.locator('#t-play').click();
        await page.waitForTimeout(1300);
        const moved = await pct(page, '#tl-playhead');
        assert.ok(moved > (4500 / 6300) * 100, 'the playhead advances during playback, got ' + moved);
        await page.locator('#t-play').click(); // pause
        await page.waitForFunction("document.getElementById('t-play').textContent.indexOf('play') !== -1", null, { timeout: 8000 });
        await page.waitForTimeout(120);
        const frozen = await pct(page, '#tl-playhead');
        await page.waitForTimeout(250);
        assert.ok(Math.abs((await pct(page, '#tl-playhead')) - frozen) < 0.01, 'pause freezes the playhead');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: restore, mtime: await restoreMtime() }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: the subtitle lane collapses when no step carries a subtitle', { skip }, async () => {
    fs.cpSync(fixture, path.join(work, 'nosub'), { recursive: true });
    const cfgPath = path.join(work, 'nosub', 'anim.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.steps.forEach((s: { subtitle?: string }) => { delete s.subtitle; });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    const opened = await (await fetch(server.url + '/api/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'nosub') }),
    })).json();
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        await page.goto(server.url + '/?project=' + encodeURIComponent(opened.id), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });
        assert.equal(await page.locator('#ruler .tl-marker').count(), 9, 'markers render as usual');
        assert.equal(await page.locator('#ruler-subs').isHidden(), true, 'the subtitle lane collapses (a reel has no cues)');
        assert.equal(await page.locator('#ruler-subs .tl-sub').count(), 0);
    } finally {
        await browser.close();
    }
});

/** The studio's own time format for expectations: 2700 -> '2.7s', 3000 -> '3s'. */
function fmtTime(ms: number): string {
    return (ms % 1000 === 0 ? String(ms / 1000) : String(Number((ms / 1000).toFixed(2)))) + 's';
}

test('studio ruler: dragging a marker retimes the step in memory (snapped), nothing on disk until ⌘S', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });
        const track = await page.locator('#ruler-track').boundingBox();
        const perMs = track!.width / 6300;
        const m = await page.locator('#ruler .tl-marker[data-i="3"]').boundingBox();
        const dragPx = 30;
        // The same math the drag runs: pointer time, snapped to 100ms, clamped to the neighbours.
        const expectMs = Math.min(3000, Math.max(2500, Math.round((2500 + dragPx / perMs) / 100) * 100));
        await page.mouse.move(m!.x + m!.width / 2, m!.y + m!.height / 2);
        await page.mouse.down();
        await page.mouse.move(m!.x + m!.width / 2 + dragPx, m!.y + m!.height / 2, { steps: 5 });
        assert.equal(await page.locator('#tl-ghost').getAttribute('hidden'), null, 'the ghost shows the prospective time mid-drag'); // the anchor is 0x0, so visibility() lies
        await page.mouse.up();
        await page.waitForTimeout(700); // the debounced live refresh re-renders everything
        assert.equal(await page.locator('#steps .step').nth(3).locator('.time').textContent(), fmtTime(expectMs), 'the step list shows the new time');
        const markerLeft = parseFloat(String(await page.locator('#ruler .tl-marker[data-i="3"]').evaluate((el) => (el as HTMLElement).style.left)));
        assert.ok(Math.abs(markerLeft - (expectMs / 6300) * 100) < 0.5, 'the marker moved to the new time, got ' + markerLeft);
        assert.ok(await page.locator('#dirty').isVisible(), 'the retime marked the timeline dirty');
        const beforeSave = await (await fetch(server.url + '/api/timeline')).json();
        assert.equal(beforeSave.raw.steps[3].time, '2500ms', 'nothing was written to disk yet');
        assert.deepEqual(errors, []);

        await page.keyboard.press('Control+s');
        await page.waitForTimeout(400);
        const afterSave = await (await fetch(server.url + '/api/timeline')).json();
        assert.equal(afterSave.raw.steps[3].time, fmtTime(expectMs), '⌘S round-trips the new time to the file');
    } finally {
        await browser.close();
        const got = await (await fetch(server.url + '/api/timeline')).json();
        const fixtureRaw = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'basic', 'anim.config.json'), 'utf8'));
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: fixtureRaw, mtime: got.mtimeMs }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: a drag clamps to the neighbours, snaps to 100ms, and Shift snaps to 10ms', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });
        const track = await page.locator('#ruler-track').boundingBox();
        const perMs = track!.width / 6300;

        // zoom-again (3s) dragged far left of zoom (2.5s): the clamp stops it AT its neighbour.
        const m = await page.locator('#ruler .tl-marker[data-i="4"]').boundingBox();
        await page.mouse.move(m!.x + m!.width / 2, m!.y + m!.height / 2);
        await page.mouse.down();
        await page.mouse.move(m!.x + m!.width / 2 - 600, m!.y + m!.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(700);
        assert.equal(await page.locator('#steps .step').nth(4).locator('.time').textContent(), '2.5s', 'the drag clamps at the previous step, never past it');

        // Shift disables the 100ms snap: a small drag lands on the 10ms grid instead.
        const n = await page.locator('#ruler .tl-marker[data-i="5"]').boundingBox();
        const fine = Math.round((5 / perMs) / 10) * 10;
        await page.keyboard.down('Shift');
        await page.mouse.move(n!.x + n!.width / 2, n!.y + n!.height / 2);
        await page.mouse.down();
        await page.mouse.move(n!.x + n!.width / 2 + 5, n!.y + n!.height / 2, { steps: 4 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await page.waitForTimeout(700);
        assert.equal(await page.locator('#steps .step').nth(5).locator('.time').textContent(), fmtTime(3500 + fine),
            'Shift lands on the 10ms grid (' + fmtTime(3500 + fine) + '), not the 100ms one');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        const got = await (await fetch(server.url + '/api/timeline')).json();
        const fixtureRaw = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'basic', 'anim.config.json'), 'utf8'));
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: fixtureRaw, mtime: got.mtimeMs }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: on the mobile view a drag edits a mobile.time override, never the base time', { skip }, async () => {
    const got = await (await fetch(server.url + '/api/timeline')).json();
    const restore = JSON.parse(JSON.stringify(got.raw));
    const restoreMtime = async () => (await (await fetch(server.url + '/api/timeline')).json()).mtimeMs;
    got.raw.steps[3].mobile = { time: '9.9s' };
    const put = await fetch(server.url + '/api/timeline', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: got.raw, mtime: got.mtimeMs }),
    });
    assert.equal(put.status, 200, JSON.stringify(await put.json()));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });

        await page.locator('#t-device').click(); // the mobile view: zoom's marker sits at its override
        await page.waitForFunction("var el = document.querySelector('#ruler .tl-marker[data-i=\\\"3\\\"]'); el && Math.abs(parseFloat(el.style.left) - 9900 / 11200 * 100) < 0.6", null, { timeout: 8000 });
        const track = await page.locator('#ruler-track').boundingBox();
        const perMs = track!.width / 11200;
        const m = await page.locator('#ruler .tl-marker[data-i="3"]').boundingBox();
        await page.mouse.move(m!.x + m!.width / 2, m!.y + m!.height / 2);
        await page.mouse.down();
        await page.mouse.move(m!.x + m!.width / 2 - 200, m!.y + m!.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(700);

        // The override moved (clamped between its mobile neighbours: name 2s, zoom-again 3s);
        // the base time is untouched, and the desktop view never saw any of it.
        await page.locator('#steps .step').nth(3).click(); // the Raw tab shows the selected step
        await page.waitForTimeout(300);
        await page.locator('.tab[data-tab=\'raw\']').click();
        const step4 = JSON.parse(await page.locator('#raw-text').inputValue());
        assert.equal(step4.mobile.time, '3s', 'the drag wrote the override (clamped into mobile chronology), got ' + step4.mobile.time);
        assert.equal(step4.time, '2500ms', 'the base time survived');
        await page.locator('#t-device').click(); // back to desktop
        await page.waitForFunction("var el = document.querySelector('#ruler .tl-marker[data-i=\\\"3\\\"]'); el && Math.abs(parseFloat(el.style.left) - 2500 / 6300 * 100) < 0.6", null, { timeout: 8000 });
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: restore, mtime: await restoreMtime() }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: typing a time in the inspector moves the marker at once, not after the debounce', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });
        await page.locator('#steps .step').nth(1).click();
        await page.waitForSelector('#f-time', { timeout: 8000 });
        await page.fill('#f-time', '1.4s');
        // No wait for the 450ms live-refresh debounce: the marker must move in the same tick.
        const left = parseFloat(String(await page.locator('#ruler .tl-marker[data-i="1"]').evaluate((el) => (el as HTMLElement).style.left)));
        assert.ok(Math.abs(left - (1400 / 6300) * 100) < 0.5, 'the marker follows the typed time immediately, got ' + left);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        const got = await (await fetch(server.url + '/api/timeline')).json();
        const fixtureRaw = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'basic', 'anim.config.json'), 'utf8'));
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: fixtureRaw, mtime: got.mtimeMs }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio ruler: a retime past the end keeps the marker on the ruler, and replaying the current step re-anchors the playhead', { skip }, async () => {
    const browser = await chromium.launch();
    const pct = (page: import('playwright').Page, sel: string) =>
        page.locator(sel).evaluate((el) => parseFloat((el as HTMLElement).style.left || 'nan'));
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForSelector('#ruler:not([hidden])', { timeout: 8000 });

        // Playback runs to the end, parking the playhead at 100%. The bridge floors every dwell
        // at 450ms plus each step's own duration, so the full fixture takes ~15s — the wait must
        // cover real pacing, not the tail.
        await page.locator('#t-play').click();
        await page.waitForFunction("document.getElementById('t-play').textContent.indexOf('play') !== -1 && document.getElementById('tl-playhead').style.left === '100%'", null, { timeout: 30000 });
        await page.locator('#ruler .tl-marker[data-i="8"]').click();
        await page.waitForTimeout(400);
        const after = await pct(page, '#tl-playhead');
        assert.ok(Math.abs(after - (5000 / 6300) * 100) < 0.5, 'the playhead re-anchored on the replay seek, got ' + after + '%');

        // Drag the last marker (caret, 5s) well past the end of the timeline: the write is legal
        // (it extends the video) but the marker may not render off the ruler's right edge.
        const track = await page.locator('#ruler-track').boundingBox();
        const perMs = track!.width / 6300;
        const m = await page.locator('#ruler .tl-marker[data-i="8"]').boundingBox();
        await page.mouse.move(m!.x + m!.width / 2, m!.y + m!.height / 2);
        await page.mouse.down();
        await page.mouse.move(m!.x + m!.width / 2 + 250, m!.y + m!.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(700);
        const expectMs = Math.round((5000 + 250 / perMs) / 100) * 100;
        assert.equal(await page.locator('#steps .step').nth(8).locator('.time').textContent(), fmtTime(expectMs), 'the overhang time is written');
        const left = await pct(page, '#ruler .tl-marker[data-i="8"]');
        assert.ok(left >= 0 && left <= 100, 'the marker stays on the ruler, got ' + left + '%');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        const got = await (await fetch(server.url + '/api/timeline')).json();
        const fixtureRaw = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'basic', 'anim.config.json'), 'utf8'));
        const putBack = await fetch(server.url + '/api/timeline', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ raw: fixtureRaw, mtime: got.mtimeMs }),
        });
        assert.equal(putBack.status, 200, 'fixture restore failed');
    }
});

test('studio locale support: scaffold, translate, refuse unknown keys and stale writes', async () => { // API-only; must run last-ish: it leaves strings.fr.json in the fixture (after() removes the dir)
    // Scaffold a new locale with the source text (the switcher's "+ new locale" flow).
    const t = await (await fetch(server.url + '/api/timeline')).json();
    const prefill: Record<string, string> = { 'meta.title': t.raw.meta.title, 'steps.open.title': 'Ouvrir le panneau' };
    const created = await fetch(server.url + '/api/strings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'fr', map: prefill }),
    });
    const createdBody = await created.json();
    assert.equal(created.status, 200, JSON.stringify(createdBody));
    assert.match(createdBody.path, /strings\.fr\.json$/);

    // GET returns the map + mtime; the locale is discoverable.
    const listed = await (await fetch(server.url + '/api/timeline')).json();
    assert.ok(listed.locales.includes('fr'), 'the new locale appears in the switcher list');
    const got = await (await fetch(server.url + '/api/strings?locale=fr')).json();
    assert.equal(got.map['steps.open.title'], 'Ouvrir le panneau');
    assert.equal(got.map['meta.title'], 'Basic fixture');

    // The preview for the locale overlays the strings.
    const preview = await (await fetch(server.url + '/preview?device=desktop&locale=fr')).text();
    assert.match(preview, /Ouvrir le panneau/);

    // Unknown step ids and non-string values are refused with the key named.
    const badId = await fetch(server.url + '/api/strings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'fr', map: { ...got.map, 'steps.ghost.title': 'x' } }),
    });
    assert.equal(badId.status, 422);
    assert.match((await badId.json()).error, /steps\.ghost\.title/);

    // `value` is only extractable from translatable steps; a key that breaks the rule is refused.
    const badValue = await fetch(server.url + '/api/strings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'fr', map: { ...got.map, 'steps.open.value': 'typed text' } }),
    });
    assert.equal(badValue.status, 422, 'value key on a non-translatable step');
    assert.match((await badValue.json()).error, /translatable/);

    // A stale mtime is a 409, and the file is untouched.
    const before = fs.readFileSync(path.join(work, 'demo', 'strings.fr.json'), 'utf8');
    const stale = await fetch(server.url + '/api/strings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'fr', map: got.map, mtime: 12345 }),
    });
    assert.equal(stale.status, 409);
    assert.equal(fs.readFileSync(path.join(work, 'demo', 'strings.fr.json'), 'utf8'), before);

    // A real edit lands and is read back.
    const write = await fetch(server.url + '/api/strings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'fr', map: { ...got.map, 'steps.open.title': 'Ouvrir le tableau' }, mtime: got.mtimeMs }),
    });
    assert.equal(write.status, 200);
    const reread = await (await fetch(server.url + '/api/strings?locale=fr')).json();
    assert.equal(reread.map['steps.open.title'], 'Ouvrir le tableau');
});

test('studio picker: the projects index lists scenarios and locales, and the project sandbox holds', async () => {
    const list = await (await fetch(server.url + '/api/projects')).json();
    const mine = list.projects.filter((p: { current: boolean }) => p.current);
    assert.equal(mine.length, 1, 'exactly one current project');
    assert.equal(mine[0].title, 'Basic fixture');
    assert.equal(mine[0].kind, 'guide');
    assert.equal(mine[0].steps, 9);
    assert.ok(/demo$/.test(mine[0].dir), 'the fixture dir is reported');
    assert.ok(mine[0].lastTouched, 'recency came from the manifest or mtime');

    // The sandbox: a project is nameable ONLY by a registry id.
    for (const bogus of ['deadbeef12', '../../../etc', '', 'null']) {
        const res = await fetch(server.url + '/api/timeline?project=' + encodeURIComponent(bogus));
        assert.equal(res.status, bogus === '' ? 200 : 404, `project=${JSON.stringify(bogus)} must not resolve`); // '' falls back to the default project
        if (bogus === '') break;
    }
    const traversal = await fetch(server.url + '/preview?project=' + encodeURIComponent('../../package.json'));
    assert.equal(traversal.status, 404, 'path-shaped ids never reach the filesystem');
});

test('studio open endpoint: registers a directory the scan cannot see, joins the picker, refuses bad paths', async () => {
    // A bare mockup with no anim.config.json: not scannable, but openable -- the editor scaffolds.
    fs.mkdirSync(path.join(work, 'bare'));
    fs.writeFileSync(path.join(work, 'bare', 'index.html'), '<!doctype html><html><body><div id="a">hi</div></body></html>');
    const post = (body: unknown) => fetch(server.url + '/api/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const opened = await (await post({ path: path.join(work, 'bare') })).json();
    assert.match(String(opened.id), /^[0-9a-f]{10}$/, 'an id comes back');
    const tl = await (await fetch(server.url + '/api/timeline?project=' + encodeURIComponent(opened.id))).json();
    assert.equal(tl.exists, false, 'the editor boots a config-less mockup into the concept flow');

    // A directory WITH a screen + timeline joins the picker listing through the open.
    fs.cpSync(fixture, path.join(work, 'side'), { recursive: true });
    const side = await (await post({ path: path.join(work, 'side') })).json();
    assert.match(String(side.id), /^[0-9a-f]{10}$/);
    const list = await (await fetch(server.url + '/api/projects')).json();
    assert.ok(list.projects.some((p: { id: string }) => p.id === side.id), 'an opened scannable dir is listed for the picker');

    // Refusals carry the CLI's own words and statuses.
    const missing = await post({ path: path.join(work, 'definitely-not') });
    assert.equal(missing.status, 404);
    assert.match(String((await missing.json()).error), /directory not found/);
    const noMockup = await post({ path: work });
    assert.equal(noMockup.status, 400);
    assert.match(String((await noMockup.json()).error), /index\.html/);
    const empty = await post({});
    assert.equal(empty.status, 400);
});

test('studio picker: scenario stories on one screen group under the same dir', async () => {
    // The fixture has no scenarios/ -- make one, then the index must list it beside the default.
    const got = await (await fetch(server.url + '/api/timeline')).json();
    fs.mkdirSync(path.join(work, 'demo', 'scenarios'), { recursive: true });
    fs.writeFileSync(path.join(work, 'demo', 'scenarios', 'short.json'), JSON.stringify({
        meta: { title: 'A shorter story', locale: 'en' },
        steps: [{ id: 'one', time: '0s', action: 'click', target: '#btn' }],
    }, null, 2) + '\n');
    const list = await (await fetch(server.url + '/api/projects')).json();
    const absDemo = path.join(work, 'demo');
    const stories = list.projects.filter((p: { dir: string }) => p.dir === absDemo);
    assert.equal(stories.length, 2, 'the default timeline and the scenario both listed');
    assert.ok(stories.some((p: { configName: string }) => p.configName === 'short.json'), 'scenario by config name');
    assert.ok(stories.some((p: { configName: string; current: boolean }) => p.configName === 'anim.config.json' && p.current), 'the default is flagged current');
});

test('studio picker: an outside boot lists scenario stories that actually load by id', async () => {
    // Self-sufficient on purpose (the earlier test writes the same bytes): the fixture lives
    // outside the repo root, so the story reaches the registry only through the outside-tree
    // merge -- its id must resolve to the real timeline, not the blank-concept fallback of a
    // mis-joined config path.
    fs.mkdirSync(path.join(work, 'demo', 'scenarios'), { recursive: true });
    fs.writeFileSync(path.join(work, 'demo', 'scenarios', 'short.json'), JSON.stringify({
        meta: { title: 'A shorter story', locale: 'en' },
        steps: [{ id: 'one', time: '0s', action: 'click', target: '#btn' }],
    }, null, 2) + '\n');
    const list = await (await fetch(server.url + '/api/projects')).json();
    const story = list.projects.find((p: { configName: string }) => p.configName === 'short.json');
    assert.ok(story, 'the scenario story is listed');
    const res = await fetch(server.url + '/api/timeline?project=' + encodeURIComponent(story.id));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.exists, true, 'the story timeline loads (not the concept-flow fallback)');
    assert.equal(body.raw.steps.length, 1, 'it is short.json, one step');

    // The story's routes resolve through its dirAbs, which must be the SCREEN -- the scenarios
    // dir holds no index.html, so a dirname-of-config join reads a nonexistent path and 500s.
    const preview = await fetch(server.url + '/preview?project=' + encodeURIComponent(story.id));
    assert.equal(preview.status, 200, 'the story preview serves the screen through the right dirAbs');
});

test('studio picker: two screens under one opened outside root report distinct, correct dirs', async () => {
    // The outside-tree merge used to stamp EVERY project under the root with the root itself:
    // a nested screen's card showed the opened dir, and the scenario switcher (which groups
    // projects by dir equality) offered unrelated screens as stories of one screen.
    fs.cpSync(fixture, path.join(work, 'outer'), { recursive: true });
    fs.cpSync(fixture, path.join(work, 'outer', 'inner'), { recursive: true });
    const opened = await (await fetch(server.url + '/api/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'outer') }),
    })).json();
    assert.match(String(opened.id), /^[0-9a-f]{10}$/, 'the outside root registered');
    const list = await (await fetch(server.url + '/api/projects')).json();
    const outer = path.join(work, 'outer');
    const byDir = (dir: string) => list.projects.filter((p: { dir: string }) => p.dir === dir);
    assert.equal(byDir(outer).length, 1, 'the opened screen carries the opened dir');
    assert.equal(byDir(path.join(outer, 'inner')).length, 1, 'the nested screen carries its own dir, not the opened root');
});

test('scanProjects: a flat strings.<locale>.json beside the config is detected as a locale', () => {
    // The scanner's first locale loop wrote its regex literal with doubled backslashes ([\\w-],
    // the class {backslash, w, hyphen}), so the common flat convention (strings.fr.json, no
    // locales/ directory) never matched and the picker showed no locale flags. No locales/ dir
    // here on purpose: a scaffolded locale directory would mask the loop entirely.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-scan-'));
    try {
        fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="a">hi</div></body></html>');
        fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { title: 'Scan fixture', locale: 'en' }, steps: [] }, null, 2) + '\n');
        fs.writeFileSync(path.join(dir, 'strings.fr.json'), JSON.stringify({ 'meta.title': 'Scan fixture' }, null, 2) + '\n');
        fs.writeFileSync(path.join(dir, 'strings.pt-BR.json'), JSON.stringify({ 'meta.title': 'Scan fixture' }, null, 2) + '\n');
        const found = scanProjects(dir);
        assert.equal(found.length, 1, 'the screen is found');
        assert.deepEqual(found[0].locales, ['fr', 'pt-BR'], 'flat strings files surface as locales');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------------ the hub
// `vistaro` with no command is a friend's front door: the same server boots with /hub as its
// landing page (the ask to give their agent, the manual served for agents at /agents.md, the
// doors into the picker), the bin alias installs under the product name, and the manual rides
// in the npm tarball so none of it depends on seeing this repo.

test('studio hub: the page, its assets and the manual route are served', async () => {
    const page = await fetch(server.url + '/hub');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /Create a product demo of my site\./, 'the ask leads the page');
    assert.match(html, /vistaro --help/, 'the ask bootstraps the agent on the installed CLI, never on a URL that can go stale');
    assert.match(html, /Show\. Don&rsquo;t Tell\./, 'the tagline is on the page');
    assert.ok(html.includes('href="/agents.md"'), 'the manual is linked where an agent (or a human) can fetch it');
    assert.ok(html.includes('href="/"'), 'the studio door targets the picker route');
    const css = await fetch(server.url + '/hub.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const js = await fetch(server.url + '/hub.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
});

test('studio hub: /agents.md serves the shipped manual itself, as markdown', async () => {
    const res = await fetch(server.url + '/agents.md');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    const body = await res.text();
    const onDisk = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.equal(body, onDisk, 'the route serves the manual byte for byte, not a summary');
});

/** The hub twin of startStudio: bare `cli.ts` (no subcommand) must boot the same server with /hub
 *  as its front door. Pipes, not a TTY, so the auto-open never fires under the suite. */
function startHub(): Promise<Server> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts'], { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
        const hub: Server = { child, port: 0, url: '', teardown: false, exitedBeforeTeardown: false, result: new Promise<CliSpawnResult>((resolveResult) => {
            child.on('close', (status, signal) => {
                if (!hub.teardown) hub.exitedBeforeTeardown = true;
                resolveResult({ status, signal, stdout: '', stderr: '' });
            });
            child.on('error', (error) => resolveResult({ status: null, signal: null, stdout: '', stderr: '', error }));
        }) };
        let boot = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hub server did not boot in time')); }, SPAWN_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => {
            boot += d.toString('utf8');
            const m = /vistaro hub at http:\/\/127\.0\.0\.1:(\d+)\/hub/.exec(boot);
            if (m) {
                clearTimeout(timer);
                hub.port = Number(m[1]); hub.url = `http://127.0.0.1:${m[1]}`;
                resolve(hub);
            }
        });
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`hub server exited early (${code})`)); });
    });
}

test('bare CLI: boots the server with /hub as the front door (the `vistaro` experience)', async () => {
    const hub = await startHub();
    try {
        const page = await (await fetch(hub.url + '/hub')).text();
        assert.match(page, /Create a product demo of my site\./, 'the hub answers on the bare invocation');
        const manual = await fetch(hub.url + '/agents.md');
        assert.equal(manual.status, 200, 'the manual route answers too');
    } finally {
        await stopServer(hub, []);
    }
});

test('bare CLI: an unknown word is still an unknown command, not a hub', () => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', 'definitely-not-a-command'], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, ['definitely-not-a-command']);
    assert.notEqual(res.status, 0, 'exit is non-zero');
    assert.match(res.stderr, /unknown command/, 'the error names the mistake');
});

test('studio: Ctrl-C after a successful boot exits cleanly through the server-close handler', { skip: process.platform === 'win32' ? 'a child kill(SIGINT) terminates unconditionally on Windows; the handler never runs' : false }, async () => {
    // The SIGINT handler used to register after the boot await -- a promise only the error paths
    // resolve -- so on the success path Ctrl-C took the default disposition: signal death, exit
    // 130, server.close never called. The handler is process-level, so a real spawn is the oracle.
    const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts', 'studio'], { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const result = new Promise<CliSpawnResult>((resolveResult) => {
        child.on('close', (status, signal) => resolveResult({ status, signal, stdout: '', stderr: '' }));
        child.on('error', (error) => resolveResult({ status: null, signal: null, stdout: '', stderr: '', error }));
    });
    let boot = '';
    const listening = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SIGINT probe did not boot in time')); }, SPAWN_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => {
            boot += d.toString('utf8');
            if (/studio listening on http:\/\/127\.0\.0\.1:\d+/.test(boot)) { clearTimeout(timer); resolve(); }
        });
        child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    });
    await listening;
    child.kill('SIGINT');
    const res = await result;
    assertRan(res, ['studio']);
    assert.equal(res.status, 0, `Ctrl-C must exit 0 through the handler, tail of boot output: ${boot.slice(-300)}`);
});

test('the vistaro bin alias ships, and the manual rides in the package with it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.bin.vistaro, 'bin/screenshot-animator.mjs', 'the friend-facing command name');
    assert.ok((pkg.files ?? []).includes('AGENTS.md'), 'the /agents.md route needs the manual in the tarball');
});

test('studio hub page: the ask, the copy button and both doors work with no console errors', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(server.url + '/hub', { waitUntil: 'networkidle' });
        const ask = await page.locator('#the-ask').textContent();
        assert.match(ask ?? '', /vistaro --help/, 'the ask block carries the self-bootstrapping manual pointer');

        // Copy is real, not decorative: the clipboard ends up holding the ask.
        await page.click('#copy-ask');
        await page.waitForTimeout(300);
        const copied = await page.evaluate('navigator.clipboard.readText()') as string;
        assert.equal(copied.trim(), (ask ?? '').trim(), 'the button copies the ask itself');
        assert.match((await page.locator('#copy-ask').textContent()) ?? '', /copied/, 'and confirms it');

        // The studio door lands on the picker.
        await page.click('a[href="/"]');
        await page.waitForURL(server.url + '/');
        assert.equal(await page.locator('#picker-main').isVisible(), true, 'the studio door opens the picker');

        // The open-folder overlay opens and closes like the picker's own.
        await page.goto(server.url + '/hub', { waitUntil: 'networkidle' });
        await page.click('#open-dir');
        assert.equal(await page.locator('#open-overlay').isVisible(), true, 'the overlay shows');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#open-overlay').isVisible(), false, 'Esc closes it');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio stacking: Ctrl+click cycles the elements under the pointer, Esc walks to the parent', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(server.url + '/preview', { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await page.evaluate("window.postMessage({ source: 'anim-studio', type: 'manipulate', enable: true, mode: 'layout' }, location.origin)");
        await page.evaluate(`(function () {
          var outer = document.createElement('section');
          outer.id = 'outer-wrap';
          outer.style.cssText = 'position:absolute; left:200px; top:120px; width:400px; height:300px;';
          var behind = document.createElement('div');
          behind.id = 'box-behind';
          behind.style.cssText = 'position:absolute; left:50px; top:40px; width:300px; height:200px;';
          var top = document.createElement('div');
          top.id = 'box-top';
          top.style.cssText = 'position:absolute; left:0; top:0; width:300px; height:200px;';
          outer.appendChild(behind); outer.appendChild(top); document.body.appendChild(outer);
          window.__selLog = [];
          window.addEventListener('message', function (e) { if (e.data && e.data.source === 'anim-studio' && e.data.type === 'selected') window.__selLog.push(e.data.selector); });
        })()`);
        await page.waitForTimeout(200);

        // Plain click selects the topmost box.
        await page.mouse.move(300, 200);
        await page.mouse.down(); await page.mouse.up();
        await page.waitForTimeout(200);
        assert.equal(await lastSel(page), '#box-top', 'plain click takes the top of the stack');

        // Ctrl+click at the same point cycles down through the stack (the frame covers the
        // stack by now -- the cycle must still work through it). The fixture's own elements
        // sit deeper in the stack; only the planted boxes' order is asserted.
        for (const expected of ['#box-behind', '#outer-wrap']) {
            await page.keyboard.down('Control');
            await page.mouse.down(); await page.mouse.up();
            await page.keyboard.up('Control');
            await page.waitForTimeout(250);
            assert.equal(await lastSel(page), expected, `cycle should reach ${expected}`);
        }

        // Esc walks up one ancestor at a time and deselects at the body. Start from a CHILD
        // (select #box-behind, whose parent is #outer-wrap) and clear the log, so the first Esc
        // must post a fresh 'selected' -- a deleted walk would leave the log empty and fail.
        await page.evaluate("window.postMessage({ source: 'anim-studio', type: 'select', selector: '#box-behind' }, location.origin)");
        await page.waitForTimeout(200);
        await page.evaluate("window.__selLog = []");
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        assert.equal(await lastSel(page), '#outer-wrap', 'Esc selects the parent');
        await page.evaluate("window.__selLog = []");
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate('window.__studio.state().selected'), false, 'Esc at the body deselects');
        assert.equal(await page.evaluate('window.__selLog.length'), 0, 'no selection is posted when deselecting');
        assert.deepEqual(errors, []);

        async function lastSel(p: import('playwright').Page): Promise<string | undefined> {
            return p.evaluate('window.__selLog[window.__selLog.length - 1]');
        }
    } finally {
        await browser.close();
    }
});

test('studio layers panel: the tree posts, hover highlights, and a row click selects the element', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(server.url + '/preview', { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await page.evaluate("window.postMessage({ source: 'anim-studio', type: 'manipulate', enable: true, mode: 'layout' }, location.origin)");
        // Plant a hidden child so the hidden flag has something to flag on this fixture.
        await page.evaluate(`(function () {
          var box = document.createElement('div');
          box.id = 'layers-probe-box';
          box.style.cssText = 'position:absolute; left:40px; top:40px; width:100px; height:80px;';
          var ghost = document.createElement('span');
          ghost.id = 'layers-probe-hidden';
          ghost.style.cssText = 'opacity:0;';
          ghost.textContent = 'invisible';
          box.appendChild(ghost);
          document.body.appendChild(box);
        })()`);

        // The tree request answers with the planted box + hidden child, with depth nesting.
        const tree = await page.evaluate("new Promise(function (resolve) { window.addEventListener('message', function h(e) { if (e.data && e.data.type === 'layers-tree') { window.removeEventListener('message', h); resolve(e.data.nodes); } }); window.postMessage({ source: 'anim-studio', type: 'layers' }, location.origin); setTimeout(function () { resolve(null); }, 4000); })") as any[] | null;
        assert.ok(tree, 'the layers tree came back');
        const boxRow = tree!.find(n => n.selector === '#layers-probe-box');
        const ghostRow = tree!.find(n => n.selector === '#layers-probe-hidden');
        assert.ok(boxRow, 'the planted box is in the tree');
        assert.ok(ghostRow && ghostRow.hidden === true, 'the opacity:0 child is flagged hidden');
        assert.ok(ghostRow!.depth === boxRow!.depth + 1, 'nesting carries depth');

        // select-by-selector (the panel's click) selects, through the same frame path.
        await page.evaluate("window.__selLog = []; window.addEventListener('message', function (e) { if (e.data && e.data.source === 'anim-studio' && e.data.type === 'selected') window.__selLog.push(e.data.selector); })");
        await page.evaluate("window.postMessage({ source: 'anim-studio', type: 'select', selector: '#layers-probe-box' }, location.origin)");
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate('window.__selLog[window.__selLog.length - 1]'), '#layers-probe-box');

        // highlight-by-selector (the panel's hover) outlines and self-clears.
        await page.evaluate("window.postMessage({ source: 'anim-studio', type: 'highlight', selector: '#layers-probe-box' }, location.origin)");
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(`(function () { var el = document.querySelector('#layers-probe-box'); return el.style.outline.indexOf('dashed') !== -1; })()`), true, 'hover outline applied');
        await page.waitForTimeout(900);
        assert.equal(await page.evaluate(`(function () { var el = document.querySelector('#layers-probe-box'); return el.style.outline.indexOf('dashed') !== -1; })()`), false, 'and it self-clears');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio drag offer: a drag with no animate step offers convert-or-create, then authors', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);

        // A click step selected + a canvas drag -> the offer bar with three choices.
        await page.locator("#steps .step").nth(1).click();
        await page.waitForTimeout(500);
        await page.frameLocator('#preview').locator('#btn').click();
        await page.waitForTimeout(400);
        let fb = await page.frameLocator("#preview").locator("[data-studio-frame] > div:first-child").boundingBox();
        await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
        await page.mouse.down();
        await page.mouse.move(fb!.x + fb!.width / 2 + 50, fb!.y + fb!.height / 2 + 25, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.ask').count(), 1, 'the offer bar appears');
        const options = await page.locator('.ask button').allTextContents();
        assert.equal(options.length, 3, 'convert / create / ignore');
        assert.match(options[0]!, /Convert/, 'the convert option names the selected step');
        assert.match(options[1]!, /New animate step/, 'the create option names the element');

        // Create: a new animate step targeting the dragged element is inserted and selected.
        await page.locator('.ask button', { hasText: 'New animate step' }).click();
        await page.waitForTimeout(900); // the live reload fires ~450ms later and deselects the canvas
        assert.equal(await page.locator('#steps .step').count(), 10, 'the step was added');
        const act = await page.evaluate("(function () { var el = document.querySelector('#steps .step.is-selected .act'); return el ? el.textContent : 'none'; })()");
        assert.equal(act, 'animate', 'the new step is selected');

        // The SAME gesture now authors: drag again and to.x/to.y carry the delta.
        await page.frameLocator('#preview').locator('#btn').click();
        await page.waitForTimeout(400);
        fb = await page.frameLocator("#preview").locator("[data-studio-frame] > div:first-child").boundingBox();
        const transform = await page.evaluate("document.getElementById('preview').style.transform || 'scale(1)'") as string;
        const fit = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 1) || 1;
        await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
        await page.mouse.down();
        await page.mouse.move(fb!.x + fb!.width / 2 + 60, fb!.y + fb!.height / 2 + 30, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(500);
        await page.locator(".tab[data-tab='raw']").click();
        const raw = JSON.parse(await page.locator('#raw-text').inputValue());
        assert.equal(raw.action, 'animate');
        assert.equal(raw.target, '#btn', 'the offer carried the dragged element as the target');
        assert.ok(Math.abs(raw.to.x - Math.round(60 / fit)) <= 4 && Math.abs(raw.to.y - Math.round(30 / fit)) <= 4,
            `to.x/to.y carry the authored delta (got ${raw.to.x}/${raw.to.y}, want ~${Math.round(60 / fit)}/${Math.round(30 / fit)})`);

        // Convert: a wait step with no target ADOPTS the dragged selector, keeps its existing
        // to, and the drag then authors onto it. This is the path the unguarded Convert threw on.
        await page.locator('.tab[data-tab=\'inspector\']').click();
        await page.locator('#steps .step').nth(3).click(); // the type step shifted right when the new animate step was inserted at 2
        await page.waitForTimeout(300);
        await page.evaluate("var sel = document.querySelector('#fields .field select'); sel.value = 'wait'; sel.dispatchEvent(new Event('change', { bubbles: true }))");
        await page.waitForTimeout(700); // live reload
        await page.frameLocator('#preview').locator('#btn').click();
        await page.waitForTimeout(300);
        fb = await page.frameLocator("#preview").locator("[data-studio-frame] > div:first-child").boundingBox();
        await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
        await page.mouse.down();
        await page.mouse.move(fb!.x + fb!.width / 2 + 40, fb!.y + fb!.height / 2 + 20, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.ask').count(), 1, 'a second offer replaces the spent one');
        await page.locator('.ask button', { hasText: 'Convert' }).click();
        await page.waitForTimeout(400);
        await page.locator(".tab[data-tab='raw']").click();
        const converted = JSON.parse(await page.locator('#raw-text').inputValue());
        assert.equal(converted.action, 'animate', 'the step converted without throwing (the unguarded P2 crash)');
        assert.equal(converted.target, '#field', 'a step that already has a target keeps it (adoption is only for target-less steps)');
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
    }
});

test('studio editor: the open-transport link and the export-toast artifact links carry ?project=', { skip }, async () => {
    // The hub -> picker flow boots NO default project: there, a bare /preview or /artifact/..
    // is a 404 ("unknown project"). Open a project that is not the boot default, so the id in
    // the links can only have come from the editor's own ?project=.
    fs.cpSync(fixture, path.join(work, 'proj-links'), { recursive: true });
    const opened = await (await fetch(server.url + '/api/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(work, 'proj-links') }),
    })).json();
    const id = String(opened.id);
    assert.match(id, /^[0-9a-f]{10}$/, 'the second project registered');

    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        await page.goto(server.url + '/?project=' + encodeURIComponent(id), { waitUntil: 'networkidle' });
        await page.waitForTimeout(500);

        // The transport's "open ↗" starts as static href="/preview"; the editor must rewrite it.
        const openHref = await page.evaluate("document.getElementById('t-open').href") as string;
        assert.equal(new URL(openHref).searchParams.get('project'), id, 'the transport link carries the project id, got ' + openHref);

        // The export toast's artifact links carry it too. The export endpoint is intercepted:
        // this tests the toast rendering, not the encode.
        await page.route('**/api/export*', (route) => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ exitCode: 0, artifacts: ['studio.mp4'] }),
        }));
        await page.click('#export');
        await page.waitForSelector('#toasts .toast a', { timeout: 8000 });
        const artifactHref = await page.evaluate("document.querySelector('#toasts .toast a').href") as string;
        const artifactUrl = new URL(artifactHref);
        assert.equal(artifactUrl.pathname, '/artifact/studio.mp4');
        assert.equal(artifactUrl.searchParams.get('project'), id, 'the artifact link carries the project id, got ' + artifactHref);
    } finally {
        await browser.close();
    }
});

test('studio editor: an artifact filename is escaped in the export toast, not interpolated as HTML', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        const hostile = 'studio.<img src=x onerror=alert(1)>.mp4';
        await page.route('**/api/export*', (route) => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ exitCode: 0, artifacts: [hostile] }),
        }));
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        await page.click('#export');
        await page.waitForSelector('#toasts .toast a', { timeout: 8000 });
        const imgs = await page.evaluate("document.querySelectorAll('#toasts .toast img').length") as number;
        assert.equal(imgs, 0, 'no element from the filename may land in the toast');
        const text = await page.evaluate("document.querySelector('#toasts .toast a').textContent") as string;
        assert.equal(text, hostile, 'the filename renders as its literal text, escaped');
    } finally {
        await browser.close();
    }
});

test('studio editor: scaffolding a locale leaves the switcher on the new locale', { skip }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
        await page.goto(await editorUrl(), { waitUntil: 'networkidle' });
        await page.waitForTimeout(500);
        page.on('dialog', (d) => { void d.accept('zz'); });
        await page.selectOption('#locale', '__new__');
        // loadStrings('zz') settles into the issues title ("Editing zz translations ...") in
        // both the fixed and the unfixed page -- only the switcher distinguishes them.
        await page.waitForFunction("document.getElementById('issues-title').textContent.indexOf('zz translations') !== -1", null, { timeout: 8000 });
        await page.waitForTimeout(200);
        assert.equal(await page.locator('#locale').inputValue(), 'zz', 'the switcher shows the locale the editor just entered');
    } finally {
        await browser.close();
    }
});
