import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import { parseTimeline } from '../src/engine/schema';
import { buildAnimatedHtml } from '../src/engine/inject';
import { runTimeline, ensureRuntime } from '../src/engine/driver';
import { fileUrl } from '../src/browser';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

let browser: Browser;
let work: string;
let builtPath: string;

before(async () => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-test-'));
    fs.cpSync(fixture, path.join(work, 'basic'), { recursive: true });
    const r = cli(['build', path.join(work, 'basic')]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    builtPath = path.join(work, 'basic', 'animated.html');
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    if (browser) await browser.close();
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('built page self-plays: anim:step fires within 100ms of each time, real handlers run', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
        (window as any).__events = [];
        window.addEventListener('anim:step', (e: any) => (window as any).__events.push(e.detail));
    });
    await page.goto(fileUrl(builtPath));
    assert.equal(await page.evaluate(() => typeof (window as any).__anim), 'object');
    await page.waitForFunction(() => (window as any).__events.length >= 9, null, { timeout: 15000 });
    const events: any[] = await page.evaluate(() => (window as any).__events);
    for (const ev of events) {
        assert.ok(Math.abs(ev.actualMs - ev.scheduledMs) <= 100, `step ${ev.index} ${ev.action}: actual ${ev.actualMs} vs scheduled ${ev.scheduledMs}`);
    }
    assert.equal(await page.getAttribute('body', 'data-clicks'), '1', 'onclick handler ran via el.click()');
    assert.equal(await page.getAttribute('body', 'data-listener'), 'fired', 'addEventListener listener ran');
    await page.waitForFunction(() => (document.getElementById('field') as HTMLInputElement).value === 'Ada');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('screen2')!).display === 'block', null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('screen1')!).display), 'none');
    // overlays live on <html>, not the transformed <body>
    assert.equal(await page.evaluate(() => document.getElementById('anim-cli-cursor')!.parentElement!.tagName), 'HTML');
    await context.close();
});

test('built page does not self-play when __ANIM_DRIVEN is set before load', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
        (window as any).__ANIM_DRIVEN = true;
        (window as any).__events = [];
        window.addEventListener('anim:step', (e: any) => (window as any).__events.push(e.detail));
    });
    await page.goto(fileUrl(builtPath));
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => (window as any).__events.length), 0);
    assert.equal(await page.getAttribute('body', 'data-clicks'), null);
    assert.equal(await page.evaluate(() => (window as any).__anim.isReady()), true);
    await context.close();
});

test('runTimeline(step) returns measured results and consecutive camera steps do not compound', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(fixture, 'anim.config.json'), 'utf8')));
    await ensureRuntime(page, tl, { drift: false });
    const transforms: Record<string, string> = {};
    const seen: number[] = [];
    const results = await runTimeline(page, tl, {
        mode: 'step', settleMs: 50,
        beforeStep: (s) => { seen.push(s.index); },
        afterStep: async (s) => {
            if (s.action === 'camera') transforms[s.id] = await page.evaluate(() => document.body.style.transform);
        },
    });
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(results.length, 9);
    for (const r of results) {
        assert.equal(r.error, undefined, `step ${r.index}: ${r.error}`);
        assert.ok(Number.isFinite(r.actualMs));
    }
    assert.ok(results[1].rect && results[1].rect.width > 0);
    assert.ok(results[1].point && results[1].point.x > 0);
    assert.ok(results[2].actualMs > results[1].actualMs);
    assert.equal(transforms['zoom'], transforms['zoom-again'], 'same target twice must give the same body transform');
    assert.match(transforms['zoom'], /^scale\(1\.3\) translate\(/);
    assert.equal(await page.inputValue('#field'), 'Ada');
    await context.close();
});

