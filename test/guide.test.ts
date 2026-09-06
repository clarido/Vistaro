import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseTimeline } from '../src/engine/schema';
import { isGuideStep, cropBox } from '../src/guide/capture';
import { renderMarkdown, renderHtml, stepHeading, GuideJson } from '../src/guide/render';
import { hashGuideDir } from '../src/catalog';
import { listChapters } from '../src/media/ffmpeg';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8' });

const pngSize = (file: string) => { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

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
            { index: 2, number: 1, id: 'open', action: 'click', target: '#btn', scheduledMs: 1000, actualMs: 1003, title: 'Open the panel', subtitle: 'Open it.', note: 'Top left.', image: 'assets/step-02.png', crop: 'assets/step-02.crop.png', rect: { x: 1, y: 2, width: 3, height: 4 }, callout: { number: 1, x: -21, y: -20 } },
            { index: 3, number: 2, id: 'name', action: 'type', target: '#field', scheduledMs: 2000, actualMs: 2001, image: 'assets/step-03.png', rect: null, callout: null },
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
    fs.writeFileSync(path.join(d, 'index.html'), '<p>b</p>');
    assert.notEqual(hashGuideDir(d), h1);
    assert.match(h1, /^sha256:[0-9a-f]{64}$/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('guide <dir> without a video: screenshots, crops, callouts, guide.json/.md/.html', { skip }, () => {
    const dir = path.join(work, 'basic');
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
    assert.deepEqual(click.callout, { number: 1, x: click.rect!.x - 22, y: click.rect!.y - 22 });
    assert.equal(click.image, 'assets/step-02.png');
    assert.equal(click.crop, 'assets/step-02.crop.png');
    for (const s of g.steps) {
        assert.ok(fs.existsSync(path.join(dir, 'guide', s.image)), s.image);
        assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);
    }
    assert.deepEqual(pngSize(path.join(dir, 'guide', click.image)), { width: 2560, height: 1600 });
    const crop = pngSize(path.join(dir, 'guide', click.crop!));
    const expected = cropBox(click.rect!, 120, { width: 1280, height: 800 });
    assert.ok(Math.abs(crop.width - expected.width * 2) <= 2 && Math.abs(crop.height - expected.height * 2) <= 2, `crop ${JSON.stringify(crop)} vs ${JSON.stringify(expected)}`);
    assert.ok(crop.width < 2560);
    const caret = g.steps.find(s => s.id === 'caret')!;
    assert.ok(caret.rect && caret.rect.width > 100, 'caret step uses the sized ancestor box');
    assert.ok(fs.existsSync(path.join(dir, 'guide', 'assets', 'poster.png')));
    const md = fs.readFileSync(path.join(dir, 'guide', 'guide.md'), 'utf8');
    assert.match(md, /^# Basic fixture/);
    assert.match(md, /## 1\. Open the panel/);
    assert.match(md, /> Open it\./);
    assert.ok(fs.existsSync(path.join(dir, 'guide', 'guide.html')));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    assert.equal(manifest.history.at(-1).command, 'guide');
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
    assert.match(html, /<track kind="subtitles" src="\.\.\/out\.vtt"/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    assert.equal(manifest.history.at(-1).guide, path.join(work, 'g'));
});
