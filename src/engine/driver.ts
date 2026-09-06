import type { Page } from 'playwright';
import { Step, Timeline, leadMsFor, DEFAULT_LEAD_MS, captureAtFor } from './schema';
import { runtimeSource, bootOptions, InjectOptions } from './inject';

/**
 * RULES FOR page.evaluate CALLBACKS (here, in check/preview/capture/record):
 *   - No inner function declarations or arrow functions assigned to consts inside the callback.
 *     tsx/esbuild wraps them in a `__name(fn, "name")` helper that exists in the Node bundle but
 *     not inside the page; Playwright serializes the callback source, so the page throws
 *     "ReferenceError: __name is not defined" (silently, if the caller swallows hook errors).
 *   - Anything non-trivial lives in src/engine/runtime.js (plain JS, injected as text) and is
 *     called through window.__anim (e.g. __anim.anchorOf, __anim.selectorOf, __anim.markStep).
 *
 * Node-side scheduler: drives `window.__anim.runStep` in a Playwright page.
 *
 * - timed mode: each step starts at `timeMs - leadMs` on the wall clock (video export).
 * - step mode: steps run back-to-back with a fixed lead, awaiting each one (check/preview/guide).
 *
 * `runStep` resolves at the INTERACTION moment (click, first typed char, camera start);
 * the step's completion (typing done, camera/fade finished) is awaited separately via
 * `__anim.whenDone(token)`. `actualMs` / `completedMs` are measured in the page relative
 * to `__anim.start()`. VTT/chapters/guide data derive from `actualMs`.
 *
 * Hooks (`beforeStep`/`afterStep`) never reject the run: a throwing hook is recorded in
 * `result.error` so callers with `finally` cleanup (export) always get their results.
 */

export interface StepResult {
    index: number;
    id: string;
    action: string;
    target?: string;
    scheduledMs: number;
    /** Interaction moment (NaN when the step failed before interacting). */
    actualMs: number;
    /** Moment the step finished animating (typing, camera, fade). */
    completedMs?: number;
    /** Box the spotlight framed: the target, or its nearest sized ancestor when the target is 0x0. */
    rect?: { x: number; y: number; width: number; height: number } | null;
    /** The raw target box when it differs from `rect` (0x0 caret span). */
    targetRect?: { x: number; y: number; width: number; height: number };
    point?: { x: number; y: number } | null;
    error?: string;
}

export interface RunOptions {
    mode: 'timed' | 'step';
    /** Pause after the interaction before `afterStep` (step mode only). Default 300. */
    settleMs?: number;
    /** Cursor lead in step mode. Default 950. */
    leadMs?: number;
    /** Skip all waits inside the page (typing, camera, fades). Step mode only. */
    instant?: boolean;
    /** Reject a step that has not interacted / completed after this long. Default 30000. */
    stepTimeoutMs?: number;
    /**
     * When `afterStep` fires: at the interaction (+ settleMs), after the step completed, or 'auto'
     * (per action via schema.captureAtFor: cursor actions at interaction, state actions at completion).
     * Default 'interaction'.
     */
    afterStepAt?: 'interaction' | 'completion' | 'auto';
    beforeStep?: (step: Step) => void | Promise<void>;
    afterStep?: (step: Step, result: StepResult) => void | Promise<void>;
}

/** Make sure the runtime is present and booted (without a timeline, so it never self-plays). */
export async function ensureRuntime(page: Page, timeline: Timeline, opts: InjectOptions = {}): Promise<void> {
    const present = await page.evaluate(() => !!(window as any).__anim);
    if (!present) await page.addScriptTag({ content: runtimeSource() });
    const boot: Record<string, any> = bootOptions(timeline, opts, false);
    if (present) {
        // A built page already booted with its own cursor/drift/reset settings (e.g. `build --cursor
        // windows`); only override what the caller passed explicitly.
        if (opts.cursor === undefined) delete boot.cursor;
        if (opts.drift === undefined) delete boot.drift;
        if (opts.resetFocusStyles === undefined) delete boot.resetFocusStyles;
    }
    await page.evaluate((o) => { (window as any).__anim.boot(o); }, boot);
    await page.waitForFunction(() => (window as any).__anim && (window as any).__anim.isReady());
}

