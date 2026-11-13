#!/usr/bin/env node
/**
 * Lot 5 spike (docs/next-level-plan.md): can a recording be frame-stepped at 60 fps under a
 * controlled clock, instead of Playwright's real-time recorder at a fixed 25 fps?
 *
 * Not product code and not wired into anything: it measures, and docs/spikes/capture-quality.md
 * records what it measured. Run from the repo root, one browser job at a time:
 *
 *   node docs/spikes/capture-spike.mjs test/fixtures/basic /tmp/spike
 *
 * Method A (today): `cli.ts export`, twice. Frame timing comes from the encoded file's pts.
 * Method B (spike): the self-playing animated.html under Playwright's fake clock (page.clock:
 * setTimeout, requestAnimationFrame, performance.now, Date). Each frame: advance the clock 1/60 s,
 * pin every Web Animation and CSS transition to the virtual time (they run on the compositor's
 * real clock otherwise), screenshot, pipe to ffmpeg. Twice, to test determinism.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) { console.error('usage: capture-spike.mjs <demo dir> <out dir>'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const BOUND = { timeout: 10 * 60 * 1000, killSignal: 'SIGKILL' };
const W = 1280, H = 720, FPS = 60;

function cli(args) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { encoding: 'utf8', ...BOUND });
    if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr}`);
    return r;
}

/** Per-frame pts (s) and md5 of a video, via ffmpeg's showinfo and framemd5. */
function frames(file) {
    const info = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-vf', 'showinfo', '-f', 'null', '-'], { encoding: 'utf8', ...BOUND }).stderr;
    const pts = [...info.matchAll(/pts_time:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const md5 = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8', ...BOUND }).stdout
        .split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
    return { pts, md5 };
}

function stats(pts) {
    const d = pts.slice(1).map((t, i) => (t - pts[i]) * 1000);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    return { frames: pts.length, meanMs: +mean.toFixed(2), sdMs: +sd.toFixed(2), maxMs: +Math.max(...d).toFixed(1), fps: +(1000 / mean).toFixed(1) };
}

function agreement(a, b) {
    const n = Math.min(a.length, b.length);
    let same = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
    return { compared: n, identical: same, share: +(same / n).toFixed(3), lengthA: a.length, lengthB: b.length };
}

/** Consecutive identical frames: what a stalled real-time recorder looks like in the file. */
function repeats(md5) {
    let r = 0;
    for (let i = 1; i < md5.length; i++) if (md5[i] === md5[i - 1]) r++;
    return r;
}

async function methodA(run) {
    const out = path.join(outDir, `realtime-${run}.mp4`);
    const t0 = Date.now();
    cli(['export', srcDir, '-o', out, '-w', String(W), '-H', String(H), '--no-chapters']);
    return { file: out, wallMs: Date.now() - t0, ...frames(out) };
}

async function methodB(run, browser) {
    const html = path.join(outDir, 'animated.html');
    cli(['build', srcDir, '-o', html]);
    const out = path.join(outDir, `stepped-${run}.mp4`);
    const t0 = Date.now();
    const context = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await context.newPage();
    await page.clock.install({ time: 0 });
    await page.goto('file://' + path.resolve(html));
    await page.waitForFunction(() => window.__anim && window.__anim.isReady());
    const durationMs = await page.evaluate(() => window.__anim.getState().opts.durationMs);
    const total = Math.ceil(durationMs / 1000 * FPS);
    const enc = spawn(ffmpeg, ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const shotHashes = [];
    for (let f = 0; f < total; f++) {
        await page.clock.runFor(1000 / FPS);
        // Pin every animation to the virtual clock: paused, and its currentTime derived from the
        // virtual time it was first seen at. CSS transitions and WAAPI animations otherwise follow
        // the compositor's real clock, which a fake clock does not touch.
        await page.evaluate(() => {
            const now = performance.now();
            for (const a of document.getAnimations()) {
                // First seen this frame: treat it as starting now (it was created during this
                // runFor, so its real-clock head start is a few ms of evaluate latency, i.e. noise).
                if (a.__pin === undefined) { a.__pin = now; try { a.pause(); } catch {} }
                try { a.currentTime = now - a.__pin; } catch {}
            }
        });
        const png = await page.screenshot({ type: 'png' });
        shotHashes.push(createHash('md5').update(png).digest('hex'));
        if (!enc.stdin.write(png)) await new Promise(r => enc.stdin.once('drain', r));
    }
    enc.stdin.end();
    await new Promise(r => enc.on('close', r));
    await context.close();
    return { file: out, wallMs: Date.now() - t0, durationMs, shotHashes, ...frames(out) };
}

const report = { fixture: srcDir, viewport: `${W}x${H}`, startedAt: new Date().toISOString() };
const a1 = await methodA(1), a2 = await methodA(2);
report.realtime = { run1: { wallMs: a1.wallMs, ...stats(a1.pts), repeatedFrames: repeats(a1.md5) }, run2: { wallMs: a2.wallMs, ...stats(a2.pts), repeatedFrames: repeats(a2.md5) }, determinism: agreement(a1.md5, a2.md5) };
const browser = await chromium.launch();
try {
    const b1 = await methodB(1, browser), b2 = await methodB(2, browser);
    report.stepped = { durationMs: b1.durationMs, run1: { wallMs: b1.wallMs, ...stats(b1.pts), repeatedFrames: repeats(b1.md5) }, run2: { wallMs: b2.wallMs, ...stats(b2.pts) }, determinismScreenshots: agreement(b1.shotHashes, b2.shotHashes), determinismEncoded: agreement(b1.md5, b2.md5) };
} finally {
    await browser.close();
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
