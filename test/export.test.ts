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
/** ffmpeg probes run in-process; bounded so a wedged decode fails here instead of leaning on the runner cap. */
const FFMPEG_PROBE_TIMEOUT_MS = 120000;
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

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    const last = manifest.history.at(-1);
    // Chapters are cut at the moment the step actually ran in this recording, not at its scheduled
    // time: comparing the two same-run numbers holds whatever the machine was doing.
    const openStep = last.steps.find((s: any) => s.id === 'open');
    assert.ok(Math.abs(chapters[1].startMs - openStep.actualMs) <= 120, `chapter 2 at ${chapters[1].startMs}ms vs the measured step at ${openStep.actualMs}ms`);
    assert.equal(last.command, 'export');
    assert.equal(last.driven, true);
    assert.equal(last.output, '../out.mp4', 'output recorded relative to the dir');
    assert.match(last.contentHash, /^sha256:/);
    assert.equal(last.chapters, chapters.length);
    assert.equal(last.steps.length, 9);
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

test('export: a step that fails outright (missing target) still writes the video but exits 1 and names the step', { skip }, () => {
    const dir = path.join(work, 'failing');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify([
        { time: 0.5, action: 'click', target: '#definitely-not-here', title: 'Missing' },
        { time: 1.5, action: 'click', target: '#btn', title: 'Real' },
    ]));
    const out = path.join(work, 'failing.mp4');
    const r = cli(['export', dir, '-o', out, '--width', '320', '--height', '200']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /FAILED: 1 step\(s\) failed during the recording: step 1 \(click #definitely-not-here\)/);
    assert.ok(!/Success!/.test(r.stdout));
    assert.ok(fs.existsSync(out), 'the video is still written for inspection');
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.match(ev.steps[0].error, /target not found/);
    assert.equal(ev.steps[1].error, undefined);
});

test('export: a built page without a config self-plays during the blind wait', { skip }, () => {
    const dir = path.join(work, 'selfplay');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><style>body{margin:0;background:#fff;height:100vh}</style></head><body><button id="b" onclick="document.body.style.background=\'#f00\'">go</button></body></html>');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { tailMs: 400, cursor: 'none', drift: false }, steps: [{ time: 0.5, action: 'click', target: '#b' }] }));
    assert.equal(cli(['build', dir]).status, 0);
    fs.rmSync(path.join(dir, 'anim.config.json'));
    const out = path.join(work, 'selfplay.mp4');
    const r = cli(['export', dir, '-o', out, '--duration', '1.5', '--width', '320', '--height', '200']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /self-plays/);
    const frames = samplePixels(out, 300, 190);
    assert.ok(frames.some(f => f.r > 200 && f.g < 80), 'the click ran: a red frame exists');
});

test('export records index.html with the runtime injected, never a stale animated.html: an edit after build shows in the video', { skip }, () => {
    const dir = path.join(work, 'edited');
    fs.mkdirSync(dir);
    const page = (bg: string) => `<!doctype html><html><head><style>body{margin:0;background:${bg};height:100vh}</style></head><body><button id="b">go</button></body></html>`;
    fs.writeFileSync(path.join(dir, 'index.html'), page('#fff'));
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { tailMs: 400, cursor: 'none', drift: false }, steps: [{ time: 0.5, action: 'click', target: '#b' }] }));
    assert.equal(cli(['build', dir]).status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'animated.html'), 'utf8'), /#fff/);
    // Edit the source after the build: the video must show blue, which only index.html has.
    fs.writeFileSync(path.join(dir, 'index.html'), page('#00f'));
    const out = path.join(work, 'edited.mp4');
    const r = cli(['export', dir, '-o', out, '--width', '320', '--height', '200']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const frames = samplePixels(out, 300, 190);
    assert.ok(frames.length > 5);
    assert.ok(frames.every(f => f.b > 200 && f.r < 80), `every frame is blue (index.html), not white (animated.html): ${JSON.stringify(frames.slice(0, 3))}`);
});

