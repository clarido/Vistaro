import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseTimeline } from '../src/engine/schema';
import { isGuideStep, cropBox, cleanStaleAssets } from '../src/guide/capture';
import { renderMarkdown, renderHtml, stepHeading, GuideJson } from '../src/guide/render';
import { hashGuideDir, referencedLocalFiles } from '../src/catalog';
import { launchPage, fileUrl } from '../src/browser';
import { ensureRuntime } from '../src/engine/driver';
import { listChapters } from '../src/media/ffmpeg';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8' });

const pngSize = (file: string) => { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

/** Fraction of dark pixels (luma < 110) in the centre-bottom band where the subtitle pill sits (2x frames of a 1280x800 viewport). */
function subtitleBandDarkFraction(file: string): number {
    const res = spawnSync(require('ffmpeg-static'), ['-i', file, '-vf', 'crop=1000:140:780:1400', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const px = res.stdout;
    let dark = 0;
    for (let i = 0; i < px.length; i++) if (px[i] < 110) dark++;
    return px.length ? dark / px.length : NaN;
}

let work: string;
before(() => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-guide-'));
    fs.cpSync(fixture, path.join(work, 'basic'), { recursive: true });
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

test('isGuideStep skips guide:false and target-less wait/camera/scroll; cropBox clamps', () => {
    const tl = parseTimeline([
        { time: 0, action: 'wait' },
        { time: 1, action: 'click', target: '#a' },
        { time: 2, action: 'camera', scale: 1.2 },
        { time: 3, action: 'camera', target: '#a', scale: 1.2 },
        { time: 4, action: 'highlight', target: '#a', guide: false },
        { time: 5, action: 'press', value: 'Enter' },
    ]);
    assert.deepEqual(tl.steps.map(isGuideStep), [false, true, false, true, false, true]);
    assert.deepEqual(cropBox({ x: 10, y: 20, width: 100, height: 50 }, 30, { width: 300, height: 200 }), { x: 0, y: 0, width: 140, height: 100 });
    assert.deepEqual(cropBox({ x: 250, y: 150, width: 100, height: 100 }, 20, { width: 300, height: 200 }), { x: 230, y: 130, width: 70, height: 70 });
});

test('renderMarkdown/renderHtml produce the documented structure', () => {
    const g: GuideJson = {
        version: 1, slug: 's', title: 'My *guide*', app: 'App', locale: 'en', baseLocale: 'en', generatedAt: '2026-01-01T00:00:00.000Z',
        source: { dir: 'demo', contentHash: 'sha256:abc', tool: 'screenshot-animator@1.1.0' },
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2, theme: 'light' },
        video: { file: '../out.mp4', durationMs: 5000, poster: 'assets/poster.png', subtitles: '../out.vtt', narration: false, chapters: [{ startMs: 0, endMs: 2000, title: 'Overview' }] },
        steps: [
            { index: 2, number: 1, id: 'open', action: 'click', target: '#btn', scheduledMs: 1000, actualMs: 1003, capturedAt: 'interaction', title: 'Open the panel', subtitle: 'Open it.', note: 'Top left.', image: 'assets/step-02.png', crop: 'assets/step-02.crop.png', rect: { x: 1, y: 2, width: 3, height: 4 }, callout: { number: 1, x: -21, y: -20 } },
            { index: 3, number: 2, id: 'name', action: 'type', target: '#field', scheduledMs: 2000, actualMs: 2001, capturedAt: 'completion', image: 'assets/step-03.png', rect: null, callout: null },
        ],
    };
    const md = renderMarkdown(g);
    assert.match(md, /^# My \\\*guide\\\*\n/);
    assert.match(md, /\[Watch the video\]\(\.\.\/out\.mp4\)/);
    assert.match(md, /## 1\. Open the panel\n\nTop left\.\n\n!\[Step 1\]\(assets\/step-02\.crop\.png\)\n\n> Open it\./);
    assert.match(md, /## 2\. Type into #field\n\n!\[Step 2\]\(assets\/step-03\.png\)/);
    assert.equal(stepHeading(g.steps[1]), 'Type into #field');
    const html = renderHtml(g);
    assert.match(html, /<video controls[^>]*poster="assets\/poster\.png" src="\.\.\/out\.mp4"><track kind="subtitles" src="\.\.\/out\.vtt"/);
    assert.match(html, /<h2>Open the panel<\/h2>/);
    assert.match(html, /class="num">1</);
    assert.ok(!html.includes('<script src='), 'self-contained');
});

test('hashGuideDir changes with content and ignores generated files', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-hash-'));
    fs.writeFileSync(path.join(d, 'index.html'), '<p>a</p>');
    fs.writeFileSync(path.join(d, 'anim.config.json'), '[]');
    const h1 = hashGuideDir(d);
    fs.writeFileSync(path.join(d, 'animated.html'), 'generated');
    fs.writeFileSync(path.join(d, 'anim.manifest.json'), '{}');
    assert.equal(hashGuideDir(d), h1);
    fs.writeFileSync(path.join(d, 'preview.png'), 'x');
    fs.writeFileSync(path.join(d, 'out.gif'), 'x');
    fs.writeFileSync(path.join(d, 'unused.png'), 'x');
    assert.equal(hashGuideDir(d), h1, 'previews, exports and unreferenced media are ignored');
    fs.writeFileSync(path.join(d, 'index.html'), '<p>a</p><img src="shot.png"><div style="background:url(bg.jpg)"></div><a href="https://x.y/z.png">x</a>');
    const h2 = hashGuideDir(d);
    assert.notEqual(h2, h1);
    assert.deepEqual(referencedLocalFiles(d), ['bg.jpg', 'shot.png']);
    fs.writeFileSync(path.join(d, 'shot.png'), 'pixels');
    const h3 = hashGuideDir(d);
    assert.notEqual(h3, h2, 'a referenced media file counts once it exists');
    fs.writeFileSync(path.join(d, 'shot.png'), 'other pixels');
    assert.notEqual(hashGuideDir(d), h3, 'and its bytes count');
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
    fs.rmSync(d, { recursive: true, force: true });
});

/** Mirror of runtime.js calloutPosition(): badge centred on the box's top-left, clamped into the viewport. */
function expectedCallout(rect: { x: number; y: number; width: number; height: number }, number: number, vp: { width: number; height: number }) {
    let x = rect.x - 6 - 16, y = rect.y - 6 - 16;
    if (x < 0) x = Math.max(0, rect.x + 4);
    if (y < 0) y = Math.max(0, rect.y + 4);
    if (x + 32 > vp.width) x = Math.max(0, vp.width - 32);
    if (y + 32 > vp.height) y = Math.max(0, vp.height - 32);
    return { number, x: Math.round(x), y: Math.round(y) };
}

test('cleanStaleAssets removes only generated step files', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-stale-'));
    for (const f of ['step-01.png', 'step-01.crop.png', 'step-02.mp4', 'step-03.aiff', 'poster.png', 'keep.txt', 'notes-step-01.png']) fs.writeFileSync(path.join(d, f), 'x');
    const removed = cleanStaleAssets(d).sort();
    assert.deepEqual(removed, ['poster.png', 'step-01.crop.png', 'step-01.png', 'step-02.mp4', 'step-03.aiff']);
    assert.deepEqual(fs.readdirSync(d).sort(), ['keep.txt', 'notes-step-01.png']);
    assert.deepEqual(cleanStaleAssets(path.join(d, 'missing')), []);
    fs.rmSync(d, { recursive: true, force: true });
});

test('guide <dir> without a video: screenshots, crops, callouts, guide.json/.md/.html', { skip }, () => {
    const dir = path.join(work, 'basic');
    fs.mkdirSync(path.join(dir, 'guide', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'guide', 'assets', 'step-99.png'), 'stale');
    fs.writeFileSync(path.join(dir, 'guide', 'assets', 'keep.txt'), 'mine');
    const r = cli(['guide', dir, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /No exported video found/);
    const g: GuideJson = JSON.parse(fs.readFileSync(path.join(dir, 'guide', 'guide.json'), 'utf8'));
    assert.equal(g.version, 1);
    assert.equal(g.slug, 'basic');
    assert.equal(g.title, 'Basic fixture');
    assert.equal(g.video, null);
    assert.match(g.source.contentHash, /^sha256:/);
    assert.deepEqual(g.viewport, { width: 1280, height: 800, deviceScaleFactor: 2, theme: 'light' });
    // fixture: wait(skipped) click type camera camera highlight fadeIn transitionScreen type(caret) -> 7 guide steps
    assert.deepEqual(g.steps.map(s => [s.index, s.number, s.action]), [[2, 1, 'click'], [3, 2, 'type'], [4, 3, 'camera'], [5, 4, 'camera'], [6, 5, 'highlight'], [7, 6, 'fadeIn'], [8, 7, 'transitionScreen'], [9, 8, 'type']].slice(0, 8));
    const click = g.steps[0];
    assert.equal(click.title, 'Open the panel');
    assert.ok(click.rect && click.rect.width > 50 && click.rect.height > 20);
    assert.deepEqual(click.callout, expectedCallout(click.rect!, 1, { width: 1280, height: 800 }));
    assert.equal(click.capturedAt, 'interaction');
    assert.equal(g.steps.find(s => s.id === 'name')!.capturedAt, 'completion');
    assert.ok(!fs.existsSync(path.join(dir, 'guide', 'assets', 'step-99.png')), 'stale assets are removed before capture');
    assert.ok(fs.existsSync(path.join(dir, 'guide', 'assets', 'keep.txt')), 'unrelated files are left alone');
    assert.equal(click.image, 'assets/step-02.png');
    assert.equal(click.crop, 'assets/step-02.crop.png');
    for (const s of g.steps) {
        assert.ok(s.image && fs.existsSync(path.join(dir, 'guide', s.image)), s.image);
        assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);
    }
    assert.deepEqual(pngSize(path.join(dir, 'guide', click.image!)), { width: 2560, height: 1600 });
    const crop = pngSize(path.join(dir, 'guide', click.crop!));
    const expected = cropBox(click.rect!, 120, { width: 1280, height: 800 });
    assert.ok(Math.abs(crop.width - expected.width * 2) <= 2 && Math.abs(crop.height - expected.height * 2) <= 2, `crop ${JSON.stringify(crop)} vs ${JSON.stringify(expected)}`);
    assert.ok(crop.width < 2560);
    const caret = g.steps.find(s => s.id === 'caret')!;
    assert.ok(caret.rect && caret.rect.width > 100 && caret.rect.height > 50, `caret step frames the sized ancestor (#log) even after typing sized the span: ${JSON.stringify(caret.rect)}`);
    assert.ok(caret.targetRect && caret.targetRect.width > 0, 'the typed span is reported as targetRect at completion');
    assert.equal(caret.capturedAt, 'completion');
    assert.deepEqual(caret.callout, expectedCallout(caret.rect!, caret.number, { width: 1280, height: 800 }), 'badge sits on the same box as rect');
    // every step with a resolvable target gets a badge, state actions included
    for (const s of g.steps) {
        assert.ok(s.rect && s.callout && s.callout.number === s.number, `step ${s.index} ${s.action}: ${JSON.stringify(s.callout)}`);
        assert.ok(s.image && fs.existsSync(path.join(dir, 'guide', s.image)));
    }
    const screen2 = g.steps.find(s => s.id === 'screen2')!;
    assert.equal(screen2.capturedAt, 'completion');
    assert.ok(!fs.existsSync(path.join(dir, 'guide', 'assets', 'poster.png')), 'no poster without a video to link');
    assert.equal(g.source.dir, 'basic', 'source.dir is a basename');
    const md = fs.readFileSync(path.join(dir, 'guide', 'guide.md'), 'utf8');
    assert.match(md, /^# Basic fixture/);
    assert.match(md, /## 1\. Open the panel/);
    assert.match(md, /> Open it\./);
    assert.ok(fs.existsSync(path.join(dir, 'guide', 'guide.html')));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    assert.equal(manifest.history.at(-1).command, 'guide');
});

test('a target that vanished keeps its guide entry with error, plain frame, no marks; exit 1', { skip }, () => {
    const dir = path.join(work, 'vanish');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { cursor: 'mac' }, steps: [
        { time: 0, action: 'click', target: '#btn', title: 'Open' },
        { time: 1, action: 'highlight', target: '#gone', title: 'Vanished' },
        { time: 2, action: 'highlight', target: '#note', title: 'Notice' },
    ] }));
    const r = cli(['guide', dir, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /FAILED: 1 step\(s\) failed during capture/);
    const g: GuideJson = JSON.parse(fs.readFileSync(path.join(dir, 'guide', 'guide.json'), 'utf8'));
    assert.deepEqual(g.steps.map(s => [s.number, s.id]), [[1, 'step-01'], [2, 'step-02'], [3, 'step-03']], 'numbering does not shift');
    // --force: same guide, the failure is a warning and the command exits 0
    const forced = cli(['guide', dir, '--force', '--width', '1280', '--height', '800']);
    assert.equal(forced.status, 0, forced.stderr + forced.stdout);
    assert.match(forced.stderr, /warning  \(--force\) 1 step\(s\) failed/);
    const gone = g.steps[1];
    assert.match(gone.error!, /target not found: #gone/);
    assert.equal(gone.callout, null);
    assert.ok(gone.image && fs.existsSync(path.join(dir, 'guide', gone.image)), 'plain frame still captured');
    assert.equal(g.steps[2].error, undefined);
    assert.equal(g.steps[2].callout!.number, 3);
});

test('export --guide --clips: video block, chapters, poster, clips wired into guide.json; guide.html has the video', { skip }, () => {
    const dir = path.join(work, 'basic');
    const out = path.join(work, 'out.mp4');
    const r = cli(['export', dir, '-o', out, '--guide', '--guide-dir', path.join(work, 'g'), '--clips', 'mp4', '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /guide /);
    const g: GuideJson = JSON.parse(fs.readFileSync(path.join(work, 'g', 'guide.json'), 'utf8'));
    assert.ok(g.video);
    assert.equal(g.video!.file, '../out.mp4');
    assert.equal(g.video!.subtitles, '../out.vtt');
    assert.equal(g.video!.poster, 'assets/poster.png');
    assert.ok(g.video!.durationMs >= 7750);
    assert.ok(g.video!.chapters.length >= 5);
    assert.equal(g.video!.chapters[1].title, 'Open the panel');
    const click = g.steps[0];
    assert.ok(Math.abs(click.actualMs - 1000) <= 100, `actualMs from the video pass: ${click.actualMs}`);
    assert.equal(click.clip, '../out-step-02.mp4');
    assert.ok(fs.existsSync(path.join(work, 'g', click.clip!)));
    assert.equal(listChapters(path.join(work, 'g', click.clip!)).length, 0, 'clips carry no chapters');
    const html = fs.readFileSync(path.join(work, 'g', 'guide.html'), 'utf8');
    assert.match(html, /<video[^>]*src="\.\.\/out\.mp4">/);
    assert.ok(g.video!.cues && g.video!.cues.length >= 2, 'cues inlined in guide.json');
    assert.match(html, /addTextTrack\('subtitles'/);
    assert.ok(fs.existsSync(path.join(work, 'g', 'assets', 'poster.png')), 'poster written when a video is linked');
    assert.ok(!JSON.stringify(g).includes(work), 'no absolute paths in guide.json');
    // Subtitle bar absent from the poster and from every step frame (the fixture page is light, the pill is dark).
    // Positive control: a preview frame of the click step, where the subtitle "Open it." is showing.
    const control = cli(['preview', dir, '--step', '2', '--at', 'interaction', '--width', '1280', '--height', '800', '-o', path.join(work, 'control.png')]);
    assert.equal(control.status, 0, control.stderr);
    const ctrl = subtitleBandDarkFraction(path.join(work, 'control.png'));
    assert.ok(ctrl > 0.02, `positive control shows a subtitle pill: ${ctrl}`);
    for (const f of ['assets/poster.png', ...g.steps.map(s => s.image!)]) {
        const frac = subtitleBandDarkFraction(path.join(work, 'g', f));
        assert.ok(frac < 0.005, `${f}: subtitle band dark fraction ${frac} (control ${ctrl})`);
    }
    // subtitles must show from a plain file:// open (no browser flags): Chromium blocks <track src> there
    const cueCount = spawnSync(process.execPath, ['-e', `
        const { chromium } = require('playwright'); const { pathToFileURL } = require('url');
        (async () => { const b = await chromium.launch(); const p = await b.newPage();
          await p.goto(pathToFileURL(process.argv[1]).href); await p.waitForTimeout(300);
          const n = await p.evaluate(() => { const t = document.querySelector('video').textTracks; return t.length ? (t[0].cues ? t[0].cues.length : -1) : 0; });
          console.log(n); await b.close(); })();`, path.join(work, 'g', 'guide.html')], { cwd: root, encoding: 'utf8' });
    assert.equal(parseInt(cueCount.stdout.trim(), 10) >= 2, true, `cues on file://: ${cueCount.stdout} ${cueCount.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    const ev = manifest.history.at(-1);
    assert.equal(ev.guide, '../g', 'manifest paths are relative to the output dir');
    assert.equal(ev.output, '../out.mp4');
    assert.match(ev.contentHash, /^sha256:/);
    assert.ok(!JSON.stringify(manifest).includes(work), 'no absolute paths in the manifest');
    // `guide` alone resolves the video against the dir (the manifest path is dir-relative, the cwd is
    // the repo root, which has no ../out.mp4) and warns when the sources changed since the export
    fs.appendFileSync(path.join(dir, 'index.html'), '<!-- edited -->');
    const again = cli(['guide', dir, '--width', '1280', '--height', '800']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.match(again.stdout, /Using video .*out\.mp4/);
    assert.match(again.stderr, /exported from different sources/);
});

test('guide marks never capture mid-transition: whenSettled outlasts a 3s CSS fade, a held spotlight snaps (K-3)', { skip }, async () => {
    // demo/index.html: #cinematic-text has `transition: all 3s`; the runtime's own completion timer
    // fires a few frames before the transition visibly ends, and the spotlight box has a 0.5s
    // position transition. Both used to leave the guide frame timing-dependent (1-2% pixel drift).
    const dir = path.join(work, 'k3'); fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(root, 'demo', 'index.html'), path.join(dir, 'index.html'));
    const timeline = parseTimeline({ meta: { cursor: 'mac' }, steps: [
        { id: 'open', time: 0.5, action: 'click', target: '#item-3' },
        { id: 'closing', time: 1.5, action: 'fadeIn', target: '#cinematic-text' },
    ] });
    const launched = await launchPage({ width: 1280, height: 720, deviceScaleFactor: 1 });
    try {
        const { page } = launched;
        await page.goto(fileUrl(path.join(dir, 'index.html')), { waitUntil: 'load' });
        await ensureRuntime(page, timeline, { drift: false });
        await page.evaluate(() => (window as any).__anim.start());
        // The spotlight sits on #item-3 first, so the mark on #cinematic-text has to move.
        await page.evaluate(() => (window as any).__anim.holdHighlight(document.querySelector('#item-3')));
        const r: any = await page.evaluate((s) => (window as any).__anim.runStep(s, { leadMs: 0 }), timeline.steps[1]);
        await page.evaluate((t) => (window as any).__anim.whenDone(t), r.token);
        const early = await page.evaluate(() => getComputedStyle(document.querySelector('#cinematic-text')!).opacity);
        const settled: any = await page.evaluate(() => (window as any).__anim.whenSettled({ timeoutMs: 10000 }));
        const late = await page.evaluate(() => getComputedStyle(document.querySelector('#cinematic-text')!).opacity);
        assert.equal(late, '1', `opacity after whenSettled (was ${early} at completion; waited ${settled.waited}ms for ${settled.animations} animation(s))`);
        assert.equal(settled.timedOut, false);
        assert.ok(settled.waited < 9000, `did not hit the hang guard: ${settled.waited}ms`);
        const m: any = await page.evaluate(() => {
            const a = (window as any).__anim;
            const marks = a.markStep({ target: '#cinematic-text', number: 3 });
            const h = document.getElementById('anim-cli-highlight')!;
            const b = h.getBoundingClientRect();
            return { rect: marks.rect, box: { x: b.left, y: b.top, width: b.width, height: b.height }, animations: h.getAnimations().length };
        });
        // Measured right after markStep, before any frame: the box is already on its final geometry
        // (6px padding around the rect, plus the box's own 2px border on each side in its bounding rect).
        assert.equal(m.animations, 0, 'no transition running on the held spotlight');
        assert.ok(Math.abs(m.box.x - (m.rect.x - 6)) <= 1 && Math.abs(m.box.width - (m.rect.width + 16)) <= 1, `spotlight snapped: box ${JSON.stringify(m.box)} vs rect ${JSON.stringify(m.rect)}`);
        assert.ok(Math.abs(m.box.y - (m.rect.y - 6)) <= 1 && Math.abs(m.box.height - (m.rect.height + 16)) <= 1);
        // A page with an endless animation does not hold the capture for the whole guard.
        await page.evaluate(() => { const st = document.createElement('style'); st.textContent = '@keyframes spin { to { transform: rotate(360deg) } } #spinner { animation: spin 1s linear infinite; }'; document.head.appendChild(st); const d = document.createElement('div'); d.id = 'spinner'; d.textContent = 'x'; document.body.appendChild(d); });
        const spin: any = await page.evaluate(() => (window as any).__anim.whenSettled({ timeoutMs: 10000 }));
        assert.equal(spin.animations, 0, 'infinite animations are skipped');
    } finally {
        await launched.close();
    }
});
