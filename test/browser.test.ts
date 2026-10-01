import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import { parseTimeline } from '../src/engine/schema';
import { buildAnimatedHtml, runtimeSource } from '../src/engine/inject';
import { runTimeline, ensureRuntime } from '../src/engine/driver';
import { fileUrl } from '../src/browser';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
/**
 * A wedged child (a Chromium that will not close, a page stuck mid-navigation) used to hang the
 * whole suite: nothing bounded the wait, and node:test's own default timeout is Infinity. This
 * bound is per CALL, not per test, and it must stay well above the slowest healthy one -- CI runs
 * ~1.4x slower than a local machine and AGENTS.md warns the suite degrades beside other browser
 * jobs -- while staying far under the runner's own --test-timeout, so a wedge is reported here,
 * by name, rather than as the runner cancelling the whole test.
 */
const CLI_TIMEOUT_MS = 300000;

/** spawnSync reports a timeout as error ETIMEDOUT + signal SIGKILL and status null, which an
 *  `assert.equal(res.status, 0)` renders as "expected null to equal 0" -- true, and useless. */
function assertRan(res: { error?: Error; signal?: NodeJS.Signals | null }, args: string[]): void {
    if (res.signal || res.error) {
        const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
        const why = code === 'ETIMEDOUT' ? `did not finish within ${CLI_TIMEOUT_MS}ms and was killed` : `was killed by ${res.signal ?? code}`;
        throw new Error(`cli ${args.join(' ')} ${why}`);
    }
}
const cli = (args: string[], env: Record<string, string> = {}) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, ...env } });
    assertRan(res, args);
    return res;
};

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

test('subtitle chip is sized to the recorded frame (~4% of height) and is scale-stable', { skip }, async () => {
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(fixture, 'anim.config.json'), 'utf8')));
    // No inner functions inside: this whole callback is serialized into the page (AGENTS.md).
    // Computed max-width returns Chromium's unevaluated min() expression, so the wrap width is
    // read back from the custom property sizeSubtitleLayer() set.
    const readChip = () => {
        const chip = document.querySelector('.anim-cli-sub-item') as HTMLDivElement;
        const cs = getComputedStyle(chip);
        const layer = getComputedStyle(document.getElementById('anim-cli-subtitle-layer')!);
        return { fs: parseFloat(cs.fontSize), max: parseFloat(layer.getPropertyValue('--anim-sub-max')), pad: parseFloat(cs.paddingLeft) };
    };
    const subtitleAt = async (width: number, height: number, zoom = 1) => {
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
        const page = await context.newPage();
        await page.goto(fileUrl(path.join(fixture, 'index.html')));
        await ensureRuntime(page, tl, { drift: false, zoom });
        await page.evaluate(() => (window as any).__anim.showSubtitle('Click the primary button.'));
        const styles = await page.evaluate(readChip);
        await context.close();
        return styles;
    };
    // Landscape: 4.2% of frame height (the old fixed 20px was under half of that), wrap width
    // about the old 800px chip of a 1920 render.
    const hd = await subtitleAt(1920, 1080);
    assert.ok(Math.abs(hd.fs - 45.36) < 0.5, `1080p font ~45.36px, got ${hd.fs}`);
    assert.ok(Math.abs(hd.max - 810) < 4, `1080p wrap ~810px, got ${hd.max}`);
    assert.ok(Math.abs(hd.pad - 1.6 * hd.fs) < 1, 'chip paddings follow the font in em');
    const small = await subtitleAt(1280, 720);
    assert.ok(Math.abs(small.fs - 30.24) < 0.5, `720p font ~30.24px, got ${small.fs}`);
    // A scaled recording (viewport x2, :root zoom 2): the same AUTHORED px, painting at 2x in the
    // 2x-denser frame, so the share of the frame does not move. A vw/vh font size doubles here
    // (measured: 4.2vh paints at 8.4% of the frame at --scale 2) -- this pins the compensation.
    const scaled = await subtitleAt(3840, 2160, 2);
    assert.ok(Math.abs(scaled.fs - hd.fs) < 0.5, `scaled font stays ${hd.fs}px authored, got ${scaled.fs}`);
    assert.ok(Math.abs(scaled.max - hd.max) < 4, `scaled wrap stays ${hd.max}px authored, got ${scaled.max}`);
    // Portrait keys on width (6vw) instead of height, and never passes the 40px side gutters.
    const portrait = await subtitleAt(390, 844);
    assert.ok(Math.abs(portrait.fs - 23.4) < 0.5, `portrait font 6vw = 23.4px, got ${portrait.fs}`);
    assert.ok(Math.abs(portrait.max - 310) < 4, `portrait wrap <= w - 80 = 310px, got ${portrait.max}`);
    // Small windows keep a 20px floor.
    const tiny = await subtitleAt(600, 400);
    assert.ok(Math.abs(tiny.fs - 20) < 0.5, `tiny window floor 20px, got ${tiny.fs}`);
});

