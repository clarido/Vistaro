import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { probeDurationMs, listChapters } from '../src/media/ffmpeg';
import { parseTimeline, computeDurationMs } from '../src/engine/schema';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

let work: string;
before(() => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-export-'));
    fs.cpSync(fixture, path.join(work, 'basic'), { recursive: true });
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

test('export: driven recording, auto duration, .vtt, chapters, manifest', { skip }, () => {
    const dir = path.join(work, 'basic');
    const out = path.join(work, 'out.mp4');
    const r = cli(['export', dir, '-o', out, '--width', '1280', '--height', '800']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(out));
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8')));
    const estimate = computeDurationMs(tl);
    assert.equal(estimate, 6300);
    // #banner has `transition: opacity 3s`, so the fadeIn at 4s completes at ~7s: export must hold
    // until measured completion + tailMs (1000) instead of trusting the 800ms static estimate.
    assert.match(r.stdout, /Extending to 8\.\d+s: the last step completed at 7\d\d\dms/);
    const measured = probeDurationMs(out);
    assert.ok(measured >= 7750 && measured <= 8750, `duration ${measured} should be ~8000 (estimate ${estimate})`);

    const vtt = fs.readFileSync(path.join(work, 'out.vtt'), 'utf8');
    assert.ok(vtt.startsWith('WEBVTT'));
    assert.match(vtt, /\nintro\n00:00:00\.\d{3} --> 00:00:0[01]\.\d{3}\nWelcome\.\n/);
    assert.match(vtt, /\nopen\n00:00:0[01]\.\d{3} --> /);

    const chapters = listChapters(out);
    assert.ok(chapters.length >= 5, `chapters: ${JSON.stringify(chapters)}`);
    assert.equal(chapters[0].title, 'Overview');
    assert.equal(chapters[1].title, 'Open the panel');
    assert.ok(Math.abs(chapters[1].startMs - 1000) <= 150, `chapter 2 starts at ${chapters[1].startMs}`);

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    const last = manifest.history.at(-1);
    assert.equal(last.command, 'export');
    assert.equal(last.driven, true);
    assert.equal(last.chapters, chapters.length);
    assert.equal(last.steps.length, 8);
    assert.ok(Math.abs(last.duration * 1000 - measured) <= 750, 'manifest records the real export length');
    assert.ok(last.steps[6].completedMs >= last.steps[6].actualMs + 2900, 'banner fade completion measured');
});

test('export: --duration override, --no-subtitles, --no-chapters, gif output', { skip }, () => {
    const dir = path.join(work, 'basic');
    const out = path.join(work, 'short.mp4');
    const r = cli(['export', dir, '-o', out, '--duration', '2.5', '--no-subtitles', '--no-chapters', '--width', '640', '--height', '400']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(Math.abs(probeDurationMs(out) - 2500) <= 750);
    assert.ok(!fs.existsSync(path.join(work, 'short.vtt')));
    assert.equal(listChapters(out).length, 0);
    const gif = path.join(work, 'short.gif');
    const g = cli(['export', dir, '-o', gif, '--duration', '1.5', '--width', '320', '--height', '200']);
    assert.equal(g.status, 0, g.stderr + g.stdout);
    assert.ok(fs.statSync(gif).size > 1000);
});

test('export: validation errors exit 1 without --force; legacy dir without config still records', { skip }, () => {
    const bad = path.join(work, 'bad');
    fs.cpSync(fixture, bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'anim.config.json'), JSON.stringify([{ time: 1, action: 'jump', target: '#btn' }]));
    const r = cli(['export', bad, '-o', path.join(work, 'bad.mp4'), '--width', '320', '--height', '200']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown action "jump"/);
    assert.ok(!fs.existsSync(path.join(work, 'bad.mp4')));
    assert.ok(!fs.existsSync(path.join(bad, '.temp-video')), 'temp dir cleaned up on failure');

    const legacy = path.join(work, 'legacy');
    fs.mkdirSync(legacy);
    fs.copyFileSync(path.join(fixture, 'index.html'), path.join(legacy, 'animated.html'));
    const l = cli(['export', legacy, '-o', path.join(work, 'legacy.mp4'), '--duration', '1', '--width', '320', '--height', '200']);
    assert.equal(l.status, 0, l.stderr + l.stdout);
    assert.match(l.stdout, /blind/);
    assert.ok(Math.abs(probeDurationMs(path.join(work, 'legacy.mp4')) - 1000) <= 750);
});

test('export --narration mixes per-step TTS (macOS say) and caches clips', { skip: skip || process.platform !== 'darwin' || process.env.SKIP_TTS === '1' }, () => {
    const dir = path.join(work, 'basic');
    const out = path.join(work, 'narrated.mp4');
    const r = cli(['export', dir, '-o', out, '--narration', '--width', '640', '--height', '400'], { OPENAI_API_KEY: '' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /narration mixed in/);
    const cache = fs.readdirSync(path.join(dir, '.cache', 'tts'));
    assert.equal(cache.length, 2, 'two narrated steps (intro, open) -> two cached clips');
    const info = spawnSync(require('ffmpeg-static'), ['-i', out], { encoding: 'utf8' }).stderr;
    assert.match(info, /Stream #0:1.*Audio: aac/);
    const again = cli(['export', dir, '-o', out, '--narration', '--width', '640', '--height', '400'], { OPENAI_API_KEY: '' });
    assert.equal(again.status, 0);
    assert.ok(!/tts step/.test(again.stdout), 'second run hits the cache');
});
