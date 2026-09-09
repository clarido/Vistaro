import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { Step, Timeline, captureAtFor, isGuideStep } from '../engine/schema';
import { runTimeline, StepResult, errorMessage, LiveOptions, isNavigationError } from '../engine/driver';

/**
 * Guide capture (Scribe/Tango style): replay the timeline in driver step mode on a page that
 * records no video, and at each step's capture point (cursor actions: interaction + settleMs;
 * state actions such as type/camera/fadeIn: completion, see schema.captureAtFor) hide the
 * subtitle bar, hold the spotlight + numbered DOM badge on cursor targets, take the full frame
 * and an optional crop. All marks are DOM elements owned by runtime.js
 * (`__anim.beginCapture` / `markStep` / `endCapture`); no image processing.
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
    /** Moment the frame was taken: 'interaction', 'completion', or 'arrival' (navigating clicks: before the click). */
    capturedAt: 'interaction' | 'completion' | 'arrival';
    title?: string;
    subtitle?: string;
    narration?: string;
    note?: string;
    /** Full-frame PNG (absolute path). Missing only when the screenshot itself failed. */
    image?: string;
    /** Cropped PNG around the rect (absolute path), when cropping is on, the step has a rect, and the crop is smaller than the frame. */
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
    /**
     * Burn the spotlight ring and numbered badge into each frame (default true). `false` still
     * records `rect`/`callout`: the marks are placed, measured, then removed before the shot, so a
     * consumer that draws its own hotspot (an interactive tour) gets clean frames plus the geometry.
     */
    marks?: boolean;
    /** Write assets/poster.png (only useful when a video will be linked). Default true. */
    poster?: boolean;
    /** Live page handling (record): navigations survived, waitFor honoured. */
    live?: LiveOptions;
    /** Steps whose click navigates (from the video pass): captured at the arrival, before the click. */
    navigated?: Set<number>;
    log?: (m: string) => void;
}

export interface GuideCapture {
    steps: CapturedStep[];
    /** Plain frame (no marks) at the first captured step's capture point. */
    poster?: string;
    results: StepResult[];
}

/** Move `<base>.arrival.png` to `<base>.png` (the arrival frame won): returns the new path. */
function renameAside(file?: string): string | undefined {
    if (!file) return undefined;
    const final = file.replace(/\.arrival(\.crop)?\.png$/, '$1.png');
    if (final === file) return file;
    try { fs.renameSync(file, final); } catch { return fs.existsSync(file) ? file : undefined; }
    return final;
}