test('subtitle chip re-sizes when the viewer resizes the window (animated.html)', { skip }, async () => {
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(fixture, 'anim.config.json'), 'utf8')));
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.goto(fileUrl(path.join(fixture, 'index.html')));
    await ensureRuntime(page, tl, { drift: false });
    await page.evaluate(() => (window as any).__anim.showSubtitle('Welcome.'));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(100);
    const fontPx = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.anim-cli-sub-item')!).fontSize));
    assert.ok(Math.abs(fontPx - 30.24) < 0.5, `font follows a window resize to 30.24px, got ${fontPx}`);
    await context.close();
});

test('subtitle chip dodges the spotlighted target and the cursor', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0">
        <button id="bottom-mid" style="position:fixed; left:490px; bottom:70px; width:300px; height:50px;">Save</button>
        <button id="top-mid" style="position:fixed; left:490px; top:40px; width:300px; height:50px;">Menu</button>
    </body></html>`);
    const tl = parseTimeline({ meta: { cursor: 'mac' }, steps: [] });
    await ensureRuntime(page, tl, { drift: false });
    const placeOf = () => document.querySelector('.anim-cli-sub-item')!.getAttribute('data-place');
    const clearOf = (sel: string) => {
        const chip = document.querySelector('.anim-cli-sub-item')!.getBoundingClientRect();
        const el = document.querySelector(sel)!.getBoundingClientRect();
        return chip.left >= el.right + 16 || chip.right <= el.left - 16 || chip.top >= el.bottom + 16 || chip.bottom <= el.top - 16;
    };
    // Nothing on screen to protect: the cue sits at its home position.
    await page.evaluate(() => (window as any).__anim.showSubtitle('Watch closely.'));
    assert.equal(await page.evaluate(placeOf), 'bottom');
    // A highlight landing under the chip pushes the held cue to the top band, clear of the button.
    await page.evaluate(() => (window as any).__anim.highlight(document.getElementById('bottom-mid')));
    assert.equal(await page.evaluate(placeOf), 'top');
    assert.equal(await page.evaluate(clearOf, '#bottom-mid'), true, 'chip is clear of the spotlighted button');
    // The obstacle model protects the CURRENT spotlight: once the ring moves to the top button the
    // bottom band is clear again and the chip comes home instead of hiding in a corner forever.
    await page.evaluate(() => (window as any).__anim.highlight(document.getElementById('top-mid')));
    assert.equal(await page.evaluate(placeOf), 'bottom');
    // Both bands blocked at once (spotlight on top, cursor parking on the bottom band): the chip
    // takes the first clear corner.
    await page.evaluate(() => (window as any).__anim.moveCursor(640, 700, 10));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(placeOf), 'bottom-left');
    assert.equal(await page.evaluate(clearOf, '#top-mid'), true, 'chip is clear of the top button');
    // The cursor moving onto the corner chip moves it again -- back home, now that the bottom
    // band's only blocker was that same cursor.
    await page.evaluate(() => (window as any).__anim.moveCursor(200, 700, 10));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(placeOf), 'bottom');
    await context.close();
});

test('a reel draws the stadium bar: near-opaque capsule, 5% of frame height, one-line-first wrap', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 810 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0"><p>Clarido</p></body></html>`);
    const tl = parseTimeline({ meta: { kind: 'reel', reel: { subtitles: true } }, steps: [] });
    await ensureRuntime(page, tl, { drift: false });
    // Short enough that ONE line holds in any metric font stack CI may resolve sans-serif to
    // (DejaVu bold runs ~10% wider than SF; a 38-char sentence was within 4% of the wrap bound).
    await page.evaluate(() => (window as any).__anim.showSubtitle('Clarido prépare la soumission.'));
    const styles = await page.evaluate(() => {
        const layer = document.getElementById('anim-cli-subtitle-layer')!;
        const chip = document.querySelector('.anim-cli-sub-item') as HTMLDivElement;
        const cs = getComputedStyle(chip);
        const lines = Math.round((chip.offsetHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
        return {
            cls: layer.className,
            bg: cs.backgroundColor,
            radiusPx: parseFloat(cs.borderRadius),
            shadow: cs.boxShadow,
            blur: cs.backdropFilter,
            weight: cs.fontWeight,
            fs: parseFloat(cs.fontSize),
            max: parseFloat(getComputedStyle(layer).getPropertyValue('--anim-sub-max')),
            lines: lines,
        };
    });
    assert.equal(styles.cls, 'anim-cli-sub-stadium', 'the layer carries the reel style class');
    assert.equal(styles.bg, 'rgba(15, 18, 24, 0.92)', 'near-opaque: separation by construction, nothing showing through');
    assert.equal(styles.shadow, 'none');
    assert.equal(styles.blur, 'none', 'no backdrop blur to dither in the GIF or merge with dark cards');
    assert.equal(styles.weight, '600');
    assert.ok(Math.abs(styles.fs - 40.5) < 0.5, `reel font 5% of 810 = 40.5px, got ${styles.fs}`);
    assert.ok(Math.abs(styles.radiusPx - 999 * styles.fs) < 5, `stadium radius 999em = ${999 * styles.fs}px, got ${styles.radiusPx}`);
    assert.ok(Math.abs(styles.max - 0.58 * 1440) < 4, `one-line-first wrap 58% of width = 835px, got ${styles.max}`);
    assert.equal(styles.lines, 1, 'the 40-char payoff cue sits on one line instead of the glass chip\'s two');
    await context.close();
});

