import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import {
    parseTimeline, validateTimeline, resolveMotion, computeDurationMs, contrastRatio, loadTimeline,
    DEFAULT_MOTION_S, DEFAULT_ANIMATE_DURATION_S,
} from '../src/engine/schema';
import { bootOptions, buildAnimatedHtml } from '../src/engine/inject';
import { guideSourceFiles } from '../src/catalog';
import { fileUrl } from '../src/browser';
import { runTimeline } from '../src/engine/driver';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';
import { countOrphans, assertNoNewOrphans } from './orphans';

/**
 * Lot 1 of docs/next-level-plan.md: motion tokens (meta.motion) and the brand kit (meta.brand).
 * The contract that matters most is the null one -- a timeline with neither renders exactly as
 * before -- so the first tests pin that as identities (same steps, same boot object, same pixels).
 */

const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const skip = process.env.SKIP_BROWSER === '1';
const FFMPEG_PROBE_TIMEOUT_MS = 60000;
const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};
const basicRaw = () => JSON.parse(fs.readFileSync(path.join(fixture, 'vistaro.config.json'), 'utf8'));

// ---------------------------------------------------------------------------------- static

test('no meta.motion: parsing adds nothing to any step (durations and easings stay as authored)', () => {
    const raw = basicRaw();
    const tl = parseTimeline(JSON.parse(JSON.stringify(raw)));
    raw.steps.forEach((s: any, i: number) => {
        assert.equal(tl.steps[i].duration, s.duration, `step ${s.id} duration untouched`);
        assert.equal(tl.steps[i].ease, s.ease, `step ${s.id} ease untouched`);
        assert.equal(tl.steps[i].durationToken, undefined);
    });
    assert.equal(bootOptions(tl).brand, undefined, 'an unbranded boot object carries no brand key at all');
});

test('meta.motion fills only the actions whose token it sets; explicit values and token references win', () => {
    const tl = parseTimeline({
        meta: { motion: { base: 0.3, ease: 'easeOutExpo', cameraEase: 'easeInOutCubic' } },
        steps: [
            { time: 0, action: 'animate', target: '#a', to: { opacity: 1 } },
            { time: 1, action: 'animate', target: '#a', to: { opacity: 1 }, duration: 0.9, ease: 'linear' },
            { time: 2, action: 'camera', target: '#a', scale: 1.2 },
            { time: 3, action: 'fadeIn', target: '#a', duration: 'fast' },
            { time: 4, action: 'transitionScreen', target: '#b' },
            { time: 5, action: 'click', target: '#a' },
        ],
    });
    const [anim, explicit, cam, fade, swap, click] = tl.steps;
    assert.equal(anim.duration, 0.3); assert.equal(anim.durationToken, 'base'); assert.equal(anim.ease, 'easeOutExpo');
    assert.equal(explicit.duration, 0.9); assert.equal(explicit.ease, 'linear');
    assert.equal(cam.duration, undefined, 'slow is unset, so the camera keeps its built-in 2.5 s');
    assert.equal(cam.ease, 'easeInOutCubic', 'cameraEase wins for camera');
    assert.equal(fade.duration, DEFAULT_MOTION_S.fast, 'an unset token reference means the default token value');
    assert.equal(swap.duration, 0.3);
    assert.equal(click.duration, undefined); assert.equal(click.ease, undefined, 'ease is only filled where it applies');
    assert.deepEqual(validateTimeline(tl).filter(i => i.level !== 'info' && i.field !== 'title'), []);
    // The estimate follows: the first animate now lasts 0.3 s instead of the 0.6 s default.
    assert.notEqual(anim.duration, DEFAULT_ANIMATE_DURATION_S);
});

test('a per-device block may bring a token reference, resolved after the merge', () => {
    const tl = loadTimelineFrom({ meta: { motion: { fast: 0.15 } }, steps: [{ time: 0, action: 'animate', target: '#a', to: { opacity: 1 }, mobile: { duration: 'fast' } }] }, 'mobile');
    assert.equal(tl.steps[0].duration, 0.15);
});

