import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/**
 * Staleness diff between two guide captures: for every step-NN.png in either directory, the
 * fraction of pixels that changed (pixelmatch). Frames of different sizes count as fully changed,
 * and so does a frame present on only one side (a step added or removed since the previous run).
 * A previous directory with no frames at all is not a baseline: nothing is compared.
 */

export interface StepDiff { step: string; fraction: number; diffFile?: string }
export interface GuideDiff { maxFraction: number; steps: Record<string, number>; compared: number; diffDir?: string }

const STEP_PNG = /^step-(\d+)\.png$/;

/** Copy the previous run's step frames aside so they can be compared after the new capture. */
export function keepPreviousFrames(assetsDir: string, previousDir: string): string[] {
    if (!fs.existsSync(assetsDir)) return [];
    fs.mkdirSync(previousDir, { recursive: true });
    for (const f of fs.readdirSync(previousDir)) if (STEP_PNG.test(f) || /\.diff\.png$/.test(f)) fs.unlinkSync(path.join(previousDir, f));
    const kept: string[] = [];
    for (const f of fs.readdirSync(assetsDir)) {
        if (!STEP_PNG.test(f)) continue;
        fs.copyFileSync(path.join(assetsDir, f), path.join(previousDir, f));
        kept.push(f);
    }
    return kept;
}

export function diffPng(aFile: string, bFile: string, diffFile?: string): number {
    const a = PNG.sync.read(fs.readFileSync(aFile));
    const b = PNG.sync.read(fs.readFileSync(bFile));
    if (a.width !== b.width || a.height !== b.height) return 1;
    const out = diffFile ? new PNG({ width: a.width, height: a.height }) : undefined;
    const changed = pixelmatch(a.data, b.data, out ? out.data : undefined as any, a.width, a.height, { threshold: 0.1 });
    if (out && diffFile) fs.writeFileSync(diffFile, PNG.sync.write(out));
    return changed / (a.width * a.height);
}

function stepFrames(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => STEP_PNG.test(f)).sort();
}

/**
 * Compare the frames in `previousDir` with the fresh ones in `assetsDir` (union of both sets);
 * writes step-NN.diff.png next to the previous frames. `compared` counts every frame that took
 * part, missing ones included; it is 0 only when there was no previous frame to compare against.
 */
export function diffGuideFrames(assetsDir: string, previousDir: string): GuideDiff {
    const steps: Record<string, number> = {};
    let maxFraction = 0;
    let compared = 0;
    const previous = stepFrames(previousDir);
    if (!previous.length) return { maxFraction: 0, steps, compared: 0 };
    const names = [...new Set([...previous, ...stepFrames(assetsDir)])].sort();
    for (const f of names) {
        const key = `step-${STEP_PNG.exec(f)![1]}`;
        const old = path.join(previousDir, f);
        const fresh = path.join(assetsDir, f);
        compared++;
        if (!fs.existsSync(fresh) || !fs.existsSync(old)) { steps[key] = 1; maxFraction = 1; continue; }
        const fraction = diffPng(old, fresh, path.join(previousDir, `${key}.diff.png`));
        steps[key] = Math.round(fraction * 10000) / 10000;
        maxFraction = Math.max(maxFraction, fraction);
    }
    return { maxFraction: Math.round(maxFraction * 10000) / 10000, steps, compared, diffDir: previousDir };
}