test('a camera push makes the chip dodge the content it framed; a pull-back lets it come home', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    // The camera centring law puts the step's target mid-frame; content around it slides toward
    // the frame edges. Targeting the TOP of a card column leaves the upper frame background and
    // pushes the column through the whole lower frame -- under the chip's bottom home.
    const cards = Array.from({ length: 8 }, () => `<div style="height:100px; margin:0 20px 16px; background:#fff; border:1px solid #dde;"></div>`).join('');
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0">
        <div style="height:400px"></div>
        <div id="cards" style="width:900px; margin:0 auto; background:#eef2f7; padding:20px 0;">
            <div id="first" style="height:100px; margin:0 20px 16px; background:#fff; border:1px solid #dde;"></div>${cards}
        </div>
    </body></html>`);
    const tl = parseTimeline({ meta: { cursor: 'none' }, steps: [] });
    await ensureRuntime(page, tl, { drift: false, cursor: 'none' });
    // runStep's driven guard requires a started clock; ensureRuntime only boots.
    await page.evaluate(() => (window as any).__anim.start());
    const placeOf = () => document.querySelector('.anim-cli-sub-item')!.getAttribute('data-place');
    // No camera yet: the cue sits at its home position over the un-pushed column.
    await page.evaluate(() => (window as any).__anim.showSubtitle('Les pièces à joindre.'));
    assert.equal(await page.evaluate(placeOf), 'bottom');
    // The 1.3x push onto the top of the column frames content across the lower frame: the cue
    // must leave the bottom band for the free top band.
    await page.evaluate(() => (window as any).__anim.runStep({ index: 1, id: 'zoom', time: 1, action: 'camera', target: '#first', scale: 1.3, duration: 0 }, { instant: true }));
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(placeOf), 'top', 'the chip dodges the framed content, not just the centred target');
    // A pull-back shows the whole page again (a held chip would keep its clear top spot by
    // design), so prove the framed obstacle is gone with a FRESH cue, which always re-evaluates
    // from the bottom home: nothing may block it there any more.
    await page.evaluate(() => (window as any).__anim.runStep({ index: 2, id: 'back', time: 2, action: 'camera', target: '#first', scale: 1, duration: 0 }, { instant: true }));
    await page.waitForTimeout(50);
    await page.evaluate(() => (window as any).__anim.showSubtitle('Repartons du bas.'));
    assert.equal(await page.evaluate(placeOf), 'bottom', 'after a pull-back a fresh cue sits home again');
    await context.close();
});

test('subtitlePlace pins the cue where the author put it; the collision is still reported', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    const cards = Array.from({ length: 8 }, () => `<div style="height:100px; margin:0 20px 16px; background:#fff; border:1px solid #dde;"></div>`).join('');
    await page.setContent(`<!doctype html><html><head></head><body style="margin:0">
        <div style="height:400px"></div>
        <div id="cards" style="width:900px; margin:0 auto; background:#eef2f7; padding:20px 0;">
            <div id="first" style="height:100px; margin:0 20px 16px; background:#fff; border:1px solid #dde;"></div>${cards}
        </div>
    </body></html>`);
    const tl = parseTimeline({ meta: { cursor: 'none' }, steps: [] });
    await ensureRuntime(page, tl, { drift: false, cursor: 'none' });
    await page.evaluate(() => (window as any).__anim.start());
    const placeOf = () => document.querySelector('.anim-cli-sub-item')!.getAttribute('data-place');
    await page.evaluate(() => (window as any).__anim.runStep({ index: 1, id: 'zoom', time: 1, action: 'camera', target: '#first', scale: 1.3, duration: 0 }, { instant: true }));
    await page.waitForTimeout(50);
    // The pin overrides the dodge even where the dodge would move: the author knows the composition.
    await page.evaluate(() => (window as any).__anim.showSubtitle('Pinned en bas.', 4000, 'bottom'));
    assert.equal(await page.evaluate(placeOf), 'bottom', 'the pin keeps the bottom despite the framed content');
    // A mid-hold recheck (a highlight landing) must not move a pinned cue either.
    await page.evaluate(() => (window as any).__anim.highlight(document.getElementById('first')));
    assert.equal(await page.evaluate(placeOf), 'bottom');
    // And check still sees the truth: the pinned chip covers the framed content.
    const hits: { what: string }[] | null = await page.evaluate(() => (window as any).__anim.subtitleCollisions());
    assert.ok(hits && hits.some(h => h.what === 'framed content'), `collisions name the framed content, got ${JSON.stringify(hits)}`);
    // The next cue, unpinned, dodges again; an unknown place value is ignored, not fatal.
    await page.evaluate(() => (window as any).__anim.showSubtitle('Libre.'));
    assert.equal(await page.evaluate(placeOf), 'top');
    await page.evaluate(() => (window as any).__anim.showSubtitle('Ignoré.', 4000, 'middle'));
    assert.equal(await page.evaluate(placeOf), 'top', 'an unvalidated place falls back to the dodge, not an error');
    await context.close();
});

test('meta.subtitleScale multiplies the automatic subtitle size', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><head></head><body style="margin:0"><p>Hello</p></body></html>');
    const tl = parseTimeline({ meta: { subtitleScale: 1.5 }, steps: [] });
    await ensureRuntime(page, tl, { drift: false });
    await page.evaluate(() => (window as any).__anim.showSubtitle('A bigger cue.'));
    const chip = await page.evaluate(() => {
        const el = document.querySelector('.anim-cli-sub-item')!;
        const cs = getComputedStyle(el);
        const layer = getComputedStyle(document.getElementById('anim-cli-subtitle-layer')!);
        return { fs: parseFloat(cs.fontSize), max: parseFloat(layer.getPropertyValue('--anim-sub-max')) };
    });
    assert.ok(Math.abs(chip.fs - 68.04) < 0.5, `1.5 x 45.36px = 68.04px, got ${chip.fs}`);
    assert.ok(Math.abs(chip.max - 1215) < 4, `wrap width scales with the font (810 x 1.5), got ${chip.max}`);
    await context.close();
});

test('subtitle dodge follows the real step path (lastSpot) and is zoom-stable', { skip }, async () => {
    const tl = parseTimeline({ meta: { cursor: 'mac' }, steps: [
        { id: 'hit', time: '0s', action: 'click', target: '#band-btn', subtitle: 'Publish the response now.' },
    ] });
    const run = async (width: number, height: number, zoom: number) => {
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
        const page = await context.newPage();
        await page.setContent(`<!doctype html><html><head></head><body style="margin:0">
            <button id="band-btn" style="position:absolute; left:490px; top:690px; width:300px; height:50px;">Save</button>
        </body></html>`);
        await ensureRuntime(page, tl, { drift: false, zoom });
        await page.evaluate(() => (window as any).__anim.start());
        const result = await page.evaluate((s: any) => (window as any).__anim.runStep(s, { leadMs: 120 }), tl.steps[0]);
        // getBoundingClientRect here (not offset*): both boxes are settled by now, and the visual
        // rects are what the viewer sees -- the clearest possible statement of "does not cover".
        const out = await page.evaluate(() => {
            const chip = document.querySelector('.anim-cli-sub-item')!.getBoundingClientRect();
            const btn = document.getElementById('band-btn')!.getBoundingClientRect();
            return {
                place: document.querySelector('.anim-cli-sub-item')!.getAttribute('data-place'),
                clear: chip.right <= btn.left || chip.left >= btn.right || chip.bottom <= btn.top || chip.top >= btn.bottom,
            };
        });
        await context.close();
        return { ...out, error: result.error };
    };
    // The path every real export takes: runStep sets lastSpot at step start, so the chip dodges
    // before the cursor arrives -- not only via the primitives API.
    const one = await run(1280, 800, 1);
    assert.equal(one.error, undefined, `step failed: ${one.error}`);
    assert.equal(one.place, 'top');
    assert.equal(one.clear, true, 'chip does not cover the bottom-band target');
    // A 2x scaled recording: the same authored decision, painted rectangles still clear.
    const two = await run(2560, 1600, 2);
    assert.equal(two.error, undefined, `step failed at zoom 2: ${two.error}`);
    assert.equal(two.place, 'top');
    assert.equal(two.clear, true, 'chip does not cover the target at zoom 2');
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
    // Camera steps now also emit a framing-facts info issue (asserted in its own test below); the
    // spotlight fallback stays the only other info on this fixture.
    assert.deepEqual(okJson.filter((i: any) => !i.framing).map((i: any) => [i.level, i.step, i.highlightFallback]), [['info', 9, '#log']]);
    assert.equal(okJson.filter((i: any) => i.framing).length, 2, 'both camera steps report their framing');

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

// A page built for framing math: three named columns across a 1600px body, so a 1280x800 viewport
// at scale 2 leaves a 640x400 window. The body is deliberately WIDER than the viewport: its box
// centre (800) is not the viewport's (640), which is exactly the case the camera's centring used
// to miss (transform-origin is the body box's centre, not the viewport's).
const FRAMING_PAGE = `<!doctype html><meta charset="utf-8"><style>
 body { margin: 0; font: 14px sans-serif; width: 1600px; height: 800px; }
 #side { position: absolute; left: 0; top: 0; width: 280px; height: 800px; background: #eee; }
 #chart { position: absolute; left: 280px; top: 0; width: 720px; height: 800px; background: #dfd; }
 #chart h2 { margin: 20px; font-size: 18px; }
 #panel { position: absolute; left: 1000px; top: 0; width: 600px; height: 800px; background: #fdd; }
</style>
<div id="side"><p>Side column</p></div>
<div id="chart"><h2>Chart</h2><p>Chart body</p></div>
<div id="panel"><p>Panel</p></div>`;

const writeFraming = (name: string, html: string, config: any) => {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(config));
    return dir;
};

test('check reports camera framing as facts, and the structured report rides --json', { skip }, () => {
    // #chart's centre (640,400) is exactly the viewport's centre; a scale-2 push must leave a
    // 640x400 window centred on it, i.e. at (320, 200). The window coordinate is the regression
    // assertion for the centring fix: the old translate landed it at (400, 200) on this page.
    const dir = writeFraming('framing-centred', FRAMING_PAGE, {
        meta: { title: 'Framing' },
        steps: [
            { id: 'push', time: 0.3, action: 'camera', target: '#chart', scale: 2, duration: 0.3 },
            { id: 'wider', time: 1.0, action: 'camera', target: '#chart', scale: 1.1, duration: 0.3 },
        ],
    });
    const r = cli(['check', dir, '-w', '1280', '-H', '800']);
    const text = r.stdout + r.stderr;
    assert.equal(r.status, 0, text);
    assert.match(text, /step 1 .*framing after the move: scale 2, window 640x400 at \(320, 200\)/);
    // The 640x400 window sits INSIDE the 720x800 chart: the chart covers all of the window, the
    // window shows less than half of the chart. Both facts in one line.
    assert.match(text, /step 1 .*target div#chart .* \(\d+% visible, 100% of the window\)/);
    assert.match(text, /step 1 .*content coverage 100%/);
    // The gentler push frames the neighbours too, and says where it cuts through them.
    assert.match(text, /step 2 .*cut by the frame edge: .*#side.*\(left \d+px\), .*#panel.*\(right \d+px\)/);
    // Nothing is wrong with either framing, so nothing escalates past info.
    assert.ok(!text.includes('background'), `a framed push is not reported as background:\n${text}`);

    // The same facts, structured, on the info issue for machine consumers.
    const j = JSON.parse(cli(['check', dir, '-w', '1280', '-H', '800', '--json']).stdout);
    const framings = j.filter((i: any) => i.framing);
    assert.equal(framings.length, 2, `one framing report per camera step:\n${JSON.stringify(j, null, 2)}`);
    assert.equal(framings[0].framing.scale, 2);
    assert.deepEqual(framings[0].framing.window, { x: 320, y: 200, w: 640, h: 400 });
    assert.ok(framings[0].framing.inFrame.some((f: any) => f.name.startsWith('div#chart')), `chart named in frame:\n${JSON.stringify(framings[0].framing)}`);
});

test('check warns when a zoom frames mostly background (the "wrong place" smell)', { skip }, () => {
    const config = {
        meta: { title: 'Empty' },
        steps: [{ id: 'zoom', time: 0.3, action: 'camera', target: '#btn', scale: 2, duration: 0.3 }],
    };
    const islands = writeFraming('framing-empty', `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 14px sans-serif; }</style>