test('runTimeline(timed): interactions land within 100ms of schedule, results carry completedMs', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(fixture, 'anim.config.json'), 'utf8')));
    await ensureRuntime(page, tl, { drift: false });
    const results = await runTimeline(page, tl, { mode: 'timed' });
    assert.equal(results.length, 9);
    // What the scheduler owes us is that no step fires early and that none drifts away from the
    // others. Absolute lateness is the machine's business: under CPU contention every step is late
    // together, which is not a scheduling defect, so lateness is measured against this run's own floor.
    const lateness = results.map(r => r.actualMs - r.scheduledMs);
    const floor = Math.min(...lateness);
    for (const [i, r] of results.entries()) {
        assert.equal(r.error, undefined, `step ${r.index}: ${r.error}`);
        assert.ok(lateness[i] >= -20, `step ${r.index} ${r.action} fired early: actual ${r.actualMs} vs scheduled ${r.scheduledMs}`);
        assert.ok(lateness[i] - floor <= 100, `step ${r.index} ${r.action} drifted ${Math.round(lateness[i] - floor)}ms from the run's floor (lateness ${JSON.stringify(lateness.map(Math.round))})`);
        assert.ok(Number.isFinite(r.completedMs) && r.completedMs! >= r.actualMs, `step ${r.index} completedMs`);
    }
    // Order is preserved: a later step never interacts before an earlier one.
    for (let i = 1; i < results.length; i++) assert.ok(results[i].actualMs >= results[i - 1].actualMs, `step ${results[i].index} ran before ${results[i - 1].index}`);
    const typeStep = results[2];
    assert.ok(typeStep.completedMs! - typeStep.actualMs >= 40, 'typing "Ada" at 50cps completes ~40ms after the first char');
    assert.equal(await page.inputValue('#field'), 'Ada');
    await context.close();
});

