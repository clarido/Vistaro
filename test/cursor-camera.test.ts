import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import { parseTimeline, validateTimeline, DEFAULT_LEAD_MS, CURSOR_TRAVEL_FLOOR_MS } from '../src/engine/schema';
import { bootOptions, buildAnimatedHtml } from '../src/engine/inject';
import { fileUrl } from '../src/browser';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';
import { countOrphans, assertNoNewOrphans } from './orphans';

/**
 * Lot 3 of docs/next-level-plan.md: distance-scaled cursor travel (meta.motion.cursor: "natural")
 * and a camera that follows the action (camera "follow"). Both are opt-in; the default cursor
 * still spends the whole lead gliding, which the first browser test pins.
 */

const root = path.resolve(__dirname, '..');
const skip = process.env.SKIP_BROWSER === '1';
const TRAVEL_MS = DEFAULT_LEAD_MS - 150; // runStep's travel budget: the lead minus the press
const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};

/** Three buttons: two 40 px apart near the top-left, one in the far bottom-right corner. */
const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; width: 100vw; height: 100vh; position: relative; background: #f8fafc; font: 14px sans-serif; }
  button { position: absolute; width: 90px; height: 32px; }
  #a { left: 60px; top: 60px; } #b { left: 160px; top: 60px; } #far { right: 60px; bottom: 60px; }
  #mid { left: 600px; top: 400px; }
