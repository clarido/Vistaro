import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { run } from '../src/media/ffmpeg';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';

const root = path.resolve(__dirname, '..');
const skip = process.env.SKIP_BROWSER === '1';

const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env } });
    assertRan(res, args);
    return res;
};

let work: string;
let video: string;

test.before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-strip-test-'));
    // A synthetic clip: testsrc never stops moving, so the diff facts have something to find, and
    // lavfi costs milliseconds where exporting a real timeline would cost a browser session.
    video = path.join(work, 'clip.mp4');
    run(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', video]);
});

test.after(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

test('filmstrip writes a labelled strip and --diff writes motion facts', { skip }, () => {
    const strip = path.join(work, 'clip.strip.png');
    const facts = path.join(work, 'clip.motion.json');
    const r = cli(['filmstrip', video, '--fps', '2', '--diff', facts]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Wrote .*clip\.strip\.png \(6 frames/);
    assert.ok(fs.existsSync(strip));
    assert.ok(fs.statSync(strip).size > 10000, `the strip carries real tiles: ${fs.statSync(strip).size} bytes`);

    const intervals: any[] = JSON.parse(fs.readFileSync(facts, 'utf8'));
    assert.equal(intervals.length, 5, 'one interval per consecutive pair of the 6 samples');
    assert.ok(intervals.every(i => typeof i.fromSec === 'number' && typeof i.toSec === 'number'));
    assert.ok(intervals.every(i => i.changedFraction >= 0 && i.changedFraction <= 1));
    // testsrc's counter and sliding bars change in a band across the middle of the frame every
    // sampled interval: there IS motion, and each interval carries its bounding box in fractions.
    assert.ok(intervals.every(i => i.changedFraction > 0), 'every interval of a moving test pattern moves');
    assert.ok(intervals.every(i => i.bbox && i.bbox.w > 0 && i.bbox.w <= 1 && i.bbox.h > 0 && i.bbox.h <= 1));
});

test('filmstrip lowers the sample rate when the video is long, keeping the strip readable', { skip }, () => {
    const long = path.join(work, 'long.mp4');
    run(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x240:rate=10', '-pix_fmt', 'yuv420p', long]);
    const r = cli(['filmstrip', long, '--fps', '4', '--max-tiles', '12']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // 30s at fps 4 would be 120 tiles; the cap forces the rate down so the count stays at ~12.
    const m = /\((\d+) frames/.exec(r.stdout);
    assert.ok(m, `frame count printed: ${r.stdout}`);
    const count = parseInt(m[1], 10);
    assert.ok(count >= 10 && count <= 12, `sample rate dropped to keep the strip readable: ${count} frames`);
});

test('filmstrip refuses a file that is not a video', () => {
    const notVideo = path.join(work, 'not-a-video.mp4');
    fs.writeFileSync(notVideo, 'definitely not an mp4');
    const r = cli(['filmstrip', notVideo]);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /could not read a duration/);
});