<button id="btn" style="position:absolute;left:600px;top:380px;width:80px;height:30px">Save</button>
<div id="far" style="position:absolute;left:20px;top:20px;width:200px;height:60px">Elsewhere</div>`, config);
    const r = cli(['check', islands, '-w', '1280', '-H', '800']);
    const text = r.stdout + r.stderr;
    // A warning, never an error: framing onto empty space can be deliberate.
    assert.equal(r.status, 0, text);
    assert.match(text, /step 1 .*zoomed window is 9\d% background/);
    assert.match(text, /check that the camera target is the element to show/);

    // The common mockup shape wraps the blocks in a full-viewport container. A wrapper that paints
    // nothing is layout, not content: it must not make an empty corner read as full. vw/vh keep the
    // wrapper a real full box even under the camera's transform on <body> (which becomes the
    // containing block for its absolutely-positioned children).
    const wrapped = writeFraming('framing-wrapped', `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 14px sans-serif; }
 #app { position: absolute; inset: 0; width: 100vw; height: 100vh; display: flex; }</style>
<div id="app">
  <button id="btn" style="position:absolute;left:600px;top:380px;width:80px;height:30px">Save</button>
  <div id="far" style="position:absolute;left:20px;top:20px;width:200px;height:60px">Elsewhere</div>
