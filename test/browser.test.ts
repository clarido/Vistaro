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
    for (const r of results) {
        assert.equal(r.error, undefined, `step ${r.index}: ${r.error}`);
        assert.ok(Math.abs(r.actualMs - r.scheduledMs) <= 100, `step ${r.index} ${r.action}: actual ${r.actualMs} vs scheduled ${r.scheduledMs}`);
        assert.ok(Number.isFinite(r.completedMs) && r.completedMs! >= r.actualMs, `step ${r.index} completedMs`);
    }
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