/** Per-frame colour of one pixel plus its timestamp, straight from ffmpeg. */
function samplePixels(file: string, x: number, y: number): { ptsMs: number; r: number; g: number; b: number }[] {
    // Convert to RGB before cropping: a 1x1 crop is invalid on yuv420p (chroma planes round to 0). 2x2 block = 12 bytes/frame.
    const res = spawnSync(require('ffmpeg-static'), ['-i', file, '-vf', `format=rgb24,crop=2:2:${x}:${y},showinfo`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_PROBE_TIMEOUT_MS });
    const pts = [...res.stderr.toString().matchAll(/pts_time:\s*([\d.]+)/g)].map(m => Math.round(parseFloat(m[1]) * 1000));
    const px = res.stdout;
    return pts.map((ptsMs, i) => ({ ptsMs, r: px[i * 12], g: px[i * 12 + 1], b: px[i * 12 + 2] }));
}

test('export: the first changed video frame lands within one frame of the measured actualMs', { skip }, () => {
    const dir = path.join(work, 'flash');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><style>body{margin:0;background:#fff;height:100vh}button{position:absolute;left:10px;top:10px}</style></head><body><button id="b" onclick="document.body.style.background=\'#f00\'">go</button></body></html>');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { tailMs: 600, cursor: 'none', drift: false }, steps: [{ time: 1, action: 'click', target: '#b' }] }));
    const out = path.join(work, 'flash.mp4');
    const r = cli(['export', dir, '-o', out, '--width', '320', '--height', '200', '--no-chapters', '--no-subtitles']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8'));
    const actualMs: number = manifest.history.at(-1).steps[0].actualMs;
    const frames = samplePixels(out, 300, 190);
    assert.ok(frames.length > 20, `frames: ${frames.length}`);
    const first = frames.findIndex(f => f.r > 200 && f.g < 80);
    assert.ok(first > 0, 'a red frame exists after a white one');
    const frameMs = frames[1].ptsMs - frames[0].ptsMs;
    const delta = frames[first].ptsMs - actualMs;
    assert.ok(Math.abs(delta) <= frameMs * 1.5 + 5, `first red frame at ${frames[first].ptsMs}ms vs actualMs ${actualMs}ms (delta ${delta}ms, frame ${frameMs}ms)`);
});

test('export --narration mixes per-step TTS (macOS say) and caches clips', { skip: skip || process.platform !== 'darwin' || process.env.SKIP_TTS === '1' }, () => {
    const dir = path.join(work, 'basic');
    const out = path.join(work, 'narrated.mp4');
    const r = cli(['export', dir, '-o', out, '--narration', '--width', '640', '--height', '400'], { OPENAI_API_KEY: '' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /narration mixed in/);
    const cache = fs.readdirSync(path.join(dir, '.cache', 'tts'));
    assert.equal(cache.length, 2, 'two narrated steps (intro, open) -> two cached clips');
    const info = spawnSync(require('ffmpeg-static'), ['-i', out], { encoding: 'utf8', timeout: FFMPEG_PROBE_TIMEOUT_MS }).stderr;
    assert.match(info, /Stream #0:1.*Audio: aac/);
    const again = cli(['export', dir, '-o', out, '--narration', '--width', '640', '--height', '400'], { OPENAI_API_KEY: '' });
    assert.equal(again.status, 0);
    assert.ok(!/tts step/.test(again.stdout), 'second run hits the cache');
});

test('a reel export ships mp4 + webm + poster + gif, silent, with no subtitles or chapters', { skip }, () => {
    // Video-level on purpose: guide capture hides the subtitle bar, so nothing that compares frames
    // can see a subtitle or audio regression. These assertions read the container itself.
    const dir = path.join(work, 'reel');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body { margin: 0; background: #fff; height: 100vh; }
      #card { margin: 40px; height: 120px; background: #4F46E5; opacity: 0; }
    </style></head><body><div id="card"></div></body></html>`);
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({
        meta: { kind: 'reel', title: 'Clip', cursor: 'none', tailMs: 300, reel: { loop: true } },
        steps: [
            { id: 'in', time: '0.3s', action: 'animate', target: '#card', from: { opacity: 0, y: 20 }, to: { opacity: 1, y: 0 }, duration: 0.4 },
            { id: 'sub', time: '1.0s', action: 'wait', subtitle: 'this must not become a .vtt' },
        ],
    }));
    const out = path.join(work, 'clip.mp4');
    const r = cli(['export', dir, '-o', out, '--width', '320', '--height', '200']);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const base = out.replace(/\.mp4$/, '');
    for (const f of [out, base + '.webm', base + '.poster.png', base + '.gif']) {
        assert.ok(fs.existsSync(f), `${path.basename(f)} written`);
        assert.ok(fs.statSync(f).size > 0, `${path.basename(f)} is not empty`);
    }
    assert.ok(!fs.existsSync(base + '.vtt'), 'a reel writes no .vtt even when a step has a subtitle');
    assert.equal(listChapters(out).length, 0, 'and no chapters');

    // The MP4 must carry no audio stream at all, not merely a silent one.
    const probe = spawnSync(require('ffmpeg-static'), ['-i', out], { encoding: 'utf8', timeout: FFMPEG_PROBE_TIMEOUT_MS });
    const info = probe.stderr || '';
    assert.ok(/Stream .*Video/.test(info), 'the video stream is there');
    assert.ok(!/Stream .*Audio/.test(info), `no audio stream: ${info.split('\n').filter(l => /Stream/.test(l)).join(' | ')}`);
    assert.match(info, /1[68]0x200|320x200/, 'encoded at the requested viewport');

    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.equal(ev.command, 'export');
    assert.equal(ev.subtitles, false, 'the manifest records that no subtitle file was written');
});

test('preview and export render a reel under the same emulation, and a guide under none', { skip }, () => {
    // The authoring loop is "preview, read the PNG, fix the timeline, repeat". If preview renders a
    // reel under different conditions than export, that loop disagrees with the shipped artifact --
    // and a test that checked export alone would not notice. This pins the two paths together.
    const page = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><style>
      body { margin: 0; background: #fff; height: 100vh; }
      #flag { position: absolute; left: 0; top: 0; width: 200px; height: 200px; background: #00a000; }
      @media (pointer: coarse) { #flag { background: #c00000; } }
    </style></head><body><div id="flag"></div></body></html>`;
    const steps = [{ id: 'a', time: '0.3s', action: 'animate', target: '#flag', from: { opacity: 0.99 }, to: { opacity: 1 }, duration: 0.2 }];
    const mk = (name: string, meta: Record<string, unknown>) => {
        const dir = path.join(work, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), page);
        fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta, steps }));
        return dir;
    };
    const reelDir = mk('emu-reel', { kind: 'reel', title: 'Reel', cursor: 'none', tailMs: 300 });
    const guideDir = mk('emu-guide', { title: 'Guide', cursor: 'none', tailMs: 300 });

    // Sample the flag well inside its 200px box, in both a preview PNG and a frame of the video.
    const flagOf = (file: string) => {
        const b = fs.readFileSync(file);
        const png = require('pngjs').PNG.sync.read(b);
        const i = (png.width * 40 + 40) * 4;
        return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    // Lossy video shifts the exact bytes (192,0,0 becomes 189,0,1), so classify rather than compare.
    const coarse = (c: number[]) => c[0] > 150 && c[1] < 80;
    const fine = (c: number[]) => c[1] > 120 && c[0] < 80;

    const previewFlag = (dir: string, name: string) => {
        const out = path.join(work, name + '.png');
        const r = cli(['preview', dir, '--device', 'mobile', '--step', '1', '-o', out]);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        return flagOf(out);
    };
    const exportFlag = (dir: string, name: string) => {
        const out = path.join(work, name + '.mp4');
        const r = cli(['export', dir, '-o', out, '--device', 'mobile']);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const frame = path.join(work, name + '-frame.png');
        spawnSync(require('ffmpeg-static'), ['-y', '-ss', '0.6', '-i', out, '-frames:v', '1', frame], { encoding: 'utf8', timeout: FFMPEG_PROBE_TIMEOUT_MS });
        assert.ok(fs.existsSync(frame), 'a frame was extracted');
        return flagOf(frame);
    };

    const reelPreview = previewFlag(reelDir, 'reel-preview');
    const reelExport = exportFlag(reelDir, 'reel-export');
    assert.ok(coarse(reelPreview), `reel previews with pointer: coarse (got ${reelPreview})`);
    assert.ok(coarse(reelExport), `reel exports with pointer: coarse (got ${reelExport})`);

    // The control: the same page as a guide must emulate on neither path, or a mockup with no
    // viewport meta would be laid out at 980px and shrunk.
    const guidePreview = previewFlag(guideDir, 'guide-preview');
    assert.ok(fine(guidePreview), `guide previews with pointer: fine (got ${guidePreview})`);
});