test('meta.motion and meta.brand are validated: bad values are errors, unknown tokens warnings, poor contrast a warning', () => {
    const issues = validateTimeline(parseTimeline({
        meta: {
            motion: { base: -1, ease: 'bouncy', tempo: 3 },
            brand: { accent: '', accnet: '#f00', caption: { color: '#777', background: '#888' }, logo: { src: 'l.svg', place: 'middle' }, intro: { subtitle: 'no title' } },
        },
        steps: [{ time: 0, action: 'wait' }, { time: 1, action: 'animate', target: '#a', to: { opacity: 1 }, duration: 'medium' }],
    }));
    const text = issues.map(i => `${i.level} ${i.message}`).join('\n');
    assert.match(text, /error meta\.motion\.base must be a non-negative number/);
    assert.match(text, /error meta\.motion\.ease must be one of/);
    assert.match(text, /warning meta\.motion: unknown token "tempo"/);
    assert.match(text, /error meta\.brand\.accent must be a non-empty string/);
    assert.match(text, /warning meta\.brand: unknown token "accnet"/);
    assert.match(text, /warning meta\.brand\.caption: text "#777" on "#888" has a contrast ratio of [\d.]+:1, below 4\.5:1/);
    assert.match(text, /error meta\.brand\.logo\.place must be one of/);
    assert.match(text, /error meta\.brand\.intro\.title is required/);
    assert.match(text, /error "duration" must be a number of seconds or a motion token/);
});

test('contrast: WCAG ratios, translucent backgrounds judged at their worst, unparseable colours stay quiet', () => {
    assert.equal(contrastRatio('#000', '#fff'), 21);
    assert.equal(contrastRatio('#fff', '#fff'), 1);
    assert.ok(contrastRatio('white', 'rgba(20,20,20,0.75)')! > 4.5, 'the default glass chip passes');
    assert.ok(contrastRatio('#fff', 'rgba(0,0,0,0.2)')! < 4.5, 'a mostly transparent chip over a white page fails');
    assert.equal(contrastRatio('var(--ink)', '#fff'), null);
});

test('an intro card warns every step that would run under it; the outro lengthens the clip', () => {
    const tl = parseTimeline({
        meta: { tailMs: 1000, brand: { intro: { title: 'Hi', duration: 1.5 }, outro: { title: 'Bye', duration: 2 } } },
        steps: [{ id: 'a', time: 0.5, action: 'click', target: '#a' }, { id: 'quiet', time: 1, action: 'wait' }, { id: 'b', time: 2, action: 'click', target: '#b' }],
    });
    const under = validateTimeline(tl).filter(i => /under the brand intro card/.test(i.message)).map(i => i.id);
    assert.deepEqual(under, ['a'], 'the click at 0.5s is warned; the silent wait is not; the click after the card is not');
    assert.equal(computeDurationMs(tl), 2000 + 1000 + 2000);
    assert.equal(bootOptions(tl).brand!.outro!.ms, 2000);
});