</div>`, config);
    const w = cli(['check', wrapped, '-w', '1280', '-H', '800']);
    assert.match(w.stdout + w.stderr, /step 1 .*zoomed window is 9\d% background/);
});

test('check warns when an animate reveal is not pre-hidden in CSS, and stays quiet when it is', { skip }, () => {
    // The reel authoring trap: `from` applies when the step runs, not at page load, so an element
    // that is not pre-hidden sits fully visible until the step's time and then pops out and back.
    // `how` picks the page's shape: '' shows the trap; the others are legitimate pre-hides.
    const page = (how: string) => `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 16px sans-serif; }
 #wrap { ${how === 'wrap' ? 'opacity: 0;' : ''}${how === 'wraptransform' ? 'transform: scale(0);' : ''} }
 #card { position: absolute; left: 50%; top: 50%; width: 400px; height: 200px; background: #eee; padding: 20px;
   transform: translate(-50%, -50%);${how === 'own' ? ' opacity: 0;' : ''}${how === 'transform' ? ' transform: scale(0);' : ''} }
</style><div id="wrap"><div id="card"><h2>Card</h2><p>Content</p></div></div>`;
    const config = { meta: { title: 'Reveal' }, steps: [{ id: 'show', time: 0.6, action: 'animate', target: '#card', from: { opacity: 0 }, to: { opacity: 1 } }] };
    const bad = cli(['check', writeFraming('reveal-visible', page(''), config), '-w', '1280', '-H', '800']);
    assert.match(bad.stdout + bad.stderr, /step 1 .*is fully visible right now, but this step animates it from opacity 0/);
    assert.match(bad.stdout + bad.stderr, /Pre-hide it in CSS \(opacity 0\)/);
    // Hidden is hidden however it was achieved: the card's own opacity, a wrapper's opacity or a
    // collapsed scale(0) (the card's or a wrapper's) -- none of them flash, so none of them warn.
    // The centered card carries translate(-50%, -50%), which hides nothing: the trap still warns
    // through it, and only a transform that actually collapses the element silences the warning.
    for (const how of ['own', 'wrap', 'transform', 'wraptransform'] as const) {
        const good = cli(['check', writeFraming(`reveal-${how}`, page(how), config), '-w', '1280', '-H', '800']);
        const goodText = good.stdout + good.stderr;
        assert.ok(!goodText.includes('Pre-hide'), `pre-hidden via ${how} is quiet:\n${goodText}`);
    }
});

test('check warns when the subtitle chip has nowhere left to dodge', { skip }, () => {
    // A target covering the whole frame leaves the chip no clear placement: reflowSubtitle takes
    // the least-bad one, and that fact is exactly what an author needs to hear about.
    const dir = writeFraming('subtitle-crowded', `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 14px sans-serif; }
 #all { position: absolute; inset: 0; background: #eee; }</style>