function removeIfPresent(file?: string): void {
    if (!file) return;
    try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/** Steps that get a guide entry: not `guide: false`, and not a target-less wait/camera/scroll. */
/** Steps whose frame is taken once their CSS transition has settled (see whenSettled in the runtime). */
const SETTLE_ACTIONS: ReadonlySet<string> = new Set(['fadeIn', 'transitionScreen', 'camera', 'scroll']);
/** Hang guard for whenSettled: a page transition longer than this is not waited for. */
const SETTLE_GUARD_MS = 10000;

export { isGuideStep };

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


const STALE_ASSET = /^(step-\d+(\.arrival)?(\.crop)?\.(png|mp4|gif|mp3|m4a|aac|aiff)|poster\.png)$/i;

/** Remove generated step assets from a previous capture (pattern-scoped: never touches other files). */
export function cleanStaleAssets(assetsDir: string): string[] {
    if (!fs.existsSync(assetsDir)) return [];
    const removed: string[] = [];
    for (const name of fs.readdirSync(assetsDir)) {
        if (!STALE_ASSET.test(name)) continue;
        const full = path.join(assetsDir, name);
        if (!fs.statSync(full).isFile()) continue;
        fs.unlinkSync(full);
        removed.push(name);
    }
    return removed;
}

/**
 * Run the timeline in step mode on `page` (already navigated + runtime booted, drift off) and
 * capture one frame per guide step. Returns absolute asset paths. Steps that fail in the browser
 * still get an entry (with `error`, the plain frame when possible, no marks).
 */
export async function captureGuide(page: Page, timeline: Timeline, opts: CaptureOptions): Promise<GuideCapture> {
    fs.mkdirSync(opts.assetsDir, { recursive: true });
    cleanStaleAssets(opts.assetsDir);
    const captured: CapturedStep[] = [];
    let poster: string | undefined;
    let number = 0;

    /**
     * Render one frame for `entry`: marks held on the step's target, everything settled, full frame
     * and (when it adds anything) the crop. `suffix` writes an arrival frame aside, to be kept or
     * dropped once we know whether the click hid its own target.
     */
    const renderFrame = async (step: Step, entry: CapturedStep, result: StepResult, suffix: '' | '.arrival'): Promise<void> => {
        const base = path.join(opts.assetsDir, stepFileBase(step.index)) + suffix;
        try {
            // Transition-driven steps complete on the runtime's timer a few frames before the CSS
            // transition visibly settles; wait for the animations themselves (whole document, the
            // timeout is only a hang guard) so unedited re-runs reproduce the same pixels.
            if (SETTLE_ACTIONS.has(step.action) && !result.error && entry.capturedAt === 'completion') {
                await page.evaluate((o) => (window as any).__anim.whenSettled(o), { timeoutMs: SETTLE_GUARD_MS });
            }
            // Subtitle bar (and optionally the cursor) hidden for EVERY guide frame, the poster included:
            // a subtitle burned into the cover image would also leak the previous locale's text.
            await page.evaluate((o) => (window as any).__anim.beginCapture(o), { hideCursor: !!opts.hideCursor });
            if (!poster && opts.poster !== false) {
                poster = path.join(opts.assetsDir, 'poster.png');
                await page.evaluate(() => (window as any).__anim.nextFrames(2));
                await page.screenshot({ path: poster, type: 'png' });
            }
            // Badge + spotlight for every guide step with a resolvable target ("notice this" is a real
            // instruction for the reader): cursor actions on the box runStep used, other actions on the
            // target's sized box. rect/callout are null only for target-less steps or failed ones.
            const marks = step.target && !result.error
                ? await page.evaluate((o) => (window as any).__anim.markStep(o), { target: step.target, number: entry.number })
                : null;
            if (marks) {
                // One rule for frame, rect and crop: the box the marks framed (runStep's sized ancestor).
                entry.rect = marks.rect;
                entry.targetRect = marks.targetRect ?? entry.targetRect;
                entry.callout = marks.callout;
            }
            // marks:false wants the geometry without the furniture. endCapture() would also restore
            // the subtitle bar and cursor this capture session deliberately hid, so undo just the two.
            if (marks && opts.marks === false) {
                await page.evaluate(() => { (window as any).__anim.releaseHighlight(); (window as any).__anim.hideCallout(); });
            }
            // The marks snap into place; anything still animating on the page is awaited once more.
            await page.evaluate((o) => (window as any).__anim.whenSettled(o), { timeoutMs: SETTLE_GUARD_MS });
            await page.evaluate(() => (window as any).__anim.nextFrames(2));
            entry.image = base + '.png';
            await page.screenshot({ path: entry.image, type: 'png' });
            const rect = entry.rect;
            const pad = step.crop === false ? false : (typeof step.crop === 'number' ? step.crop : opts.crop);
            entry.crop = undefined;
            if (pad !== false && rect && rect.width > 0 && rect.height > 0) {
                const clip = cropBox(rect, pad, opts.viewport);
                // A crop that is the whole frame (e.g. fadeIn body) adds nothing.
                if (clip.width < opts.viewport.width || clip.height < opts.viewport.height) {
                    entry.crop = base + '.crop.png';
                    await page.screenshot({ path: entry.crop, type: 'png', clip });
                }
            }
        } catch (e: any) {
            let recovered = false;
            if (isNavigationError(e) && opts.live) {
                // The page navigated under the capture (a click we did not know navigates): retry once
                // on the new document, plain frame, no marks.
                try {
                    await page.waitForLoadState('load', { timeout: opts.live.navigationTimeoutMs ?? 15000 });
                    entry.image = base + '.png';
                    await page.screenshot({ path: entry.image, type: 'png' });
                    entry.callout = null;
                    entry.crop = undefined;
                    recovered = true;
                    opts.log?.(`  (step ${step.index} navigated during capture; frame retaken on the new page without marks)`);
                } catch { /* fall through to the error */ }
            }
            if (!recovered) {
                entry.error = entry.error ? `${entry.error}; ${errorMessage(e)}` : `capture: ${errorMessage(e)}`;
                if (entry.image && !fs.existsSync(entry.image)) entry.image = undefined;
            }
        } finally {
            await page.evaluate(() => (window as any).__anim.endCapture()).catch(() => {});
        }
    };

    const newEntry = (step: Step, result: StepResult): CapturedStep => ({
        index: step.index, id: step.id, number: ++number, action: step.action, target: step.target,
        scheduledMs: step.timeMs, actualMs: result.actualMs, completedMs: result.completedMs,
        capturedAt: result.capturedAt === 'arrival' ? 'arrival' : captureAtFor(step),
        title: step.title, subtitle: step.subtitle ?? undefined, narration: step.narration, note: step.note,
        rect: result.rect ?? null, targetRect: result.targetRect, callout: null, error: result.error,
    });

    const finish = (step: Step, entry: CapturedStep) => {
        opts.log?.(`  ${entry.number}. step ${step.index} ${step.action}${step.target ? ' ' + step.target : ''}${step.title ? ' · ' + step.title : ''}${entry.error ? '  FAILED: ' + entry.error : ''}`);
        captured.push(entry);
    };

    /** Is the step's target still on screen? A page that navigated (or answers nothing) counts as gone. */
    const targetStillVisible = async (step: Step): Promise<boolean> => {
        if (!step.target) return true;
        try {
            return await page.evaluate((sel) => {
                const el = sel === 'body' ? document.body : document.querySelector(sel);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (!r.width || !r.height) return false;
                const cs = getComputedStyle(el as Element);
                return cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01;
            }, step.target);
        } catch {
            return false;
        }
    };

    // Every click is captured twice: once at the arrival (cursor pressed, spotlight on, nothing
    // clicked yet) and once after the interaction settled. Whether the click's own handler hides the
    // target (a screen swap, a navigation) can only be known afterwards, so we keep whichever frame
    // still shows the element the reader is being told to click, and drop the other.
    const pending = new Map<number, CapturedStep>();

    const results = await runTimeline(page, timeline, {
        mode: 'step',
        settleMs: opts.settleMs ?? 300,
        afterStepAt: 'auto',
        live: opts.live,
        captureBeforeAct: (step) => step.action === 'click'
            || (!!opts.live && ((opts.navigated?.has(step.index) ?? false) || step.action === 'navigate')),
        afterStep: async (step, result) => {
            if (!isGuideStep(step)) return;
            const entry = newEntry(step, result);
            const twoPhase = step.action === 'click' || result.capturedAt === 'arrival';
            if (!twoPhase) {
                await renderFrame(step, entry, result, '');
                finish(step, entry);
                return;
            }
            // Arrival frame, held aside until afterAct decides.
            entry.capturedAt = 'arrival';
            await renderFrame(step, entry, result, '.arrival');
            pending.set(step.index, entry);
        },
        afterAct: async (step, result) => {
            const entry = pending.get(step.index);
            if (!entry) return;
            pending.delete(step.index);
            entry.actualMs = result.actualMs;
            entry.completedMs = result.completedMs;
            if (result.error && !entry.error) entry.error = result.error;
            const arrival = { image: entry.image, crop: entry.crop };
            const keepArrival = !(await targetStillVisible(step));
            if (keepArrival) {
                // The click hid its own target (screen swap or navigation): the settled frame would
                // show the new screen with the spotlight over an element that is no longer there.
                entry.image = renameAside(arrival.image);
                entry.crop = renameAside(arrival.crop);
                entry.capturedAt = 'arrival';
                opts.log?.(`  (step ${step.index} hid its own target; kept the frame taken before the click)`);
            } else {
                entry.capturedAt = captureAtFor(step);
                await renderFrame(step, entry, result, '');
                removeIfPresent(arrival.image);
                removeIfPresent(arrival.crop);
            }
            finish(step, entry);
        },
    });
    // A two-phase step whose act never reported still has its arrival frame: keep it rather than lose the entry.
    for (const [index, entry] of pending) {
        entry.image = renameAside(entry.image);
        entry.crop = renameAside(entry.crop);
        finish(timeline.steps.find(s => s.index === index)!, entry);
    }
    return { steps: captured, poster, results };
}
