import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { parseTimeline, validateTimeline, ASPECT_PRESETS } from '../src/engine/schema';
import { effectiveSettings, readCatalog, guideSourceFiles } from '../src/catalog';
import { buildTranscript } from '../src/media/vtt';
import { mixAudio, measureLoudness, audioStreamCount, probeDurationMs } from '../src/media/ffmpeg';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';
import { countOrphans, assertNoNewOrphans } from './orphans';

/**
 * Lot 4 of docs/next-level-plan.md: meta.audio (clicks, a music bed ducked under narration,
 * normalised loudness), --aspect presets, --burn-subtitles and the plain-text transcript. Real
 * ffmpeg encodes throughout (docs/testing-discipline.md rule 5): the audio claims are measured on
 * the files, not inferred from the filter graph.
 */

const root = path.resolve(__dirname, '..');
const skip = process.env.SKIP_BROWSER === '1';
const ffmpeg: string = require('ffmpeg-static');
const PROBE_TIMEOUT_MS = 60000;
const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};
/** Generate a test signal with ffmpeg's lavfi sources. */
const synth = (src: string, out: string, extra: string[] = []) => {
    const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, ...extra, out], { timeout: PROBE_TIMEOUT_MS });
    assert.equal(r.status, 0, String(r.stderr));
};
const dimensions = (file: string) => {
    const head = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }).stderr;
    const m = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(head);
    assert.ok(m, `no video stream in ${file}`);
    return { width: +m![1], height: +m![2] };
};

let work: string;
let orphanBaseline = -1;
before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-channels-'));
    orphanBaseline = countOrphans();
});
after(() => {
    if (!skip) assertNoNewOrphans(orphanBaseline, 'channels.test.ts');
    fs.rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------- static

test('meta.audio is validated; an aspect preset resolves to width/height in the catalog', () => {
    const msgs = validateTimeline(parseTimeline({ meta: { audio: { click: 3, musicVolume: 6, loudness: -2, bass: true } }, steps: [] })).map(i => `${i.level}: ${i.message}`).join('\n');
    assert.match(msgs, /error: meta\.audio\.click must be true, false, or a path/);
    assert.match(msgs, /error: meta\.audio\.musicVolume must be a gain in dB, 0 or below/);
    assert.match(msgs, /error: meta\.audio\.loudness must be a target in LUFS/);
    assert.match(msgs, /warning: meta\.audio: unknown key "bass"/);
    assert.deepEqual(validateTimeline(parseTimeline({ meta: { audio: { click: true, music: 'bed.mp3' } }, steps: [] })).filter(i => i.field === 'audio'), []);

    assert.deepEqual(effectiveSettings({ slug: 'a', dir: 'a', aspect: '9:16' } as any), { ...effectiveSettings({ slug: 'a', dir: 'a' } as any), width: 1080, height: 1920 });
    // A guide's own width/height beat a default aspect; a guide's aspect beats default width/height.
    assert.equal(effectiveSettings({ slug: 'a', dir: 'a', width: 800, height: 600 } as any, { aspect: '1:1' } as any).width, 800);
    assert.equal(effectiveSettings({ slug: 'a', dir: 'a', aspect: '1:1' } as any, { width: 800, height: 600 } as any).height, 1080);
    // The catalog refuses an unknown preset and a preset mixed with explicit dimensions.
    const dir = path.join(work, 'catalog');
    fs.mkdirSync(path.join(dir, 'g'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'g', 'index.html'), '<!doctype html><body></body>');
    fs.writeFileSync(path.join(dir, 'g', 'anim.config.json'), JSON.stringify({ steps: [] }));
    const file = path.join(dir, 'help.catalog.json');
    fs.writeFileSync(file, JSON.stringify({ outputDir: 'out', guides: [{ slug: 'g', dir: 'g', aspect: '4:3' }, { slug: 'h', dir: 'g', aspect: '1:1', width: 10 }] }));
    assert.throws(() => readCatalog(file), (e: any) => /"aspect" must be one of "16:9", "1:1", "9:16"/.test(e.message) && /"aspect" is a shorthand for width\/height/.test(e.message));
    for (const [name, size] of Object.entries(ASPECT_PRESETS)) assert.ok(size.width > 0 && size.height > 0, name);
});

test('the transcript lists titles and spoken words in order, with timestamps', () => {
    const tl = parseTimeline({ meta: { title: 'Create a report' }, steps: [
        { id: 'a', time: 0, action: 'wait', title: 'Overview', subtitle: 'Welcome <b>back</b>.' },
        { id: 'b', time: 2, action: 'click', target: '#x', title: 'Open the builder', subtitle: 'Shown', narration: 'Click the button to begin.' },
        { id: 'c', time: 3, action: 'camera', scale: 1.2, guide: false },
        { id: 'd', time: 65, action: 'highlight', target: '#y', subtitle: 'Done.' },
    ] });
    assert.equal(buildTranscript(tl), 'Create a report\n\n[0:00] Overview\nWelcome back.\n\n[0:02] Open the builder\nClick the button to begin.\n\n[1:05]\nDone.\n');
});

test('the audio guide sources are hashed: editing the music bed rebuilds the guide', () => {
    const dir = path.join(work, 'hash');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body></body>');
    fs.writeFileSync(path.join(dir, 'bed.mp3'), 'x');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { audio: { music: 'bed.mp3', click: true } }, steps: [] }));
    assert.ok(guideSourceFiles(dir).includes(path.join(dir, 'bed.mp3')));
});

