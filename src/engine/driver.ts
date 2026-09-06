import type { Page } from 'playwright';
import { Step, Timeline, leadMsFor, DEFAULT_LEAD_MS } from './schema';
import { runtimeSource, bootOptions, InjectOptions } from './inject';

/**
 * Node-side scheduler: drives `window.__anim.runStep` in a Playwright page.
 *
 * - timed mode: each step starts at `timeMs - leadMs` on the wall clock (video export).
 * - step mode: steps run back-to-back with a fixed lead, awaiting each one (check/preview/guide).
 *
 * `actualMs` is measured in the page (relative to `__anim.start()`), at the moment the
 * interaction happened. VTT/chapters/guide data derive from it.
 */

export interface StepResult {
    index: number;
    id: string;
    action: string;
    target?: string;
    scheduledMs: number;
    actualMs: number;
    rect?: { x: number; y: number; width: number; height: number } | null;
    point?: { x: number; y: number } | null;
    error?: string;
}

export interface RunOptions {
    mode: 'timed' | 'step';
    /** Pause after each step resolves before `afterStep` (step mode only). Default 300. */
    settleMs?: number;
    /** Cursor lead in step mode. Default 950. */
    leadMs?: number;
    /** Skip all waits inside the page (typing, camera, fades). Step mode only. */
    instant?: boolean;
    /** Reject a step that has not resolved after this long. Default 30000. */
    stepTimeoutMs?: number;
    beforeStep?: (step: Step) => void | Promise<void>;
    afterStep?: (step: Step, result: StepResult) => void | Promise<void>;
}

/** Make sure the runtime is present and booted (without a timeline, so it never self-plays). */
export async function ensureRuntime(page: Page, timeline: Timeline, opts: InjectOptions = {}): Promise<void> {
    const present = await page.evaluate(() => !!(window as any).__anim);
    if (!present) await page.addScriptTag({ content: runtimeSource() });
    const boot = bootOptions(timeline, opts, false);
    await page.evaluate((o) => { (window as any).__anim.boot(o); }, boot as any);
    await page.waitForFunction(() => (window as any).__anim && (window as any).__anim.isReady());
}

function errorMessage(e: any): string {
    const msg = String(e && e.message ? e.message : e);
    return msg.split('\n')[0].replace(/^page\.evaluate:\s*/, '').replace(/^Error:\s*/, '');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

export async function runTimeline(page: Page, timeline: Timeline, opts: RunOptions): Promise<StepResult[]> {
    const steps = timeline.steps;
    const settleMs = opts.settleMs ?? 300;
    const stepTimeoutMs = opts.stepTimeoutMs ?? 30000;
    const results: StepResult[] = new Array(steps.length);

    await page.evaluate(() => (window as any).__anim.start());
    const t0 = Date.now();

    const fire = async (i: number, leadMs: number) => {
        const step = steps[i];
        if (opts.beforeStep) await opts.beforeStep(step);
        let result: StepResult;
        try {
            result = await withTimeout(
                page.evaluate(
                    ([s, o]) => (window as any).__anim.runStep(s, o),
                    [step, { leadMs, instant: !!opts.instant }] as [Step, { leadMs: number; instant: boolean }],
                ),
                stepTimeoutMs,
                `step ${step.index} (${step.action}${step.target ? ' ' + step.target : ''})`,
            );
        } catch (e: any) {
            result = {
                index: step.index, id: step.id, action: step.action, target: step.target,
                scheduledMs: step.timeMs, actualMs: NaN, error: errorMessage(e),
            };
        }
        if (opts.mode === 'step' && settleMs > 0 && !opts.instant) await page.waitForTimeout(settleMs);
        if (opts.afterStep) await opts.afterStep(step, result);
        results[i] = result;
    };

    if (opts.mode === 'step') {
        for (let i = 0; i < steps.length; i++) {
            await fire(i, opts.leadMs ?? DEFAULT_LEAD_MS);
        }
        return results;
    }

    const pending: Promise<void>[] = [];
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!Number.isFinite(step.timeMs)) {
            results[i] = { index: step.index, id: step.id, action: step.action, target: step.target, scheduledMs: NaN, actualMs: NaN, error: `invalid time ${JSON.stringify(step.time)}` };
            continue;
        }
        const leadMs = leadMsFor(step, steps[i - 1]);
        const startAt = t0 + step.timeMs - leadMs;
        const delay = startAt - Date.now();
        if (delay > 0) await page.waitForTimeout(delay);
        pending.push(fire(i, leadMs));
    }
    await Promise.all(pending);
    return results;
}
