import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, validateTimeline, formatIssue, hasErrors, formatTime, Step, captureAtFor, deviceKind, emulateMobileFor, isReel, reelOptions, cliConfigPath, configStem } from '../engine/schema';
import { runTimeline, ensureRuntime } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions, resolveViewport } from '../browser';
import { renderContactSheet, SheetFrame } from '../media/contactSheet';

export interface PreviewOptions extends ViewportOptions {
    step?: string | number;
    /** 'auto' (default, per action like the guide), 'interaction' (+300ms), or 'end' (after the step completed). */
    at?: string;
    output?: string;
    cursor?: string;
    locale?: string;
    /** --config: a timeline other than <dir>/anim.config.json (cwd-relative on the CLI). */
    config?: string;
    force?: boolean;
}

export function frameLabel(step: Step): string {
    const parts = [`#${step.index}`, formatTime(step.timeMs), [step.action, step.target].filter(Boolean).join(' ')];
    if (step.title) parts.push(step.title);
    return parts.join(' · ');
}

/**
 * `preview <dir>`: run the timeline step by step (no drift), screenshot each step
 * 300ms after its interaction (inside the highlight pulse; `--at end` captures after the
 * step completed instead), and write a labelled contact sheet to <dir>/preview.png.
 * `--step N` writes that single frame at full resolution to <dir>/preview-step-N.png.
 */
export async function previewCommand(dir: string, options: PreviewOptions = {}): Promise<void> {
    const htmlPath = path.resolve(dir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        console.error(`Error: ${htmlPath} not found.`);
        process.exit(1);
    }
    // Non-default timelines get their own contact sheet: sharing preview.png between two scenarios
    // means reading one sheet while fixing the other's timeline.
    const stem = configStem(dir, cliConfigPath(options.config));
    let timeline;
    try {
        timeline = loadTimeline(dir, { locale: options.locale, device: deviceKind(options.device), config: cliConfigPath(options.config) });
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }
    const issues = validateTimeline(timeline);
    for (const issue of issues) console.error(formatIssue(issue));
    if (hasErrors(issues) && !options.force) {
        console.error(`\nPreview aborted: fix the errors above or pass --force.`);
        process.exit(1);
    }

    const at = options.at ?? 'auto';
    if (at !== 'interaction' && at !== 'end' && at !== 'auto') {
        console.error(`Error: --at must be "auto", "interaction" or "end".`);
        process.exit(1);
    }
    const only = options.step !== undefined ? parseInt(String(options.step), 10) : undefined;
    if (only !== undefined && (!Number.isFinite(only) || only < 1 || only > timeline.steps.length)) {
        console.error(`Error: --step must be between 1 and ${timeline.steps.length}.`);
        process.exit(1);
    }

    // A reel must preview under exactly the conditions it exports under, or the read-the-PNG loop
    // an author iterates against disagrees with the artifact they ship.
    const launched = await launchPage({ ...options, emulateMobile: emulateMobileFor(timeline) });
    const { page, browser } = launched;
    const frames: SheetFrame[] = [];
    let posterTile = false;
    try {
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        await ensureRuntime(page, timeline, { cursor: options.cursor, drift: false, zoom: resolveViewport(options).scale });
        const steps = only !== undefined ? { ...timeline, steps: timeline.steps.slice(0, only) } : timeline;
        await runTimeline(page, steps, {
            mode: 'step',
            settleMs: 300,
            afterStepAt: at === 'end' ? 'completion' : at === 'auto' ? 'auto' : 'interaction',
            afterStep: async (step, result) => {
                if (only !== undefined && step.index !== only) return;
                const png = await page.screenshot({ type: 'png' });
                frames.push({ label: frameLabel(step), png, error: result.error });
                const status = result.error ? `FAILED: ${result.error}`
                    : (at === 'end' || (at === 'auto' && captureAtFor(step) === 'completion')) ? `interaction at ${result.actualMs}ms, completed at ${result.completedMs}ms` : `interaction at ${result.actualMs}ms`;
                console.log(`  ${frameLabel(step)}  (${status})`);
            },
        });

        // The poster is the frame a visitor sees before playback, whenever the clip has not scrolled
        // into view, and permanently under prefers-reduced-motion. It is the highest-stakes frame a
        // reel ships and it was the only one an author never saw while iterating.
        if (only === undefined && isReel(timeline)) {
            const spec = reelOptions(timeline).poster;
            // 'last' is the default and lands exactly here, with every step complete and settled.
            // Any other setting names a different moment, so the tile says which one it approximates.
            await page.evaluate((o) => (window as any).__anim.whenSettled(o), { timeoutMs: 10000 });
            const label = spec === 'last' ? 'poster (last step, as exported)'
                : `poster — approximated: meta.reel.poster is ${JSON.stringify(spec)}, shown at the end of the timeline`;
            frames.push({ label, png: await page.screenshot({ type: 'png' }) });
            posterTile = true;
            console.log(`  ${label}`);
        }

        if (only !== undefined) {
            const out = options.output ? path.resolve(options.output) : path.join(dir, stem ? `preview-${stem}-step-${only}.png` : `preview-step-${only}.png`);
            fs.writeFileSync(out, frames[0].png);
            console.log(`Wrote ${out} (${launched.width}x${launched.height} @2x).`);
        } else {
            // The poster is a tile but not a step, so the count alone reads as an off-by-one
            // against the sheet the reader is looking at.
            const count = `${timeline.steps.length} steps${posterTile ? ' + poster' : ''}`;
            const title = `${timeline.meta.title || path.basename(path.resolve(dir))} — ${count}`;
            const sheet = await renderContactSheet(browser, frames, { title });
            const out = options.output ? path.resolve(options.output) : path.join(dir, stem ? `preview.${stem}.png` : 'preview.png');
            fs.writeFileSync(out, sheet);
            console.log(`Wrote ${out} (${frames.length} frames). Open it to review every step; use --step N for a full-size frame.`);
        }
        const failed = frames.filter(f => f.error).length;
        if (failed) {
            console.error(`${failed} step(s) failed in the browser; see labels above.`);
            process.exitCode = 1;
        }
    } finally {
        await launched.close();
    }
}