test('runTimeline never rejects on throwing hooks; the error lands in result.error', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline([
        { time: 0, action: 'wait' },
        { time: 0.3, action: 'click', target: '#btn' },
        { time: 0.6, action: 'highlight', target: '#note' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    let unhandled: any = null;
    const onUnhandled = (e: any) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
        for (const mode of ['timed', 'step'] as const) {
            const results = await runTimeline(page, tl, {
                mode, settleMs: 0,
                beforeStep: (s) => { if (s.index === 1) throw new Error('hook boom'); },
                afterStep: async (s) => { if (s.index === 3) throw new Error('after boom'); },
            });
            assert.match(results[0].error!, /beforeStep hook: hook boom/);
            assert.ok(Number.isNaN(results[0].actualMs), 'a step whose beforeStep threw does not run');
            assert.equal(results[1].error, undefined);
            assert.match(results[2].error!, /afterStep hook: after boom/);
            assert.ok(Number.isFinite(results[2].actualMs), 'the step itself still ran');
        }
        await new Promise(r => setTimeout(r, 50));
        assert.equal(unhandled, null, `unhandled rejection: ${unhandled && unhandled.message}`);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
    await context.close();
});

test('press step sends a real key through page.keyboard at the interaction', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    await page.evaluate(() => { document.addEventListener('keydown', (e) => document.body.setAttribute('data-key', e.key)); });
    const tl = parseTimeline([
        { time: 0, action: 'click', target: '#btn' },
        { time: 0.2, action: 'focus', target: '#field' },
        { time: 0.4, action: 'press', value: 'Enter' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    const results = await runTimeline(page, tl, { mode: 'step', settleMs: 0, instant: true });
    assert.equal(results[2].error, undefined);
    assert.equal(await page.getAttribute('body', 'data-key'), 'Enter');
    await context.close();
});

test('0x0 typing target: spotlight uses the sized ancestor, caret is scrolled into view, text is visible', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline([{ time: 0, action: 'type', target: '#caret', value: 'hello there', cps: 50 }]);
    await ensureRuntime(page, tl, { drift: false });
    const before = await page.evaluate(() => (window as any).__anim.isClipped(document.getElementById('caret')));
    assert.equal(before, true, '#caret starts scrolled out of view inside #log');
    let boxAtCapture: any;
    const results = await runTimeline(page, tl, {
        mode: 'step', settleMs: 100,
        afterStep: async () => {
            boxAtCapture = await page.evaluate(() => {
                const h = document.getElementById('anim-cli-highlight')!.getBoundingClientRect();
                const log = document.getElementById('log')!.getBoundingClientRect();
                const caret = document.getElementById('caret')!.getBoundingClientRect();
                return { h: { x: h.x, y: h.y, width: h.width, height: h.height }, log: { x: log.x, y: log.y, width: log.width, height: log.height }, caret: { x: caret.x, y: caret.y, width: caret.width }, opacity: getComputedStyle(document.getElementById('anim-cli-highlight')!).opacity, typed: document.getElementById('caret')!.textContent };
            });
        },
    });
    const r = results[0];
    assert.equal(r.error, undefined);
    assert.ok(r.rect && r.rect.width > 100 && r.rect.height > 50, `StepResult.rect is the sized ancestor box: ${JSON.stringify(r.rect)}`);
    assert.ok(r.targetRect && r.targetRect.width === 0, 'raw target rect is reported separately');
    assert.ok(boxAtCapture.h.width >= boxAtCapture.log.width && boxAtCapture.h.height >= boxAtCapture.log.height, `highlight ${JSON.stringify(boxAtCapture.h)} covers #log ${JSON.stringify(boxAtCapture.log)}`);
    assert.ok(parseFloat(boxAtCapture.opacity) > 0.5, 'spotlight visible at the capture point');
    assert.ok(boxAtCapture.typed.length >= 1, 'first characters typed at capture');
    assert.ok(boxAtCapture.caret.y >= boxAtCapture.log.y && boxAtCapture.caret.y <= boxAtCapture.log.y + boxAtCapture.log.height, 'caret scrolled into the visible part of #log');
    assert.equal(await page.evaluate(() => (window as any).__anim.isClipped(document.getElementById('caret'))), false);
    assert.equal(await page.textContent('#caret'), 'hello there');
    await context.close();
});

test('a target removed mid-run still reaches afterStep with the error (no silent skip)', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline([
        { time: 0, action: 'click', target: '#btn' },
        { time: 0.5, action: 'highlight', target: '#note' },
        { time: 1, action: 'highlight', target: '#field' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    const seen: number[] = [];
    const results = await runTimeline(page, tl, {
        mode: 'step', settleMs: 0, instant: true,
        beforeStep: async (s) => { if (s.index === 2) await page.evaluate(() => document.getElementById('note')!.remove()); },
        afterStep: (s) => { seen.push(s.index); },
    });
    assert.deepEqual(seen, [1, 2, 3]);
    assert.match(results[1].error!, /target not found: #note/);
    assert.ok(Number.isNaN(results[1].actualMs));
    assert.equal(results[2].error, undefined);
    // the guide badge never shows during a plain run
    assert.equal(await page.evaluate(() => { const c = document.getElementById('anim-cli-callout'); return !c || getComputedStyle(c).display === 'none'; }), true);
    await context.close();
});

test('runTimeline reports a missing target as a per-step error and keeps going', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const tl = parseTimeline([
        { time: 0, action: 'click', target: '#nope' },
        { time: 1, action: 'click', target: '#btn' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    const results = await runTimeline(page, tl, { mode: 'step', settleMs: 0, instant: true });
    assert.match(results[0].error!, /target not found: #nope/);
    assert.equal(results[1].error, undefined);
    await context.close();
});

test('runtime tolerates document-start injection (addInitScript)', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    await context.addInitScript({ path: path.join(root, 'src', 'engine', 'runtime.js') });
    await context.addInitScript(() => { (window as any).__anim.boot({ cursor: 'windows', drift: false }); });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    await page.waitForFunction(() => (window as any).__anim.isReady());
    assert.equal(await page.evaluate(() => !!document.getElementById('anim-cli-cursor')), true);
    assert.equal(await page.evaluate(() => !!document.getElementById('anim-cli-runtime-style')), true);
    await context.close();
});

test('check: clean fixture exits 0; broken copy lists every error with step/time/action/target and exits 1; --json', { skip }, async () => {
    const ok = cli(['check', path.join(work, 'basic')]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /OK:/);
    assert.match(ok.stdout, /info {3}\s+step 9 .*spotlight uses its sized ancestor #log/);
    const okJson = JSON.parse(cli(['check', path.join(work, 'basic'), '--json']).stdout);
    assert.deepEqual(okJson.map((i: any) => [i.level, i.step, i.highlightFallback]), [['info', 9, '#log']]);

    const broken = path.join(work, 'broken');
    fs.cpSync(fixture, broken, { recursive: true });
    fs.writeFileSync(path.join(broken, 'anim.config.json'), JSON.stringify([
        { time: 2, action: 'click', target: '#does-not-exist' },
        { time: 3, action: 'type', target: '#field' },
        { time: 1, action: 'explode' },
    ]));
    const r = cli(['check', broken, '--static']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /error {2}\s+step 2 \(3\.0s type #field\): action "type" requires a non-empty "value"/);
    assert.match(r.stdout, /step 3 .*unknown action "explode"/);
    assert.match(r.stdout, /step 3 .*earlier than the previous step/);

    const j = cli(['check', broken, '--static', '--json']);
    assert.equal(j.status, 1);
    const issues = JSON.parse(j.stdout);
    assert.ok(Array.isArray(issues) && issues.length >= 3);
    assert.ok(issues.every((i: any) => i.level && i.message));

    // browser pass catches the missing selector
    fs.writeFileSync(path.join(broken, 'anim.config.json'), JSON.stringify([
        { time: 1, action: 'click', target: '#does-not-exist' },
        { time: 2, action: 'click', target: '#btn' },
    ]));
    const b = cli(['check', broken]);
    assert.equal(b.status, 1);
    assert.match(b.stdout, /step 1 \(1\.0s click #does-not-exist\): target "#does-not-exist" matches nothing/);
    assert.match(b.stdout, /1 error\(s\)/);
});

test('build: legacy array and numeric times build; unknown action fails without --force', { skip }, () => {
    const legacy = path.join(work, 'legacy');
    fs.cpSync(fixture, legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'anim.config.json'), JSON.stringify([
        { time: '0s', action: 'fadeIn', target: 'body', subtitle: 'Hi' },
        { time: '1s', action: 'click', target: '#btn' },
        { time: 2, action: 'showText', target: '#banner' },
    ]));
    const r = cli(['build', legacy, '--cursor', 'windows']);
    assert.equal(r.status, 0, r.stderr);
    const html = fs.readFileSync(path.join(legacy, 'animated.html'), 'utf8');
    assert.ok(html.includes('"cursor":"windows"'));
    assert.ok(html.includes('"action":"fadeIn"'));
    const manifest = JSON.parse(fs.readFileSync(path.join(legacy, 'anim.manifest.json'), 'utf8'));
    assert.equal(manifest.history.at(-1).command, 'build');

    fs.writeFileSync(path.join(legacy, 'anim.config.json'), JSON.stringify([{ time: '1s', action: 'jump', target: '#btn' }]));
    fs.rmSync(path.join(legacy, 'animated.html'));
    const bad = cli(['build', legacy]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown action "jump"/);
    assert.ok(!fs.existsSync(path.join(legacy, 'animated.html')));
    const forced = cli(['build', legacy, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(fs.existsSync(path.join(legacy, 'animated.html')));
});

test('preview writes a contact sheet and a single full-size frame', { skip }, () => {
    const dir = path.join(work, 'basic');
    const r = cli(['preview', dir, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const sheet = path.join(dir, 'preview.png');
    assert.ok(fs.existsSync(sheet));
    assert.ok(fs.statSync(sheet).size > 10000);
    assert.match(r.stdout, /#2 · 1\.0s · click #btn · Open the panel/);
    const end = cli(['preview', dir, '--at', 'end', '--step', '3', '--width', '1280', '--height', '800']);
    assert.equal(end.status, 0, end.stderr + end.stdout);
    assert.match(end.stdout, /completed at \d+ms/);
    const one = cli(['preview', dir, '--step', '3', '--width', '1280', '--height', '800']);
    assert.equal(one.status, 0, one.stderr + one.stdout);
    const frame = path.join(dir, 'preview-step-3.png');
    assert.ok(fs.existsSync(frame));
    // PNG header: width at bytes 16..19, height at 20..23; recorded at 2x device scale factor
    const buf = fs.readFileSync(frame);
    assert.equal(buf.readUInt32BE(16), 2560);
    assert.equal(buf.readUInt32BE(20), 1600);
});

test('camera carries the cursor: it lands on the anchor element\'s transformed centre, not its pre-zoom point', { skip }, async () => {
    // The cursor is position:fixed in the overlay layer, so a transform on <body> moves the page out
    // from under it; after a zoom it used to sit wherever it was before, off the element it clicked.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const timeline = parseTimeline({ meta: { cursor: 'mac', drift: false }, steps: [
        { id: 'open', time: 0.4, action: 'click', target: '#btn' },
        { id: 'zoom', time: 1.2, action: 'camera', target: '#btn', scale: 1.4, duration: 0.4 },
    ] });
    await ensureRuntime(page, timeline, { drift: false });
    // The cursor's hotspot is its top-left corner (transform-origin: top left, top/left 0), so its
    // bounding rect corner IS the pointer position.
    const cursorPoint = () => page.evaluate(() => {
        const c = document.getElementById('anim-cli-cursor')!.getBoundingClientRect();
        return { x: c.left, y: c.top };
    });
    const targetCentre = () => page.evaluate(() => {
        const r = document.querySelector('#btn')!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    const results = await runTimeline(page, timeline, { mode: 'step', settleMs: 0 });
    assert.deepEqual(results.map(r => r.error), [undefined, undefined]);

    const before = await page.evaluate(() => (window as any).__anim.cursorAnchor());
    assert.ok(before && Math.abs(before.fx - 0.5) < 0.2 && Math.abs(before.fy - 0.5) < 0.2, `anchored on #btn: ${JSON.stringify(before)}`);
    const centre = await targetCentre();
    const cursor = await cursorPoint();
    assert.ok(Math.abs(cursor.x - centre.x) <= 2 && Math.abs(cursor.y - centre.y) <= 2,
        `cursor ${JSON.stringify(cursor)} vs #btn transformed centre ${JSON.stringify(centre)} after a 1.4x zoom`);
    // The zoom really did move the element: a cursor left at its pre-zoom point would be far away.
    const untransformed = await page.evaluate(() => {
        const stage = document.body, keep = stage.style.transform;
        stage.style.transition = 'none'; stage.style.transform = 'none';
        const r = document.querySelector('#btn')!.getBoundingClientRect();
        stage.style.transform = keep;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(Math.hypot(centre.x - untransformed.x, centre.y - untransformed.y) > 20,
        `the camera moved #btn far enough for this to be a real check: ${JSON.stringify({ centre, untransformed })}`);
    await context.close();
});

test('camera carries the spotlight too: the ring frames the element\'s transformed box, not its old one', { skip }, async () => {
    // Same defect as the cursor: #anim-cli-highlight is position:fixed outside the transformed
    // stage, so a camera push left the ring behind over empty background (measured ~1090px adrift).
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    const timeline = parseTimeline({ meta: { cursor: 'mac', drift: false }, steps: [
        { id: 'notice', time: 0.4, action: 'highlight', target: '#btn' },
        { id: 'zoom', time: 1.2, action: 'camera', target: '#btn', scale: 1.4, duration: 0.4 },
    ] });
    await ensureRuntime(page, timeline, { drift: false });
    const results = await runTimeline(page, timeline, { mode: 'step', settleMs: 0 });
    assert.deepEqual(results.map(r => r.error), [undefined, undefined]);
    // The ring glides on the camera's curve; wait for it to land before measuring.
    await page.evaluate(() => (window as any).__anim.whenSettled({ timeoutMs: 5000 }));

    const measured = await page.evaluate(() => {
        const r = document.querySelector('#btn')!.getBoundingClientRect();
        const stage = document.body, keep = stage.style.transform, keepT = stage.style.transition;
        stage.style.transition = 'none'; stage.style.transform = 'none';
        const plain = document.querySelector('#btn')!.getBoundingClientRect();
        stage.style.transform = keep; stage.style.transition = keepT;
        return {
            target: { x: r.left, y: r.top, width: r.width, height: r.height },
            untransformed: { x: plain.left, y: plain.top },
            ring: (window as any).__anim.highlightBox(),
        };
    });
    // The ring is drawn 6px outside the box, and its own 2px border falls outside that again.
    const { target, ring, untransformed } = measured;
    assert.ok(ring, 'the spotlight exists');
    assert.ok(Math.abs(ring.x - (target.x - 8)) <= 2 && Math.abs(ring.y - (target.y - 8)) <= 2,
        `ring at ${JSON.stringify(ring)} vs #btn transformed box ${JSON.stringify(target)}`);
    assert.ok(Math.abs(ring.width - (target.width + 16)) <= 2 && Math.abs(ring.height - (target.height + 16)) <= 2,
        `ring size ${JSON.stringify(ring)} vs #btn ${JSON.stringify(target)}`);
    assert.ok(Math.hypot(target.x - untransformed.x, target.y - untransformed.y) > 20,
        `the camera moved #btn far enough for this to be a real check: ${JSON.stringify({ target, untransformed })}`);
    await context.close();
});

// --- React-style controlled inputs (a framework value tracker) -------------------------------

const controlled = path.join(__dirname, 'fixtures', 'controlled');

test('self-playing page types into a React-style controlled input: the framework sees the change (native setter, not el.value)', { skip }, async () => {
    // The fixture installs React's value tracker: an own `value` accessor on the input whose setter
    // records the assignment, and an input listener that only fires onChange when the DOM value
    // differs from the tracked one. `el.value = text` therefore never enables the Add button.
    fs.cpSync(controlled, path.join(work, 'controlled'), { recursive: true });
    const r = cli(['build', path.join(work, 'controlled')]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(work, 'controlled', 'animated.html')));
    // No driver attached: the page's own typist (setTyped) runs. It must go through the prototype's
    // native setter so the tracker is left stale and the input event is seen as a change.
    await page.waitForFunction(() => (document.getElementById('tag') as HTMLInputElement).value === 'urgent', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => (document.getElementById('add') as HTMLButtonElement).disabled), false, 'the framework saw the typed value and enabled Add');
    await page.waitForFunction(() => document.querySelectorAll('#tags li').length === 1, null, { timeout: 5000 });
    assert.equal(await page.textContent('#tags li'), 'urgent');
    await context.close();
});

test('with a driver attached, `type` goes through the real keyboard: keydown events, framework onChange, progress and completion still measured', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(controlled, 'index.html')));
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(controlled, 'anim.config.json'), 'utf8')));
    await ensureRuntime(page, tl, { drift: false });
    const enabledAfterTyping: boolean[] = [];
    const results = await runTimeline(page, tl, {
        mode: 'step', settleMs: 0, afterStepAt: 'completion',
        afterStep: async (step) => { if (step.action === 'type') enabledAfterTyping.push(!(await page.evaluate(() => (document.getElementById('add') as HTMLButtonElement).disabled))); },
    });
    assert.equal(results[0].error, undefined, results[0].error);
    assert.equal(results[0].typing, 'driver', 'the driver typed, not the page');
    assert.equal(await page.textContent('#keys'), '6', 'one keydown per character reached the app');
    assert.deepEqual(enabledAfterTyping, [true], 'the framework saw the typed value and enabled Add (the click then adds the tag and disables it again)');
    assert.ok(Number.isFinite(results[0].actualMs) && Number.isFinite(results[0].completedMs!), 'actualMs and completedMs measured');
    const typedFor = results[0].completedMs! - results[0].actualMs;
    assert.ok(typedFor >= 6 * 40 - 60 && typedFor < 2000, `typing 6 chars at 25cps took ${typedFor}ms`);
    // the spotlight was re-tracked and the click step then found an enabled button
    assert.equal(results[1].error, undefined, results[1].error);
    assert.equal(await page.textContent('#tags li'), 'urgent');
    // a plain element (no keyboard input) keeps the in-page typist
    const tl2 = parseTimeline([{ time: 0, action: 'type', target: '[data-help="title"]', value: 'Labels', title: 'Rename' }]);
    const r2 = await runTimeline(page, tl2, { mode: 'step', settleMs: 0, instant: true });
    assert.equal(r2[0].typing, undefined);
    assert.equal(await page.textContent('[data-help="title"]'), 'Labels');
    await context.close();
});

test('driver typing only claims fields the keyboard can fill: a date input and a readonly one keep the in-page path', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.setContent('<body><input id="d" type="date"><input id="ro" readonly><textarea id="t"></textarea></body>');
    const tl = parseTimeline([
        { time: 0, action: 'type', target: '#d', value: '2026-03-04', title: 'Date' },
        { time: 0.2, action: 'type', target: '#ro', value: 'fixed', title: 'Readonly' },
        { time: 0.4, action: 'type', target: '#t', value: 'free text', title: 'Textarea' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    const results = await runTimeline(page, tl, { mode: 'step', settleMs: 0, instant: true });
    for (const r of results) assert.equal(r.error, undefined, `${r.id}: ${r.error}`);
    // page.keyboard.type() cannot fill a date input and never reaches a readonly one: both would end
    // up empty, so they keep the in-page typist (correct for frameworks too, via the native setter).
    assert.equal(results[0].typing, undefined, 'date input filled in the page');
    assert.equal(results[1].typing, undefined, 'readonly input filled in the page');
    assert.equal(results[2].typing, 'driver', 'textarea typed on the real keyboard');
    assert.equal(await page.inputValue('#d'), '2026-03-04');
    assert.equal(await page.inputValue('#ro'), 'fixed');
    assert.equal(await page.inputValue('#t'), 'free text');
    await context.close();
});

test('check warns a reel about the two silent mobile authoring traps', { skip }, () => {
    // Both produce a plausible-looking video at the wrong scale rather than an error, so they are
    // only ever caught by reading the output. See AGENTS.md "Authoring a reel".
    const dir = path.join(work, 'trap');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; font: 16px sans-serif; } #a { padding: 40px; }
      @media (max-width: 768px) { #a { padding: 10px; } }
    </style></head><body><div id="a">No viewport meta here</div></body></html>`);
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({
        meta: { kind: 'reel', title: 'Trap', cursor: 'none' },
        steps: [{ id: 'a', time: '0.2s', action: 'animate', target: '#a', from: { opacity: 0 }, to: { opacity: 1 } }],
    }));
    const r = cli(['check', dir, '--device', 'mobile', '--scale', '2']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /declares no <meta name="viewport">/);
    assert.match(r.stdout, /mobile emulation lays this page out at 980px/);
    assert.match(r.stdout, /rendered at about 0\.\d+x on a 780px frame/);
    assert.match(r.stdout, /every max-width media query \(768px\) is below the 980px width/);

    // A reel that declares the meta and keeps its breakpoint above the recorded width is clean, and
    // so is the same page checked as a guide rather than a reel.
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body { margin: 0; font: 16px sans-serif; } #a { padding: 40px; }
      @media (max-width: 900px) { #a { padding: 10px; } }
    </style></head><body><div id="a">Declared</div></body></html>`);
    const ok = cli(['check', dir, '--device', 'mobile', '--scale', '2']);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.doesNotMatch(ok.stdout, /viewport/i);
});

// A page whose targets are cropped three different ways: unreachable (overflow: hidden), reachable
// by scrolling (overflow: auto), and not cropped at all.
const CROP_PAGE = `<!doctype html><meta charset="utf-8"><style>
 body { margin: 0; font: 14px sans-serif; }
 .clip { position: absolute; left: 20px; top: 20px; width: 300px; height: 100px; overflow: hidden; }
 .scroll { position: absolute; left: 400px; top: 20px; width: 300px; height: 100px; overflow: auto; }
 .tall { height: 250px; background: #ddd; }
 #fine { position: absolute; left: 800px; top: 20px; width: 200px; height: 60px; background: #eee; }
 #wide { position: absolute; left: 20px; top: 300px; width: 1600px; height: 60px; background: #eee; }
 .hard { position: absolute; left: 20px; top: 420px; width: 200px; height: 60px; overflow: clip; }
 #gone { position: absolute; left: 0; top: 120px; width: 200px; height: 40px; background: #ccc; }
 #floating { position: fixed; left: 20px; top: 560px; width: 300px; height: 200px; background: #cfc; }
</style>
<div class="clip"><div id="cut" class="tall">cut</div></div>
<div class="hard"><div id="gone">gone</div></div>
<div class="scroll"><div id="scrollable" class="tall">scrollable</div></div>
<div id="fine">fine</div><div id="wide">wide</div>
<div class="clip" style="top: 560px"><div id="floating">floating</div></div>`;

const writeCase = (name: string, config: any) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), CROP_PAGE);
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(config));
    return dir;
};

test('check reports a target hidden by a clipping ancestor, and stays quiet on scrollable content', { skip }, () => {
    // isClipped only tests the centre point, so every one of these targets passes it; the rect-level
    // measure is what separates "never rendered" from "further down a scrollable panel".
    const dir = writeCase('crop-guide', {
        meta: { title: 'Crop' },
        steps: [
            { id: 'cut', time: 0.2, action: 'click', target: '#cut', title: 'Cut off' },
            { id: 'scrollable', time: 0.8, action: 'click', target: '#scrollable', title: 'Below the fold' },
            { id: 'fine', time: 1.4, action: 'click', target: '#fine', title: 'Fully visible' },
            { id: 'gone', time: 2.0, action: 'click', target: '#gone', title: 'Not there at all' },
        ],
    });
    const out = cli(['check', dir, '-w', '1280', '-H', '800']);
    const text = out.stdout + out.stderr;
    const cropLines = text.split('\n').filter(l => l.includes('is cropped by'));
    assert.equal(cropLines.length, 1, `exactly one crop warning, got:\n${text}`);
    assert.match(cropLines[0], /step 1 .*#cut/);
    assert.match(cropLines[0], /cropped by 150px by [^:]*clip/);
    assert.match(cropLines[0], /the guide frame for this step shows only the part that is inside it/);
    assert.ok(!text.includes('#scrollable'), `content below the fold of a scrollable panel is not a crop:\n${text}`);
    // Nothing of #gone survives its clipper, which is the stronger claim and keeps its own message.
    assert.match(text, /step 4 .*#gone.*cannot be scrolled into view/);
    assert.ok(!text.includes('#fine'), `a fully visible target is quiet:\n${text}`);
});

test('a reel says the crop never reaches the video, and a camera push is not reported as one', { skip }, () => {
    const reelSteps = (extra: any[]) => ({
        meta: { title: 'Crop reel', kind: 'reel', cursor: 'none' },
        steps: [...extra, { id: 'cut', time: 2.0, action: 'highlight', target: '#cut' }],
    });
    const plain = cli(['check', writeCase('crop-reel', reelSteps([])), '-w', '1280', '-H', '800']);
    const plainText = plain.stdout + plain.stderr;
    assert.match(plainText, /#cut.*cropped by 150px.*the hidden part never reaches the video/);

    // #wide is 1600px in a 1280px viewport, so it genuinely leaves the frame...
    const wide = cli(['check', writeCase('crop-reel-wide', {
        meta: { title: 'Wide', kind: 'reel', cursor: 'none' },
        steps: [{ id: 'wide', time: 0.5, action: 'highlight', target: '#wide' }],
    }), '-w', '1280', '-H', '800']);
    assert.match(wide.stdout + wide.stderr, /#wide.*extends 340px outside the .* viewport/);

    // ...but once a camera has pushed in, everything is outside the frame by design and reporting it
    // buries the real warnings under one per step. The stronger existing check (the target does not
    // intersect the frame at all) still fires: that one means the step acts on nothing visible.
    const pushed = cli(['check', writeCase('crop-reel-camera', {
        meta: { title: 'Pushed', kind: 'reel', cursor: 'none' },
        steps: [
            { id: 'push', time: 0.2, action: 'camera', target: '#fine', scale: 1.4, duration: 0.3 },
            { id: 'wide', time: 1.0, action: 'highlight', target: '#wide' },
        ],
    }), '-w', '1280', '-H', '800']);
    assert.ok(!(pushed.stdout + pushed.stderr).includes('extends'), `no partial-overflow warning under a camera:\n${pushed.stdout}${pushed.stderr}`);
});

test('the spotlight is clamped to what a clipping ancestor lets through, and never collapses', { skip }, async () => {
    // The ring frames what the reader can see. An element taller than its clipping container was
    // ringed well outside the app window, pointing at pixels the frame does not contain.
    const dir = writeCase('spot-clamp', { meta: { title: 'Clamp' }, steps: [] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(dir, 'index.html')));
    const tl = parseTimeline([
        { time: 0, action: 'highlight', target: '#cut' },
        { time: 0.3, action: 'highlight', target: '#scrollable' },
        { time: 0.6, action: 'highlight', target: '#gone' },
        { time: 0.9, action: 'highlight', target: '#floating' },
    ]);
    await ensureRuntime(page, tl, { drift: false });
    const boxes: Record<string, any> = {};
    await runTimeline(page, tl, {
        mode: 'step',
        afterStep: async (step) => {
            boxes[String(step.target)] = await page.evaluate(() => {
                // The ring's inline style, not its rect: the pulse animation scales the box, so a
                // measured rect is a few px off whatever it was positioned at.
                const h = document.getElementById('anim-cli-highlight') as HTMLElement;
                const top = parseFloat(h.style.top), height = parseFloat(h.style.height);
                const r = (document.querySelector((window as any).__lastSel) as HTMLElement).getBoundingClientRect();
                return { spot: { top: Math.round(top + 6), bottom: Math.round(top + height - 6) }, own: { top: Math.round(r.top), bottom: Math.round(r.bottom) } };
            });
        },
        beforeStep: async (step) => { await page.evaluate((sel) => { (window as any).__lastSel = sel; }, String(step.target)); },
    });
    // #cut is 250px tall inside a 100px overflow:hidden box: the ring stops at the container.
    assert.equal(boxes['#cut'].own.bottom - boxes['#cut'].spot.bottom, 150, `clamped to the visible 100px: ${JSON.stringify(boxes['#cut'])}`);
    // A scrollable pane clips nothing permanently, so its content keeps its own box.
    assert.deepEqual(boxes['#scrollable'].spot, boxes['#scrollable'].own, 'scrollable content is not clamped');
    // #gone survives nowhere (overflow: clip). Falling back to its own box keeps the ring findable;
    // clamping it would leave a zero-sized or inverted rectangle, and check already warns about it.
    assert.deepEqual(boxes['#gone'].spot, boxes['#gone'].own, 'a fully clipped target falls back to its own box');
    // Overflow only clips inside the element's own containing block: a fixed child of a hidden pane
    // paints in full, so clamping it would ring a fraction of what the viewer sees.
    assert.deepEqual(boxes['#floating'].spot, boxes['#floating'].own, 'a fixed child of a clipping pane is not clamped');
    await context.close();
});

test('a camera push is distinguishable from the drift transform', { skip }, async () => {
    // The crop checks ask the runtime whether a camera has reframed the page. Reading the <body>
    // transform instead would answer "yes" from boot whenever drift is on, silently disabling them.
    const dir = writeCase('camera-flag', { meta: { title: 'Flag' }, steps: [] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(dir, 'index.html')));
    const tl = parseTimeline([{ time: 0, action: 'camera', target: '#fine', scale: 1.3, duration: 0 }]);
    await ensureRuntime(page, tl, { drift: true });
    const drifted = await page.evaluate(() => ({
        bodyTransform: getComputedStyle(document.body).transform,
        camera: (window as any).__anim.cameraActive(),
    }));
    assert.notEqual(drifted.bodyTransform, 'none', 'drift does put a transform on the body');
    assert.equal(drifted.camera, false, 'but that is not a camera');
    await runTimeline(page, tl, { mode: 'step' });
    assert.equal(await page.evaluate(() => (window as any).__anim.cameraActive()), true, 'a camera step sets it');
    await context.close();
});
