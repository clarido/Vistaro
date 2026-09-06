import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { Step, Timeline, CURSOR_ACTIONS } from '../engine/schema';
import { runTimeline, StepResult } from '../engine/driver';

/**
 * Guide capture (Scribe/Tango style): replay the timeline in driver step mode on a page that
 * records no video, and at each step's capture point (interaction + settleMs) hold the spotlight,
 * show the numbered DOM callout, take the full frame and an optional crop. All marks are DOM
 * elements owned by runtime.js (`__anim.markStep` / `__anim.unmark`); no image processing.
 */

export interface Box { x: number; y: number; width: number; height: number }

export interface CapturedStep {
    index: number;
    id: string;
    /** 1-based position among the captured (guide) steps; also the callout number. */
    number: number;
    action: string;
    target?: string;
    scheduledMs: number;
    actualMs: number;
    completedMs?: number;
    title?: string;
    subtitle?: string;
    narration?: string;
    note?: string;
    /** Full-frame PNG (absolute path). */
    image: string;
    /** Cropped PNG around the rect (absolute path), when cropping is on and the step has a rect. */
    crop?: string;
    /** Box the spotlight framed, CSS px (the sized ancestor when the target is 0x0). */
    rect?: Box | null;
    targetRect?: Box;
    callout?: { number: number; x: number; y: number } | null;
    error?: string;
}

export interface CaptureOptions {
    /** Directory for step-NN.png / step-NN.crop.png / poster.png. */
    assetsDir: string;
    /** Padding in CSS px around the rect for the crop; false disables crops. */
    crop: number | false;
    viewport: { width: number; height: number };
    settleMs?: number;
    /** Hide the fake cursor in guide frames (default false: the cursor shows where to click). */
    hideCursor?: boolean;
    log?: (m: string) => void;
}

export interface GuideCapture {
    steps: CapturedStep[];
    /** Plain frame (no marks) at the first captured step's capture point. */
    poster?: string;
    results: StepResult[];
}

/** Steps that get a guide entry: not `guide: false`, and not a target-less wait/camera/scroll. */
export function isGuideStep(step: Step): boolean {
    if (step.guide === false) return false;
    if (!step.target && (step.action === 'wait' || step.action === 'camera' || step.action === 'scroll')) return false;
    return true;
}

export function guideSteps(timeline: Timeline): Step[] {
    return timeline.steps.filter(isGuideStep);
}

export function stepFileBase(index: number): string {
    return `step-${String(index).padStart(2, '0')}`;
}

/** Clip rectangle for the crop: rect + padding, clamped to the viewport (CSS px). */
export function cropBox(rect: Box, pad: number, viewport: { width: number; height: number }): Box {
    const x = Math.max(0, Math.floor(rect.x - pad));
    const y = Math.max(0, Math.floor(rect.y - pad));
    const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad));
    const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad));
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * Run the timeline in step mode on `page` (already navigated + runtime booted, drift off) and
 * capture one frame per guide step. Returns absolute asset paths.
 */
export async function captureGuide(page: Page, timeline: Timeline, opts: CaptureOptions): Promise<GuideCapture> {
    fs.mkdirSync(opts.assetsDir, { recursive: true });
    const captured: CapturedStep[] = [];
    let poster: string | undefined;
    let number = 0;

    const results = await runTimeline(page, timeline, {
        mode: 'step',
        settleMs: opts.settleMs ?? 300,
        afterStepAt: 'interaction',
        afterStep: async (step, result) => {
            if (!isGuideStep(step)) return;
            number++;
            const base = path.join(opts.assetsDir, stepFileBase(step.index));
            const entry: CapturedStep = {
                index: step.index, id: step.id, number, action: step.action, target: step.target,
                scheduledMs: step.timeMs, actualMs: result.actualMs, completedMs: result.completedMs,
                title: step.title, subtitle: step.subtitle ?? undefined, narration: step.narration, note: step.note,
                image: base + '.png', rect: result.rect ?? null, targetRect: result.targetRect, callout: null, error: result.error,
            };
            if (!poster) {
                poster = path.join(opts.assetsDir, 'poster.png');
                await page.evaluate(() => (window as any).__anim.unmark());
                await page.screenshot({ path: poster, type: 'png' });
            }
            // Marks only for cursor actions with a target (fades/scrolls just show the state).
            const marks = CURSOR_ACTIONS.has(step.action) && step.target && !result.error
                ? await page.evaluate((o) => (window as any).__anim.markStep(o), { target: step.target, number, hideCursor: !!opts.hideCursor })
                : null;
            if (marks) {
                entry.callout = marks.callout;
                if (!entry.rect) entry.rect = marks.rect;
                // Let the held spotlight and badge paint before the shot.
                await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
            }
            await page.screenshot({ path: entry.image, type: 'png' });
            const rect = entry.rect;
            const pad = step.crop === false ? false : (typeof step.crop === 'number' ? step.crop : opts.crop);
            if (pad !== false && rect && rect.width > 0 && rect.height > 0) {
                entry.crop = base + '.crop.png';
                await page.screenshot({ path: entry.crop, type: 'png', clip: cropBox(rect, pad, opts.viewport) });
            }
            if (marks) await page.evaluate(() => (window as any).__anim.unmark());
            opts.log?.(`  ${number}. step ${step.index} ${step.action}${step.target ? ' ' + step.target : ''}${step.title ? ' · ' + step.title : ''}${result.error ? '  FAILED: ' + result.error : ''}`);
            captured.push(entry);
        },
    });
    return { steps: captured, poster, results };
}
