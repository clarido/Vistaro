import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, validateTimeline, formatIssue, hasErrors, formatTime, Step, captureAtFor } from '../engine/schema';
import { runTimeline, ensureRuntime } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions } from '../browser';
import { renderContactSheet, SheetFrame } from '../media/contactSheet';

export interface PreviewOptions extends ViewportOptions {
    step?: string | number;
    /** 'auto' (default, per action like the guide), 'interaction' (+300ms), or 'end' (after the step completed). */
    at?: string;
    output?: string;
    cursor?: string;
    locale?: string;
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
    let timeline;
    try {
        timeline = loadTimeline(dir, { locale: options.locale });
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

    const launched = await launchPage(options);
    const { page, browser } = launched;
    const frames: SheetFrame[] = [];
    try {
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        await ensureRuntime(page, timeline, { cursor: options.cursor, drift: false });
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

        if (only !== undefined) {
            const out = options.output ? path.resolve(options.output) : path.join(dir, `preview-step-${only}.png`);
            fs.writeFileSync(out, frames[0].png);
            console.log(`Wrote ${out} (${launched.width}x${launched.height} @2x).`);
        } else {
            const title = timeline.meta.title ? `${timeline.meta.title} — ${timeline.steps.length} steps` : `${path.basename(path.resolve(dir))} — ${timeline.steps.length} steps`;
            const sheet = await renderContactSheet(browser, frames, { title });
            const out = options.output ? path.resolve(options.output) : path.join(dir, 'preview.png');
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
