import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { assertRan, CLI_TIMEOUT_MS, CliSpawnResult } from './assert-ran';
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

before(async () => {
    if (skip) return;
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
        await page.goto(server.url + '/', { waitUntil: 'networkidle' });
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
        await page.goto(server.url + '/', { waitUntil: 'networkidle' });
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