// ------------------------------------------------------------------------------ real ffmpeg

test('mixAudio: one stream, the video\'s length, loudness on target; clicks alone are not pumped up', { skip }, () => {
    const narr = path.join(work, 'narr.m4a');
    const bed = path.join(work, 'bed.wav');
    synth('sine=frequency=300:duration=2', narr, ['-af', 'adelay=1000|1000']);
    synth('anoisesrc=d=3:c=pink:a=0.3', bed);
    const out = mixAudio({ durationMs: 5000, narration: narr, music: bed, clicksAtMs: [500, 2500, 4000] }, path.join(work, 'mix.m4a'));
    assert.equal(audioStreamCount(out), 1);
    assert.ok(Math.abs(probeDurationMs(out) - 5000) < 100, `mix lasts the video's 5 s (got ${probeDurationMs(out)}ms)`);
    const lufs = measureLoudness(out);
    assert.ok(Math.abs(lufs - -16) <= 1, `integrated loudness ${lufs} LUFS, target -16`);
    const social = mixAudio({ durationMs: 5000, music: bed, loudnessLufs: -14 }, path.join(work, 'social.m4a'));
    assert.ok(Math.abs(measureLoudness(social) - -14) <= 1, 'a -14 LUFS target is honoured');
    const clicks = mixAudio({ durationMs: 5000, clicksAtMs: [500] }, path.join(work, 'clicks.m4a'));
    assert.ok(measureLoudness(clicks) < -24, `a lone click stays a click (${measureLoudness(clicks)} LUFS), not programme loudness`);
    assert.equal(fs.readdirSync(work).filter(f => f.includes('premix')).length, 0, 'the two-pass intermediate is cleaned up');
});

/** A tiny reel: a white page with a heading, one subtitled beat, one click. */
function reelDir(name: string, meta: Record<string, unknown>): string {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body style="margin:0;background:#fff"><h1 style="margin:40px">Clip</h1><button id="go" style="margin:40px">Go</button></body></html>');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({
        meta: { kind: 'reel', tailMs: 600, cursor: 'none', ...meta },
        steps: [
            { id: 'say', time: 0.3, action: 'wait', subtitle: 'Captions burned in' },
            { id: 'go', time: 1, action: 'click', target: '#go' },
        ],
    }, null, 2));
    return dir;
}

test('a reel is silent without meta.audio, and has one audio stream with it', { skip }, () => {
    const silentOut = path.join(work, 'silent.mp4');
    let r = cli(['export', reelDir('silent', {}), '-o', silentOut, '-w', '640', '-H', '360']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(audioStreamCount(silentOut), 0, 'a reel stays silent unless it opts in');
    const loudOut = path.join(work, 'clicked.mp4');
    r = cli(['export', reelDir('clicked', { audio: { click: true } }), '-o', loudOut, '-w', '640', '-H', '360']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(audioStreamCount(loudOut), 1);
    assert.match(r.stdout, /Mixing audio: 1 click\(s\)/);
});

test('--burn-subtitles draws the caption into a reel that otherwise has none', { skip }, () => {
    /** Mean luminance of the band where the stadium chip sits, at 0.8 s (inside the cue). */
    const band = (file: string) => {
        const res = spawnSync(ffmpeg, ['-v', 'error', '-ss', '0.8', '-i', file, '-frames:v', '1', '-vf', 'crop=iw*0.6:ih*0.25:iw*0.2:ih*0.7,scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 });
        return res.stdout[0];
    };
    const plain = path.join(work, 'plain.mp4');
    const burned = path.join(work, 'burned.mp4');
    assert.equal(cli(['export', reelDir('plain', {}), '-o', plain, '-w', '640', '-H', '360']).status, 0);
    const r = cli(['export', reelDir('burned', {}), '-o', burned, '-w', '640', '-H', '360', '--burn-subtitles']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(band(plain) > 240, `no caption: the band is the white page (${band(plain)})`);
    assert.ok(band(burned) < band(plain) - 30, `the dark caption chip darkens the band (${band(burned)} vs ${band(plain)})`);
});

test('--aspect presets produce their stated frames, refuse explicit sizes, and the transcript lands beside the .vtt', { skip }, () => {
    const dir = path.join(work, 'aspect');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body style="margin:0"><button id="go" style="margin:40px">Go</button></body></html>');
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { title: 'Aspect', tailMs: 300 }, steps: [{ id: 'go', time: 0.5, action: 'click', target: '#go', title: 'Press go', subtitle: 'Press it.' }] }));
    for (const [aspect, size] of Object.entries(ASPECT_PRESETS)) {
        const out = path.join(work, `aspect-${aspect.replace(':', 'x')}.mp4`);
        const r = cli(['export', dir, '-o', out, '--aspect', aspect]);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.deepEqual(dimensions(out), size, `--aspect ${aspect}`);
    }
    const transcript = fs.readFileSync(path.join(work, 'aspect-16x9.txt'), 'utf8');
    assert.match(transcript, /^Aspect\n\n\[0:0\d\] Press go\nPress it\.\n$/);
    const refused = cli(['export', dir, '-o', path.join(work, 'x.mp4'), '--aspect', '1:1', '-w', '800']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--aspect is a shorthand for --width\/--height/);
});
