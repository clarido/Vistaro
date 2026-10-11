import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser } from 'playwright';
import { launchChromium } from '../browser';
import { run, probeDurationMs, describeAsset } from './ffmpeg';
import { renderContactSheet, SheetFrame } from './contactSheet';

export interface FilmstripOptions {
    output?: string;
    /** Samples per second to extract (default 2, lowered automatically when the video is long). */
    fps?: number;
    /** Tiles per row in the strip (default 6). */
    columns?: number;
    /** Tile width in px (default 480). */
    cellWidth?: number;
    /** Upper bound on tiles before the sample rate drops (default 48). */
    maxTiles?: number;
    /** Also write pairwise frame-diff motion facts to this JSON file. */
    diff?: string;
}

export interface MotionInterval {
    fromSec: number;
    toSec: number;
    /** Share of pixels that changed beyond the threshold, 0 to 1. */
    changedFraction: number;
    /** Bounding box of the change in frame fractions (0..1), or null when nothing changed. */
    bbox: { x: number; y: number; w: number; h: number } | null;
}

/** Comparison resolution: enough to locate a region, small enough to diff many pairs quickly. */
const DIFF_W = 160;
const DIFF_H = Math.round(DIFF_W * 9 / 16);
/** A channel must move this much (0-255) for a pixel to count as changed. */
const DIFF_DELTA = 24;

/**
 * `filmstrip <video>`: one labelled contact strip sampled out of an exported video -- the
 * artifact-level review that page-side previews cannot give, because the MP4 is a separate
 * encode path (subtitle burn-in, trims, filters). `--diff <file>` additionally diffs each
 * consecutive pair of samples and writes what-moved-when-where as JSON, which is the only way
 * to catch UNINTENDED motion: something animating when nothing should, invisible to every
 * authored-intent check because it was never authored.
 */
