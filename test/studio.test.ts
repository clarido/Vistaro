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
