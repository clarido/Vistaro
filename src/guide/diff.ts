import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/**
 * Staleness diff between two guide captures: for every step-NN.png present in both directories,
 * the fraction of pixels that changed (pixelmatch). Frames of different sizes count as fully changed.
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

/** Compare the frames in `previousDir` with the fresh ones in `assetsDir`; writes step-NN.diff.png next to the previous frames. */
export function diffGuideFrames(assetsDir: string, previousDir: string): GuideDiff {
    const steps: Record<string, number> = {};
    let maxFraction = 0;
    let compared = 0;
    if (!fs.existsSync(previousDir)) return { maxFraction: 0, steps, compared: 0 };
    for (const f of fs.readdirSync(previousDir).sort()) {
        const m = STEP_PNG.exec(f);
        if (!m) continue;
        const fresh = path.join(assetsDir, f);
        const key = `step-${m[1]}`;
        if (!fs.existsSync(fresh)) { steps[key] = 1; maxFraction = 1; continue; }
        const fraction = diffPng(path.join(previousDir, f), fresh, path.join(previousDir, `step-${m[1]}.diff.png`));
        steps[key] = Math.round(fraction * 10000) / 10000;
        maxFraction = Math.max(maxFraction, fraction);
        compared++;
    }
    return { maxFraction: Math.round(maxFraction * 10000) / 10000, steps, compared, diffDir: previousDir };
}