</style></head><body><button id="a">A</button><button id="b">B</button><button id="mid">Mid</button><button id="far">Far</button></body></html>`;

// ---------------------------------------------------------------------------------- static

test('motion.cursor and camera follow are validated; the default boot object is unchanged', () => {
    const tl = parseTimeline({ meta: { motion: { cursor: 'wobbly' } }, steps: [
        { id: 'flat', time: 0, action: 'camera', follow: true },
        { id: 'stray', time: 1, action: 'click', target: '#a', follow: true },
        { id: 'ok', time: 2, action: 'camera', target: '#a', scale: 1.4, follow: true },
    ] });
    const msgs = validateTimeline(tl).map(i => `${i.id ?? '-'} ${i.level}: ${i.message}`).join('\n');
    assert.match(msgs, /- error: meta\.motion\.cursor must be "fixed" or "natural"/);
    assert.match(msgs, /flat warning: "follow" at scale 1 frames the whole page/);
    assert.match(msgs, /stray warning: "follow" only applies to a "camera" step/);
    assert.doesNotMatch(msgs, /^ok .*follow/m, 'a following camera with a scale is clean');
    assert.equal(bootOptions(parseTimeline({ steps: [] })).cursorMotion, undefined, 'no motion.cursor, no new boot key');
    assert.equal(bootOptions(parseTimeline({ meta: { motion: { cursor: 'natural' } }, steps: [] })).cursorMotion, 'natural');
});

// --------------------------------------------------------------------------------- browser

let browser: Browser;
let orphanBaseline = -1;
let work: string;

before(async () => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-cursor-'));
    orphanBaseline = countOrphans();
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    if (browser) {
        await browser.close();
        assertNoNewOrphans(orphanBaseline, 'cursor-camera.test.ts');
    }
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

/** Run hops a -> b (short) and b -> far (long) for real (not instant) and report each travel. */
async function hops(motion: Record<string, unknown> | undefined) {
    const tl = parseTimeline({ meta: motion ? { motion } : {}, steps: [] });
    const file = path.join(work, `hops-${motion ? 'natural' : 'fixed'}.html`);
    fs.writeFileSync(file, buildAnimatedHtml(PAGE, tl, { drift: false }));
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
        const page = await context.newPage();
        await page.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
        await page.goto(fileUrl(file));
        await page.waitForFunction(() => (window as any).__anim?.isReady());
        await page.evaluate(() => (window as any).__anim.start());
        const out: any[] = [];
        for (const [i, target] of [[1, '#a'], [2, '#b'], [3, '#far']] as const) {
            out.push(await page.evaluate(async ([idx, sel]) => {
                const a = (window as any).__anim;
                const pending = a.runStep({ index: idx, id: 's' + idx, time: 0, timeMs: 0, action: 'hover', target: sel }, { leadMs: 950 });
                // Sampled mid-flight: by the arrival the glide is over and the press's CSS transition
                // is the cursor's only animation. A CSS transition carries transitionProperty; the glide does not.
                await new Promise(res => setTimeout(res, 40));
                const glide = document.getElementById('anim-cli-cursor')!.getAnimations().find(x => !('transitionProperty' in x));
                const t = glide ? glide.effect!.getComputedTiming() : null;
                const r = await pending;
                await a.whenDone(r.token);
                return { travel: a.lastTravel(), glide: t ? { duration: Number(t.duration), delay: Number(t.delay) } : null };
            }, [i, target] as const));
        }
        return out.slice(1); // the first step only places the cursor
    } finally {
        await context.close();
    }
}

test('default cursor: every hop glides for the whole lead, distance or not (today\'s behaviour)', { skip }, async () => {
    const [short, long] = await hops(undefined);
    assert.equal(short.travel.style, 'fixed');
    assert.equal(short.travel.travelMs, TRAVEL_MS);
    assert.equal(long.travel.travelMs, TRAVEL_MS);
    assert.equal(short.travel.arc, 0);
});

test('natural cursor: a short hop is measurably quicker than a long one, neither exceeds the lead, and both arrive on time', { skip }, async () => {
    const [short, long] = await hops({ cursor: 'natural' });
    assert.ok(short.travel.distance < 150 && long.travel.distance > 900, `hops of ${short.travel.distance} px and ${long.travel.distance} px`);
    assert.ok(long.travel.travelMs - short.travel.travelMs >= 200, `short ${short.travel.travelMs}ms vs long ${long.travel.travelMs}ms`);
    for (const h of [short, long]) {
        assert.ok(h.travel.travelMs >= CURSOR_TRAVEL_FLOOR_MS && h.travel.travelMs <= TRAVEL_MS, `travel ${h.travel.travelMs}ms within [floor, lead]`);
        // The glide actually played with that timing, and its delay makes it land on the interaction moment.
        assert.ok(h.glide, 'a Web Animations glide ran on the cursor');
        assert.equal(h.glide.duration, h.travel.travelMs);
        assert.equal(h.glide.delay + h.glide.duration, TRAVEL_MS, 'delay + travel = the lead\'s travel budget');
    }
    assert.equal(short.travel.arc, 0, 'a short hop goes straight');
    assert.ok(long.travel.arc > 0, 'a long move bends');
});

test('camera follow: every later target lands inside the window, the window moves, and it never leaves the page (check --trace)', { skip }, () => {
    const dir = path.join(work, 'follow');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { drift: false }, steps: [
        { id: 'zoom', time: 0.5, action: 'camera', target: '#mid', scale: 1.8, duration: 0.5, follow: true, guide: false },
        { id: 'a', time: 1.5, action: 'click', target: '#a', title: 'A' },
        { id: 'far', time: 2.5, action: 'click', target: '#far', title: 'Far' },
        { id: 'b', time: 3.5, action: 'hover', target: '#b', title: 'B' },
        { id: 'stop', time: 4.5, action: 'camera', scale: 1, duration: 0.5, guide: false },
        { id: 'far2', time: 5.5, action: 'hover', target: '#far', title: 'Far again' },
    ] }));
    const r = cli(['check', dir, '--trace', '-w', '1280', '-H', '720']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const trace = JSON.parse(fs.readFileSync(path.join(dir, 'trace.json'), 'utf8')).steps as any[];
    const by = (id: string) => trace.find(t => t.id === id);
    const windows = ['a', 'far', 'b'].map(id => {
        const t = by(id);
        assert.ok(t.travel.follow, `${id}: the camera was following`);
        const s = t.spotlight;
        assert.ok(s && s.x >= 0 && s.y >= 0 && s.x + s.w <= 1280 && s.y + s.h <= 720, `${id}: the target is inside the frame (${JSON.stringify(s)})`);
        const w = t.camera.window;
        assert.equal(t.camera.scale, 1.8);
        assert.ok(w.x >= -1 && w.y >= -1 && w.x + w.w <= 1281 && w.y + w.h <= 721, `${id}: the window stays on the page (${JSON.stringify(w)})`);
        return `${w.x},${w.y}`;
    });
    // a and b are both near the top-left corner, so both clamp to the same window (the page edge);
    // what matters is that the camera went to far and came back.
    assert.ok(windows[0] !== windows[1] && windows[1] !== windows[2], `the window moved between targets: ${windows.join(' | ')}`);
    assert.equal(windows[0], '0,0', 'a corner target clamps the window to the page corner instead of showing beyond it');
    assert.equal(by('far2').travel.follow, false, 'a camera step without follow ends it');
});