export async function filmstripCommand(video: string, options: FilmstripOptions = {}): Promise<void> {
    const abs = path.resolve(video);
    // Thrown rather than process.exit'd: the later two fire after the browser is up, and
    // process.exit skips the finally that closes it and removes the tmpdir (an orphaned Chromium
    // fails the suite's process check).
    const die = (msg: string): never => { throw new Error(msg); };
    if (!fs.existsSync(abs)) die(`${video} not found.`);
    const durationSec = probeDurationMs(abs) / 1000;
    if (!(durationSec > 0)) die(`could not read a duration from ${abs} (is it a video ffmpeg can decode?)`);
    const maxTiles = options.maxTiles && options.maxTiles > 0 ? options.maxTiles : 48;
    const askedFps = options.fps && options.fps > 0 ? options.fps : 2;
    // A long clip must not become a 60-row sheet nobody can read: the sample rate drops first.
    const fps = Math.max(0.05, Math.min(askedFps, maxTiles / durationSec));
    const columns = options.columns && options.columns > 0 ? options.columns : 6;
    const cellWidth = options.cellWidth && options.cellWidth > 0 ? options.cellWidth : 480;
    const output = options.output ? path.resolve(options.output) : abs.replace(/\.[^.]+$/, '') + '.strip.png';
    const diffFile = options.diff ? path.resolve(options.diff) : undefined;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-strip-'));
    // The launch sits inside the try (nullable, not awaited above it): a failed launch -- the
    // missing-engine refusal among them -- must still clean the tmpdir, not leak one per run.
    let browser: Browser | null = null;
    try {
        browser = await launchChromium({ headless: true });
        run(['-y', '-i', abs, '-vf', `fps=${fps},scale=${cellWidth}:-1`, path.join(tmp, 'f-%05d.png')]);
        let files = fs.readdirSync(tmp).filter(f => f.endsWith('.png')).sort();
        if (!files.length) die(`ffmpeg extracted no frames from ${abs}`);
        // The fps floor (0.05) means a very long video can still extract more than maxTiles; drop
        // the surplus evenly instead of breaking the cap the cap exists to enforce. Labels must use
        // each kept frame's ORIGINAL index, or the timestamps lie about which moment was sampled.
        const stride = Math.ceil(files.length / maxTiles);
        const kept = stride > 1 ? files.map((f, i) => ({ f, i })).filter(o => o.i % stride === 0) : files.map((f, i) => ({ f, i }));
        const frames: SheetFrame[] = kept.map(({ f, i }) => ({
            // Output frame k of an fps filter samples the input at k/fps: tile k is labelled with
            // the moment it shows, not the moment it was written.
            label: `t=${(i / fps).toFixed(1)}s / ${durationSec.toFixed(1)}s`,
            png: fs.readFileSync(path.join(tmp, f)),
        }));
        const sheet = await renderContactSheet(browser, frames, {
            title: `${path.basename(abs)} — ${frames.length} frames at ${fps.toFixed(2)}/s of ${durationSec.toFixed(1)}s`,
            columns,
            cellWidth,
        });
        fs.writeFileSync(output, sheet);
        console.log(`Wrote ${output} (${frames.length} frames, ${describeAsset(output)}). Read it to review the whole clip at a glance.`);

        if (diffFile) {
            const intervals = await diffFrames(browser, frames, fps);
            fs.writeFileSync(diffFile, JSON.stringify(intervals, null, 2) + '\n');
            const busiest = intervals.reduce((a, b) => (b.changedFraction > a.changedFraction ? b : a), intervals[0]);
            const peak = busiest && busiest.changedFraction > 0
                ? `, busiest interval moved ${Math.round(busiest.changedFraction * 100)}% of the frame (${busiest.fromSec.toFixed(1)}s-${busiest.toSec.toFixed(1)}s)`
                : ', no motion detected';
            console.log(`Wrote ${diffFile} (${intervals.length} intervals${peak}).`);
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * Pairwise diff of the strip's own samples, in the browser (canvas -- no image decoder on the
 * Node side). Bounding boxes come back in frame fractions, so they survive any tile size and stay
 * comparable between clips. Plain loops only in the page callback: no inner functions (the __name
 * rule; see driver.ts).
 */
async function diffFrames(browser: Browser, frames: SheetFrame[], fps: number): Promise<MotionInterval[]> {
    const context = await browser.newContext({ viewport: { width: 400, height: 300 } });
    try {
        const page = await context.newPage();
        const imgs = frames.map(f => `<img src="data:image/png;base64,${f.png.toString('base64')}">`).join('');
        await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0">${imgs}</body>`, { waitUntil: 'load' });
        const raw: { changed: number; minX: number; minY: number; maxX: number; maxY: number; total: number }[] = await page.evaluate((o: { w: number; h: number; delta: number }) => {
            const imgs = document.querySelectorAll('img');
            const a = document.createElement('canvas'); a.width = o.w; a.height = o.h;
            const b = document.createElement('canvas'); b.width = o.w; b.height = o.h;
            const ca = a.getContext('2d')!; const cb = b.getContext('2d')!;
            const out = [];
            for (let i = 1; i < imgs.length; i++) {
                ca.drawImage(imgs[i - 1], 0, 0, o.w, o.h);
                cb.drawImage(imgs[i], 0, 0, o.w, o.h);
                const da = ca.getImageData(0, 0, o.w, o.h).data;
                const db = cb.getImageData(0, 0, o.w, o.h).data;
                let changed = 0, minX = o.w, minY = o.h, maxX = -1, maxY = -1;
                for (let y = 0; y < o.h; y++) {
                    for (let x = 0; x < o.w; x++) {
                        const p = (y * o.w + x) * 4;
                        const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]));
                        if (d > o.delta) { changed++; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
                    }
                }
                out.push({ changed: changed, minX: minX, minY: minY, maxX: maxX, maxY: maxY, total: o.w * o.h });
            }
            return out;
        }, { w: DIFF_W, h: DIFF_H, delta: DIFF_DELTA });
        return raw.map((r, i) => ({
            fromSec: Math.round(i / fps * 10) / 10,
            toSec: Math.round((i + 1) / fps * 10) / 10,
            changedFraction: Math.round(r.changed / r.total * 1000) / 1000,
            bbox: r.maxX >= 0
                ? { x: r.minX / DIFF_W, y: r.minY / DIFF_H, w: (r.maxX - r.minX + 1) / DIFF_W, h: (r.maxY - r.minY + 1) / DIFF_H }
                : null,
        }));
    } finally {
        await context.close();
    }
}
