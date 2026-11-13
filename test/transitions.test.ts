import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser, BrowserContext } from 'playwright';
import { parseTimeline, validateTimeline, intrinsicDurationMs, captureAtFor, TRANSITIONS, DEFAULT_TRANSITION_MS } from '../src/engine/schema';
import { buildAnimatedHtml, buildTourPage } from '../src/engine/inject';
import { fileUrl } from '../src/browser';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';
import { countOrphans, assertNoNewOrphans } from './orphans';

/**
 * Lot 2 of docs/next-level-plan.md: transitionScreen's `transition` (fade, cut, crossfade, slide,
 * push) and the `overlay` action. The invariant every test leans on: whichever transition runs,
 * and whether it runs in real time, instantly, under a tour seek or under reduced motion, the page
 * ends in ONE state -- so guide frames, seeks and the next step never depend on the motion.
 */

const root = path.resolve(__dirname, '..');
const skip = process.env.SKIP_BROWSER === '1';
const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};

/** Two screens in a panel beside a sidebar (so slide/push must clip to the panel), and a modal centred with its own transform. */
const SCREENS_HTML = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; display: flex; height: 100vh; }
  aside { width: 200px; background: #eee; }
  main { flex: 1; position: relative; }
  .screen { height: 100%; padding: 24px; box-sizing: border-box; }
  #s1 { background: #dbeafe; }
  #s2 { background: #fde68a; display: none; }
  #modal { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 300px; height: 160px; background: #fff; display: none; z-index: 10; }
  #toast { position: fixed; top: 16px; right: 16px; background: #111; color: #fff; padding: 8px; display: none; }
</style></head><body>
  <aside>nav</aside>
  <main><section id="s1" class="screen">One</section><section id="s2" class="screen">Two</section></main>
  <div id="modal">Modal</div><div id="toast">Saved</div>
</body></html>`;

// ---------------------------------------------------------------------------------- static

test('transitions: estimates, capture points, and the composition warnings', () => {
    const tl = parseTimeline({ steps: [
        { id: 'fade', time: 0, action: 'transitionScreen', target: '#s2' },
        { id: 'cut', time: 1, action: 'transitionScreen', target: '#s1', transition: 'cut' },
        { id: 'slide', time: 2, action: 'transitionScreen', target: '#s2', transition: 'slide', direction: 'up' },
        { id: 'dir', time: 3, action: 'transitionScreen', target: '#s1', transition: 'crossfade', direction: 'left' },
        { id: 'zoom', time: 4, action: 'camera', target: '#s1', scale: 1.3 },
        { id: 'push', time: 5, action: 'transitionScreen', target: '#s2', transition: 'push' },
        { id: 'back', time: 6, action: 'camera', scale: 1 },
        { id: 'push2', time: 7, action: 'transitionScreen', target: '#s1', transition: 'push' },
        { id: 'modal', time: 8, action: 'overlay', target: '#modal' },
        { id: 'bad', time: 9, action: 'overlay', target: '#modal', variant: 'popover', scrim: 3 },
        { id: 'stray', time: 10, action: 'click', target: '#s1', transition: 'cut' },
    ] });
    const by = (id: string) => tl.steps.find(s => s.id === id)!;
    assert.equal(intrinsicDurationMs(by('fade')), 800, 'the default is still the historical 0.8 s fade');
    assert.equal(intrinsicDurationMs(by('cut')), 0);
    assert.equal(intrinsicDurationMs(by('slide')), DEFAULT_TRANSITION_MS);
    assert.equal(intrinsicDurationMs(by('modal')), 300);
    assert.equal(captureAtFor(by('modal')), 'completion', 'an overlay is captured once it has settled');
    const issues = validateTimeline(tl).filter(i => i.level !== 'info' && i.field !== 'title');
    const of = (id: string) => issues.filter(i => i.id === id).map(i => `${i.level}: ${i.message}`).join('\n');
    assert.equal(of('fade') + of('cut') + of('slide') + of('push2') + of('modal'), '', 'well-formed steps are clean');
    assert.match(of('dir'), /warning: "direction" does nothing on a "crossfade" transition/);
    assert.match(of('push'), /warning: a "push" runs under an active camera push \(scale 1\.3\)/);
    assert.match(of('bad'), /error: "variant" must be one of/);
    assert.match(of('bad'), /error: "scrim" must be true, false, or a CSS colour/);
    assert.match(of('stray'), /warning: "transition" only applies to "transitionScreen"/);
});

// --------------------------------------------------------------------------------- browser

let browser: Browser;
let orphanBaseline = -1;
let work: string;

before(async () => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-transitions-'));
    fs.writeFileSync(path.join(work, 'index.html'), SCREENS_HTML);
    orphanBaseline = countOrphans();
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    if (browser) {
        await browser.close();
        assertNoNewOrphans(orphanBaseline, 'transitions.test.ts');
    }
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

/** A driven page of SCREENS_HTML with the runtime booted and its clock started. */
async function openPage(context: BrowserContext) {
    const tl = parseTimeline({ steps: [] });
    const file = path.join(work, 'driven.html');
    // No drift: its 16 s body transition would be a running animation in every state read below.
    fs.writeFileSync(file, buildAnimatedHtml(SCREENS_HTML, tl, { cursor: 'none', drift: false }));
    const page = await context.newPage();
    await page.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    await page.goto(fileUrl(file));
    await page.waitForFunction(() => (window as any).__anim?.isReady());
    await page.evaluate(() => (window as any).__anim.start());
    return page;
}

/** What "the right screen is showing" means, read from computed styles plus what a transition might
 *  leave inline. No inner functions: this is serialized into the page (AGENTS.md page.evaluate rule). */
const SCREEN_STATE = () => {
    const out: Record<string, unknown> = { mainClip: (document.querySelector('main') as HTMLElement).style.clipPath, animations: document.getAnimations().length };
    for (const id of ['s1', 's2']) {
        const el = document.getElementById(id)!;
        const cs = getComputedStyle(el);
        out[id] = { display: cs.display, opacity: cs.opacity, translate: cs.translate, position: cs.position, zIndex: el.style.zIndex };
    }
    return out;
};

test('every transition, played or instant, ends in the same page state as the historical fade', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    try {
        const states: Record<string, unknown> = {};
        for (const transition of [undefined, ...TRANSITIONS]) {
            for (const instant of [false, true]) {
                const page = await openPage(context);
                const step = { index: 1, id: 'swap', time: 0, timeMs: 0, action: 'transitionScreen', target: '#s2', ...(transition ? { transition, direction: 'up' } : {}), duration: 0.25 };
                const t0 = Date.now();
                await page.evaluate(async (s) => { const a = (window as any).__anim; const r = await a.runStep(s, { leadMs: 0, instant: s.__instant }); await a.whenDone(r.token); await a.whenSettled(); }, { ...step, __instant: instant });
                const took = Date.now() - t0;
                // Read after whenSettled, the moment a guide frame or a tour's next step sees the page.
                states[`${transition ?? 'none'}/${instant ? 'instant' : 'played'}`] = await page.evaluate(SCREEN_STATE);
                if (!instant && transition && transition !== 'cut') assert.ok(took >= 200, `${transition} actually animated (took ${took}ms)`);
                await page.close();
            }
        }
        const reference = states['none/played'];
        assert.deepEqual((reference as any).s2.display, 'block');
        assert.deepEqual((reference as any).s1.display, 'none');
        for (const [key, st] of Object.entries(states)) assert.deepEqual(st, reference, `${key} ends in the same state as the fade`);
    } finally {
        await context.close();
    }
});

test('a slide inside a panel is clipped to the panel while it runs, and the clip is removed after', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    try {
        const page = await openPage(context);
        const mid = await page.evaluate(async () => {
            const a = (window as any).__anim;
            const r = await a.runStep({ index: 1, id: 'x', time: 0, timeMs: 0, action: 'transitionScreen', target: '#s2', transition: 'slide', duration: 0.4 }, { leadMs: 0 });
            await new Promise(res => setTimeout(res, 150));
            const out = { clip: (document.querySelector('main') as HTMLElement).style.clipPath, moving: getComputedStyle(document.getElementById('s2')!).translate };
            await a.whenDone(r.token);
            return out;
        });
        assert.equal(mid.clip, 'inset(0px)');
        assert.notEqual(mid.moving, 'none', 'the incoming screen is mid-travel at 150 ms');
        assert.equal(await page.evaluate(() => (document.querySelector('main') as HTMLElement).style.clipPath), '');
    } finally {
        await context.close();
    }
});

test('prefers-reduced-motion plays every transition and overlay as a cut', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, reducedMotion: 'reduce' });
    try {
        const page = await openPage(context);
        const r = await page.evaluate(async () => {
            const a = (window as any).__anim;
            const t0 = performance.now();
            const one = await a.runStep({ index: 1, id: 'x', time: 0, timeMs: 0, action: 'transitionScreen', target: '#s2', transition: 'push', duration: 1 }, { leadMs: 0 });
            await a.whenDone(one.token);
            const two = await a.runStep({ index: 2, id: 'm', time: 0, timeMs: 0, action: 'overlay', target: '#modal', duration: 1 }, { leadMs: 0 });
            await a.whenDone(two.token);
            return { ms: performance.now() - t0, s2: getComputedStyle(document.getElementById('s2')!).display, modal: getComputedStyle(document.getElementById('modal')!).display };
        });
        assert.ok(r.ms < 300, `two 1 s motions completed in ${Math.round(r.ms)}ms under reduced motion`);
        assert.deepEqual([r.s2, r.modal], ['block', 'block']);
    } finally {
        await context.close();
    }
});

test('overlay: a modal keeps its own centring transform, gets a scrim, and dismiss removes both', { skip }, async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    try {
        const page = await openPage(context);
        const run = (s: Record<string, unknown>) => page.evaluate(async (step) => { const a = (window as any).__anim; const r = await a.runStep(step, { leadMs: 0 }); await a.whenDone(r.token); }, { index: 1, id: 'o', time: 0, timeMs: 0, action: 'overlay', target: '#modal', duration: 0.2, ...s });
        // Mid-entrance, the modal must still be centred by its own transform (the motion uses `scale`).
        const midway = await page.evaluate(async () => {
            const a = (window as any).__anim;
            const r = await a.runStep({ index: 1, id: 'o', time: 0, timeMs: 0, action: 'overlay', target: '#modal', duration: 0.4 }, { leadMs: 0 });
            await new Promise(res => setTimeout(res, 120));
            const m = document.getElementById('modal')!;
            const box = m.getBoundingClientRect();
            const out = { transform: getComputedStyle(m).transform, centreX: box.left + box.width / 2, scale: getComputedStyle(m).scale };
            await a.whenDone(r.token);
            return out;
        });
        assert.notEqual(midway.transform, 'none', 'the app\'s translate(-50%, -50%) is untouched');
        // The individual `scale` composes before the app's own transform, so a 0.96 scale moves a
        // translate(-50%)-centred 300px modal by at most 2% of its width: centred to the eye.
        assert.ok(Math.abs(midway.centreX - 500) <= 6, `the modal stays centred while it scales in (centre ${midway.centreX})`);
        const shown = await page.evaluate(() => ({ display: getComputedStyle(document.getElementById('modal')!).display, scrims: document.querySelectorAll('.anim-cli-scrim').length, scrimBefore: document.getElementById('modal')!.previousElementSibling?.className }));
        assert.deepEqual(shown, { display: 'block', scrims: 1, scrimBefore: 'anim-cli-scrim' });
        await run({ dismiss: true });
        const gone = await page.evaluate(() => ({ display: getComputedStyle(document.getElementById('modal')!).display, scrims: document.querySelectorAll('.anim-cli-scrim').length, animations: document.getAnimations().length }));
        assert.deepEqual(gone, { display: 'none', scrims: 0, animations: 0 });
        await run({ target: '#toast', variant: 'toast' });
        assert.equal(await page.evaluate(() => document.querySelectorAll('.anim-cli-scrim').length), 0, 'a toast has no scrim by default');
    } finally {
        await context.close();
    }
});

test('a tour seek back and forward across transitions and an overlay leaves the right screen showing', { skip }, async () => {
    const tl = parseTimeline({ steps: [
        { id: 'a', time: 0.2, action: 'wait', title: 'Start' },
        { id: 'b', time: 0.6, action: 'transitionScreen', target: '#s2', transition: 'push', title: 'Two' },
        { id: 'c', time: 1.2, action: 'overlay', target: '#modal', title: 'Modal' },
        // A step while the modal is open: seeking HERE replays the overlay with {instant: true}.
        { id: 'look', time: 1.5, action: 'wait', title: 'Look' },
        { id: 'd', time: 1.8, action: 'overlay', target: '#modal', dismiss: true, title: 'Closed' },
        { id: 'e', time: 2.4, action: 'transitionScreen', target: '#s1', transition: 'slide', direction: 'right', title: 'Back' },
    ] });
    const file = path.join(work, 'tour.html');
    fs.writeFileSync(file, buildTourPage(SCREENS_HTML, tl, { cursor: 'none' }));
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } });
    try {
        const page = await context.newPage();
        await page.goto(fileUrl(file));
        await page.waitForFunction(() => (window as any).__tour && (window as any).__tour.state().total === 6, null, { timeout: 15000 });
        const goto = async (index: number) => {
            await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'goto', index });
            await page.waitForFunction((i) => { const s = (window as any).__tour.state(); return s.index === i && !s.busy; }, index, { timeout: 20000 });
            await page.evaluate(() => (window as any).__anim.whenSettled());
            return page.evaluate(() => ({
                s1: getComputedStyle(document.getElementById('s1')!).display,
                s2: getComputedStyle(document.getElementById('s2')!).display,
                modal: getComputedStyle(document.getElementById('modal')!).display,
                scrims: document.querySelectorAll('.anim-cli-scrim').length,
            }));
        };
        assert.deepEqual(await goto(2), { s1: 'none', s2: 'block', modal: 'block', scrims: 1 }, 'the overlay played');
        assert.deepEqual(await goto(3), { s1: 'none', s2: 'block', modal: 'block', scrims: 1 }, 'the overlay replayed instantly');
        assert.deepEqual(await goto(5), { s1: 'block', s2: 'none', modal: 'none', scrims: 0 });
        assert.deepEqual(await goto(1), { s1: 'none', s2: 'block', modal: 'none', scrims: 0 }, 'seeking back rewinds the overlay and the push');
        assert.deepEqual(await goto(4), { s1: 'none', s2: 'block', modal: 'none', scrims: 0 });
    } finally {
        await context.close();
    }
});

test('check warns when a transition or an overlay would bring in something already visible', { skip }, () => {
    const dir = path.join(work, 'check');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), SCREENS_HTML.replace('#s2 { background: #fde68a; display: none; }', '#s2 { background: #fde68a; }'));
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ steps: [
        { id: 'swap', time: 1, action: 'transitionScreen', target: '#s2', transition: 'crossfade', title: 'Swap' },
        { id: 'open', time: 2, action: 'overlay', target: '#modal', title: 'Open' },
    ] }));
    const r = cli(['check', dir, '--json']);
    const issues: any[] = JSON.parse(r.stdout).issues ?? JSON.parse(r.stdout);
    const warned = issues.filter(i => /already visible before/.test(i.message)).map(i => i.id);
    assert.deepEqual(warned, ['swap'], 'the visible #s2 is warned; the pre-hidden modal is not');
});

test('check: a screen that is display:none until its transition is not reported as cropped (a 0x0 box cannot be cut)', { skip }, () => {
    // Regression: the hidden target's 0x0 rect sits at the viewport origin, so its "overflow" past
    // an offset, overflow:hidden <main> was reported as a crop of that offset (220 px of rail +
    // 62 px of top bar = "cropped by 282px") on every reel that swaps screens inside a layout.
    const dir = path.join(work, 'hidden-crop');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), SCREENS_HTML.replace('main { flex: 1; position: relative; }', 'main { flex: 1; position: relative; overflow: hidden; margin-top: 62px; }'));
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { kind: 'reel', cursor: 'none' }, steps: [
        { id: 'swap', time: 1, action: 'transitionScreen', target: '#s2', transition: 'push' },
    ] }));
    const r = cli(['check', dir, '--json', '-w', '1000', '-H', '600']);
    const issues: any[] = JSON.parse(r.stdout).issues ?? JSON.parse(r.stdout);
    assert.deepEqual(issues.filter(i => /cropped by/.test(i.message)).map(i => i.message), []);
});