export function errorMessage(e: any): string {
    const msg = String(e && e.message ? e.message : e);
    return msg.split('\n')[0].replace(/^page\.evaluate:\s*/, '').replace(/^Error:\s*/, '');
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

function appendError(result: StepResult, msg: string): void {
    result.error = result.error ? `${result.error}; ${msg}` : msg;
}

export async function runTimeline(page: Page, timeline: Timeline, opts: RunOptions): Promise<StepResult[]> {
    const steps = timeline.steps;
    const settleMs = opts.settleMs ?? 300;
    const stepTimeoutMs = opts.stepTimeoutMs ?? 30000;
    const afterStepAt = opts.afterStepAt ?? 'interaction';
    const results: StepResult[] = new Array(steps.length);

    await page.evaluate(() => (window as any).__anim.start());
    const t0 = Date.now();

    const label = (step: Step) => `step ${step.index} (${step.action}${step.target ? ' ' + step.target : ''})`;

    const fire = async (i: number, leadMs: number): Promise<void> => {
        const step = steps[i];
        const result: StepResult = {
            index: step.index, id: step.id, action: step.action, target: step.target,
            scheduledMs: step.timeMs, actualMs: NaN,
        };
        results[i] = result;

        let hookFailed = false;
        if (opts.beforeStep) {
            try { await opts.beforeStep(step); }
            catch (e: any) { appendError(result, `beforeStep hook: ${errorMessage(e)}`); hookFailed = true; }
        }
        // A step that did not run (hook threw, target vanished, page navigated) still reaches
        // afterStep with result.error set, so guides keep an entry (and numbering) and exit 1.
        const finishFailed = async () => {
            if (opts.afterStep) {
                try { await opts.afterStep(step, result); }
                catch (e: any) { appendError(result, `afterStep hook: ${errorMessage(e)}`); }
            }
        };
        if (hookFailed) { await finishFailed(); return; }

        let token: number | undefined;
        try {
            const r: StepResult & { token?: number } = await withTimeout(
                page.evaluate(
                    ([s, o]) => (window as any).__anim.runStep(s, o),
                    [step, { leadMs, instant: !!opts.instant }] as [Step, { leadMs: number; instant: boolean }],
                ),
                stepTimeoutMs,
                label(step),
            );
            token = r.token;
            delete r.token;
            Object.assign(result, r);
        } catch (e: any) {
            appendError(result, errorMessage(e));
            await finishFailed();
            return;
        }

        // Driver-side actions at the interaction moment.
        if (step.action === 'press' && typeof step.value === 'string') {
            try { await page.keyboard.press(step.value); }
            catch (e: any) { appendError(result, `keyboard.press(${JSON.stringify(step.value)}): ${errorMessage(e)}`); }
        }

        const awaitCompletion = async () => {
            if (token === undefined || Number.isFinite(result.completedMs ?? NaN)) return;
            try {
                result.completedMs = await withTimeout(
                    page.evaluate((t) => (window as any).__anim.whenDone(t), token),
                    stepTimeoutMs,
                    `${label(step)} completion`,
                );
            } catch (e: any) { appendError(result, errorMessage(e)); }
        };

        const at = afterStepAt === 'auto' ? captureAtFor(step) : afterStepAt;
        if (at === 'completion') await awaitCompletion();
        if (opts.mode === 'step' && settleMs > 0 && !opts.instant) await page.waitForTimeout(settleMs);
        if (opts.afterStep) {
            try { await opts.afterStep(step, result); }
            catch (e: any) { appendError(result, `afterStep hook: ${errorMessage(e)}`); }
        }
        await awaitCompletion();
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
        // fire() never rejects (hook and evaluate errors land in result.error), so an
        // unhandled rejection cannot escape before Promise.all.
        pending.push(fire(i, leadMs).catch((e) => { appendError(results[i], errorMessage(e)); }));
    }
    await Promise.all(pending);
    return results;
}