<div id="all">Everything</div>`, {
        meta: { title: 'Crowded', cursor: 'none' },
        steps: [{ id: 'h', time: 0.3, action: 'highlight', target: '#all', subtitle: 'A chip with nowhere to go.' }],
    });
    const r = cli(['check', dir, '-w', '1280', '-H', '720']);
    assert.match(r.stdout + r.stderr, /step 1 .*subtitle chip covers the spotlight target/);
});

test('a multi-match warning names the element the selector resolved to', { skip }, () => {
    const dir = writeFraming('multi-match', `<!doctype html><meta charset="utf-8"><style>body { margin: 0; font: 14px sans-serif; }
 .row { width: 300px; height: 40px; margin: 10px; background: #eee; }</style>
<div class="row">First row</div><div class="row">Second row</div>`, {
        meta: { title: 'Multi' },
        steps: [{ id: 'c', time: 0.3, action: 'click', target: '.row' }],
    });
    const r = cli(['check', dir, '-w', '1280', '-H', '800']);
    assert.match(r.stdout + r.stderr, /matches 2 elements; the first one is used: div\.row "First row"/);
});

test('camera xOffset/yOffset nudge the framing after the centre is solved', { skip }, () => {
    // #chart's centre is the viewport's centre on this 1600px body, so a scale-2 push centres a
    // 640x400 window at (320, 200). The offsets move the focus right 100 / up 50 -- the window
    // travels with it -- and apply equally to a bare push with no target and no x/y, whose centre
    // rests on the BODY box's centre (window at (400, 200) before the nudge).
    const dir = writeFraming('framing-offset', FRAMING_PAGE, {
        meta: { title: 'Offset' },
        steps: [
            { id: 'push', time: 0.3, action: 'camera', target: '#chart', scale: 2, duration: 0.3, xOffset: 100, yOffset: -50 },
            { id: 'bare', time: 1.0, action: 'camera', scale: 2, duration: 0.3, xOffset: 100 },
        ],
    });
    const r = cli(['check', dir, '-w', '1280', '-H', '800']);
    const text = r.stdout + r.stderr;
    assert.equal(r.status, 0, text);
    assert.match(text, /step 1 .*window 640x400 at \(420, 150\)/);
    assert.match(text, /step 2 .*window 640x400 at \(500, 200\)/);
    // The nudged window still frames the chart's right part: the target line says how much of it.
    assert.match(text, /step 1 .*target div#chart .* \(\d+% visible/);
});

test('check --trace records per-step cursor, spotlight, subtitle and camera geometry', { skip }, () => {
    const dir = path.join(work, 'trace-basic');
    fs.cpSync(fixture, dir, { recursive: true });
    const r = cli(['check', dir, '--trace']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const traceFile = path.join(dir, 'trace.json');
    assert.ok(fs.existsSync(traceFile), 'trace.json written beside the config');
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    assert.equal(trace.steps.length, 9, 'one record per step');
    assert.ok(trace.steps.every((s: any) => s.cursor === null || Number.isFinite(s.cursor.x)), 'cursor records are points or null');
    const zoom = trace.steps.find((s: any) => s.id === 'zoom');
    assert.ok(zoom && zoom.camera && zoom.camera.scale === 1.3 && zoom.camera.window.w > 0, `the camera step records its window: ${JSON.stringify(zoom)}`);
    const open = trace.steps.find((s: any) => s.id === 'open');
    assert.ok(open && open.cursor && open.spotlight, `a click step records cursor and spotlight: ${JSON.stringify(open)}`);
    // A plain run writes no trace at all.
    const plain = path.join(work, 'trace-plain');
    fs.cpSync(fixture, plain, { recursive: true });
    cli(['check', plain]);
    assert.ok(!fs.existsSync(path.join(plain, 'trace.json')), 'no --trace, no file');
});

test('preview --motion samples a real playback pass into preview-motion.png', { skip }, () => {
    const dir = path.join(work, 'motion-basic');
    fs.cpSync(fixture, dir, { recursive: true });
    const r = cli(['preview', dir, '--motion', '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = path.join(dir, 'preview-motion.png');
    assert.ok(fs.existsSync(out));
    assert.ok(fs.statSync(out).size > 10000, `the sheet carries real tiles: ${fs.statSync(out).size} bytes`);
    assert.match(r.stdout, /frames sampled during playback/);
    // The step sheet is this pass's complement, not its replacement on disk: motion writes its own file.
    assert.ok(!fs.existsSync(path.join(dir, 'preview.png')), 'the step sheet is not written by the motion pass');
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

test('restart() re-executes classic body scripts, so addEventListener wiring survives a replay', { skip }, async () => {
    // cloneNode keeps attributes but not listeners, and a re-appended script clone never executes:
    // after a tour seek or a loop restart, a mockup whose click steps rely on page-side handlers
    // silently stopped working (the click fired into a fresh button nobody had wired).
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    try {
        await page.setContent(`<!doctype html><html><head><style>button { padding: 10px 20px; }</style></head><body>
            <button id="btn">Go</button><input id="field">
            <div id="wrap"><section>
              <button id="nested-btn">Nested</button>
              <script>
                window.__nestedWired = (window.__nestedWired || 0) + 1;
                document.getElementById('nested-btn').addEventListener('click', function () {
                    window.__nestedClicks = (window.__nestedClicks || 0) + 1;
                });
              </script>
            </section></div>
            <script>
                window.__wired = (window.__wired || 0) + 1;
                document.getElementById('btn').addEventListener('click', function () {
                    window.__clicks = (window.__clicks || 0) + 1;
                });
            </script>
            <script data-anim-rerun="false">
                window.__optoutRan = (window.__optoutRan || 0) + 1;
            </script>
        </body></html>`);
        const timeline = parseTimeline({ meta: { cursor: 'none' }, steps: [{ id: 'go', time: 0.5, action: 'click', target: '#btn' }] });
        // Boot like a tour page: a timeline (so a snapshot is taken) under autoplay 'message', so
        // nothing self-plays and the test owns every runStep.
        await page.addScriptTag({ content: runtimeSource() });
        await page.evaluate((tl) => (window as any).__anim.boot({ cursor: 'none', autoplay: 'message', timeline: tl }), { meta: {}, steps: timeline.steps });
        await page.waitForFunction(() => (window as any).__anim.isReady());
        assert.equal(await page.evaluate(() => (window as any).__wired), 1);
        assert.equal(await page.evaluate(() => (window as any).__optoutRan), 1);

        const r1: any = await page.evaluate((s) => (window as any).__anim.runStep(s, { leadMs: 0 }), timeline.steps[0]);
        await page.evaluate((t) => (window as any).__anim.whenDone(t), r1.token);
        assert.equal(await page.evaluate(() => (window as any).__clicks), 1, 'the page\'s own listener ran via el.click()');

        await page.evaluate(() => (window as any).__anim.restart());
        assert.equal(await page.evaluate(() => (window as any).__wired), 2, 'the classic script re-executed on the rebuilt DOM');
        assert.equal(await page.evaluate(() => (window as any).__nestedWired), 2, 'a script NESTED in a wrapper element re-executed too (screens live in sections)');
        assert.equal(await page.evaluate(() => (window as any).__optoutRan), 1, 'the data-anim-rerun="false" script did not');
        const r2: any = await page.evaluate((s) => (window as any).__anim.runStep(s, { leadMs: 0 }), timeline.steps[0]);
        await page.evaluate((t) => (window as any).__anim.whenDone(t), r2.token);
        assert.equal(await page.evaluate(() => (window as any).__clicks), 2, 'the listener on the FRESH button fires after the restart');
        // The nested script's own wiring works again on the rebuilt DOM (a click step targets it).
        const r3: any = await page.evaluate((s) => (window as any).__anim.runStep({ ...s, target: '#nested-btn' }, { leadMs: 0 }), timeline.steps[0]);
        await page.evaluate((t) => (window as any).__anim.whenDone(t), r3.token);
        assert.equal(await page.evaluate(() => (window as any).__nestedClicks), 1, 'the nested section\'s listener fires on the fresh clone');
    } finally {
        await context.close();
    }
});

test('runtime timers and intervals remove themselves once fired (no unbounded growth)', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    try {
        await page.setContent('<!doctype html><html><body><button id="btn">Go</button><input id="field"></body></html>');
        const timeline = parseTimeline({ meta: { cursor: 'mac' }, steps: [
            { id: 'a', time: 0.1, action: 'click', target: '#btn' },
            { id: 'b', time: 0.2, action: 'type', target: '#field', value: 'Hello there', cps: 40 },
            { id: 'c', time: 0.3, action: 'camera', target: '#field', scale: 1.2, duration: 0.3 },
            { id: 'd', time: 0.4, action: 'highlight', target: '#btn' },
        ] });
        await page.addScriptTag({ content: runtimeSource() });
        await page.evaluate((tl) => (window as any).__anim.boot({ autoplay: 'message', timeline: tl }), { meta: {}, steps: timeline.steps });
        await page.waitForFunction(() => (window as any).__anim.isReady());
        for (const s of timeline.steps) {
            const r: any = await page.evaluate((st) => (window as any).__anim.runStep(st, { leadMs: 0 }), s);
            await page.evaluate((t) => (window as any).__anim.whenDone(t), r.token);
        }
        await page.waitForTimeout(500); // let every fired timer's self-removal callback run
        const handles: any = await page.evaluate(() => (window as any).__anim.pendingHandles());
        assert.equal(handles.timers, 0, `pending timers after a 4-step run: ${JSON.stringify(handles)}`);
        assert.equal(handles.intervals, 0, 'pending intervals after a type step');
    } finally {
        await context.close();
    }
});