test('meta.brand may name a shared file: read in place, hashed by build-all, rebased by localize', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-brand-'));
    try {
        const guide = path.join(dir, 'guides', 'one');
        fs.mkdirSync(guide, { recursive: true });
        fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({ accent: '#e11d48', logo: 'logo.svg' }));
        fs.writeFileSync(path.join(guide, 'index.html'), '<!doctype html><body><button id="b">Go</button></body>');
        fs.writeFileSync(path.join(guide, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        fs.writeFileSync(path.join(guide, 'vistaro.config.json'), JSON.stringify({ meta: { brand: '../../brand.json' }, steps: [{ id: 'go', time: 1, action: 'click', target: '#b', title: 'Go' }] }, null, 2));
        const tl = loadTimeline(guide);
        assert.equal((tl.meta.brand as any).accent, '#e11d48');
        assert.equal(tl.brandFile, path.join(dir, 'brand.json'));
        assert.equal(bootOptions(tl).brand!.logo!.place, 'top-right', 'a string logo expands to the default corner');
        const sources = guideSourceFiles(guide);
        assert.ok(sources.includes(path.join(dir, 'brand.json')), 'the shared brand file is part of the content hash');
        assert.ok(sources.includes(path.join(guide, 'logo.svg')), 'the logo is part of the content hash');
        // localize copies the timeline two levels deeper: the brand path must still find the file.
        const r = cli(['localize', guide, 'fr']);
        assert.equal(r.status, 0, r.stderr);
        const fr = path.join(guide, 'locales', 'fr');
        assert.equal(JSON.parse(fs.readFileSync(path.join(fr, 'vistaro.config.json'), 'utf8')).meta.brand, '../../../../brand.json');
        assert.equal((loadTimeline(fr).meta.brand as any).accent, '#e11d48');
        assert.ok(fs.existsSync(path.join(fr, 'logo.svg')), 'the logo travels with the locale');
        // A missing brand file is a readable error, not a silent unbranded render.
        fs.writeFileSync(path.join(guide, 'vistaro.config.json'), JSON.stringify({ meta: { brand: 'nope.json' }, steps: [] }));
        assert.throws(() => loadTimeline(guide), /meta\.brand names nope\.json, which does not exist/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Parse + per-device resolution, the way loadTimeline does it, without a directory. */
function loadTimelineFrom(raw: unknown, device: 'desktop' | 'mobile') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-motion-'));
    try {
        fs.writeFileSync(path.join(dir, 'vistaro.config.json'), JSON.stringify(raw));
        return loadTimeline(dir, { device });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// --------------------------------------------------------------------------------- browser

let browser: Browser;
let orphanBaseline = -1;
let work: string;

before(async () => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-brand-b-'));
    orphanBaseline = countOrphans();
    browser = await chromium.launch({ headless: true });
});

after(async () => {
    if (browser) {
        await browser.close();
        assertNoNewOrphans(orphanBaseline, 'brand.test.ts');
    }
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

/** The basic fixture built with `meta` patched, driven step by step to `upto`, then screenshot. */
async function frameOf(metaPatch: Record<string, unknown>, upto: number): Promise<Buffer> {
    const raw = basicRaw();
    Object.assign(raw.meta, metaPatch);
    const tl = parseTimeline(raw);
    tl.steps = tl.steps.slice(0, upto);
    const html = buildAnimatedHtml(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), tl);
    const file = path.join(work, `frame-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(file, html);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
        const page = await context.newPage();
        await page.addInitScript(() => { (window as any).__VISTARO_DRIVEN = true; });
        await page.goto(fileUrl(file));
        await page.waitForFunction(() => (window as any).__vistaro?.isReady());
        await runTimeline(page, tl, { mode: 'step', instant: true, settleMs: 0 });
        await page.evaluate(() => (window as any).__vistaro.whenSettled());
        // A held spotlight, so the frame contains the ring whose colour a brand would change.
        await page.evaluate(() => { const a = (window as any).__vistaro; a.holdHighlight(document.querySelector('#note')); });
        await page.evaluate(() => (window as any).__vistaro.nextFrames(2));
        return await page.screenshot();
    } finally {
        await context.close();
    }
}

test('absent and empty motion/brand render the same pixels; an accent changes them', { skip }, async () => {
    const plain = await frameOf({}, 6);
    const empty = await frameOf({ motion: {}, brand: {} }, 6);
    assert.ok(plain.equals(empty), 'empty meta.motion and meta.brand objects must not move a pixel');
    const accented = await frameOf({ brand: { accent: '#e11d48' } }, 6);
    assert.ok(!plain.equals(accented), 'a brand accent recolours the ring (the oracle can tell frames apart)');
});

test('a branded spotlight, ripple, badge, cursor, caption and logo wear the brand', { skip }, async () => {
    const raw = basicRaw();
    raw.meta.brand = { accent: 'rgb(225, 29, 72)', cursor: '#e11d48', caption: { font: 'Georgia, serif', color: '#111111', background: '#fde68a', radius: 4 }, logo: { src: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22/%3E', place: 'bottom-left', height: 30 } };
    const tl = parseTimeline(raw);
    const html = buildAnimatedHtml(fs.readFileSync(path.join(fixture, 'index.html'), 'utf8'), tl);
    const file = path.join(work, 'branded.html');
    fs.writeFileSync(file, html);
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
        const page = await context.newPage();
        await page.addInitScript(() => { (window as any).__VISTARO_DRIVEN = true; });
        await page.goto(fileUrl(file));
        await page.waitForFunction(() => (window as any).__vistaro?.isReady());
        await runTimeline(page, { ...tl, steps: tl.steps.slice(0, 2) }, { mode: 'step', instant: true, settleMs: 0 });
        const got = await page.evaluate(() => {
            const a = (window as any).__vistaro;
            a.showSubtitle('Branded caption', 4000);
            a.ripple(100, 100);
            a.showCallout(1, document.querySelector('#btn'));
            const h = document.getElementById('vistaro-highlight')!;
            const chip = document.querySelector('.vistaro-sub-item') as HTMLElement;
            const cs = getComputedStyle(chip);
            const logo = document.getElementById('vistaro-logo') as HTMLImageElement;
            const rip = document.querySelector('.vistaro-ripple') as HTMLElement;
            return {
                ring: h.style.borderColor, // inline style, never getBoundingClientRect (AGENTS.md spotlight rule)
                rippleBg: rip.style.background,
                badge: (document.getElementById('vistaro-callout') as HTMLElement).style.background,
                cursorCss: document.getElementById('vistaro-runtime-style')!.textContent!,
                chipFont: cs.fontFamily, chipColor: cs.color, chipBg: cs.backgroundColor, chipRadius: cs.borderTopLeftRadius,
                logoPlace: logo?.getAttribute('data-place'), logoHeight: logo?.style.height, logoParent: logo?.parentElement?.tagName,
            };
        });
        assert.equal(got.ring, 'rgb(225, 29, 72)');
        assert.match(got.rippleBg, /color-mix\(in srgb, rgb\(225, 29, 72\) 35%, transparent/);
        assert.equal(got.badge, 'rgb(225, 29, 72)');
        assert.match(got.cursorCss, /fill="%23e11d48"/, 'the cursor sprite is tinted');
        assert.match(got.chipFont, /Georgia/);
        assert.equal(got.chipColor, 'rgb(17, 17, 17)');
        assert.equal(got.chipBg, 'rgb(253, 230, 138)');
        assert.equal(got.chipRadius, '4px');
        assert.deepEqual([got.logoPlace, got.logoHeight, got.logoParent], ['bottom-left', '30px', 'HTML']);
        // Guide frames are documentation: the logo hides during a capture and comes back after.
        const hidden = await page.evaluate(() => { const a = (window as any).__vistaro; a.beginCapture({}); const v = document.getElementById('vistaro-logo')!.style.visibility; a.endCapture(); return [v, document.getElementById('vistaro-logo')!.style.visibility]; });
        assert.deepEqual(hidden, ['hidden', '']);
    } finally {
        await context.close();
    }
});

test('export opens on the intro card and ends on the outro card; the clip is longer by the outro', { skip }, async () => {
    const dir = path.join(work, 'cards');
    fs.cpSync(fixture, dir, { recursive: true });
    const raw = basicRaw();
    // Shift the timeline past a 1s intro, keep it short, and give both cards loud backgrounds.
    raw.meta.tailMs = 500;
    raw.meta.brand = { intro: { title: 'Hello', duration: 1, background: '#00ff00', color: '#000000' }, outro: { title: 'Bye', duration: 1, background: '#ff00ff', color: '#000000' } };
    raw.steps = [
        { id: 'open', time: 1.5, action: 'click', target: '#btn', title: 'Open' },
        { id: 'name', time: 2.2, action: 'type', target: '#field', value: 'Ada', cps: 50, title: 'Type' },
    ];
    fs.writeFileSync(path.join(dir, 'vistaro.config.json'), JSON.stringify(raw, null, 2));
    const out = path.join(work, 'cards.mp4');
    const r = cli(['export', dir, '-o', out]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const ffmpeg = require('ffmpeg-static');
    const durationOf = () => {
        const info = spawnSync(ffmpeg, ['-i', out], { encoding: 'utf8', timeout: FFMPEG_PROBE_TIMEOUT_MS }).stderr;
        const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(info)!;
        return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
    };
    /** The frame at `at` seconds averaged down to one pixel: a full-frame card dominates it. */
    const meanAt = (at: number) => {
        const res = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: FFMPEG_PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 });
        return [...res.stdout.subarray(0, 3)];
    };
    const total = durationOf();
    const expected = computeDurationMs(parseTimeline(raw));
    assert.ok(Math.abs(total - expected) < 400, `clip ${total}ms vs computed ${expected}ms (tail + outro included)`);
    const [r0, g0, b0] = meanAt(0.3);
    assert.ok(g0 > 180 && r0 < 90 && b0 < 90, `the opening frame is the green intro card (got ${r0},${g0},${b0})`);
    const [r1, g1, b1] = meanAt(1.8);
    assert.ok(!(g1 > 180 && r1 < 90), `the intro is gone once its second is up (got ${r1},${g1},${b1})`);
    const [r2, g2, b2] = meanAt(total / 1000 - 0.25);
    assert.ok(r2 > 180 && b2 > 180 && g2 < 90, `the closing frame is the magenta outro card (got ${r2},${g2},${b2})`);
});

test('a tour catalog may name the brand file: its accent and font seed the theme, an explicit theme value wins', () => {
    const { readTourCatalog } = require('../src/commands/tour');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-brand-tour-'));
    try {
        fs.mkdirSync(path.join(dir, 'demo'));
        fs.writeFileSync(path.join(dir, 'demo', 'index.html'), '<!doctype html><body></body>');
        fs.writeFileSync(path.join(dir, 'demo', 'vistaro.config.json'), JSON.stringify({ steps: [] }));
        fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({ accent: '#e11d48', caption: { font: 'Inter, sans-serif' } }));
        const catalog = (extra: object) => {
            const file = path.join(dir, 'tour.catalog.json');
            fs.writeFileSync(file, JSON.stringify({ scenarios: [{ slug: 'a', dir: 'demo', label: 'A' }], ...extra }));
            return readTourCatalog(file).catalog;
        };
        assert.deepEqual(catalog({ brand: 'brand.json' }).theme, { accent: '#e11d48', font: 'Inter, sans-serif' });
        assert.deepEqual(catalog({ brand: 'brand.json', theme: { accent: '#000000' } }).theme, { accent: '#000000', font: 'Inter, sans-serif' });
        assert.equal(catalog({}).theme, undefined, 'no brand, no theme: the catalog builds exactly as before');
        assert.throws(() => catalog({ brand: 'missing.json' }), /"brand": cannot read .*missing\.json \(not found\)/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
