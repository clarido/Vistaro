import type { Page, Frame } from 'playwright';
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
 * - live pages (`record`): the runtime is injected at document start by the browser context; the
 *   driver keeps t0 in Node, re-boots the runtime after every navigation (cursor back at its last
 *   point, clock continued; serialized, time-boxed), honours `waitFor` (selector or ms; the delay
 *   shifts later steps so their relative spacing holds), runs `navigate` via page.goto and `press`
 *   via the keyboard, and treats "execution context destroyed" during a click/press/navigate as a
 *   successful interaction that navigated.
 * - two-phase steps: with `captureBeforeAct(step)` true the driver runs the step up to the arrival
 *   (cursor pressed, spotlight on), calls `afterStep` there, then performs the interaction with
 *   `__anim.act(token)`; guides use it for clicks that navigate.
 *
 * `runStep` resolves at the INTERACTION moment (click, first typed char, camera start);
 * the step's completion (typing done, camera/fade finished) is awaited separately via
 * `__anim.whenDone(token)`. `actualMs` / `completedMs` are measured in the page relative
 * to `__anim.start()`. VTT/chapters/guide data derive from `actualMs`.
 *
 * Hooks (`beforeStep`/`afterStep`) never reject the run: a throwing hook is recorded in
 * `result.error` so callers with `finally` cleanup (export) always get their results.
 */

/** Live pages: when preparation ran late, the cursor travel is compressed down to the press only. */
const MIN_LIVE_LEAD_MS = 150;
/** Actions whose interaction may legitimately navigate the page. */
const NAVIGATING_ACTIONS: ReadonlySet<string> = new Set(['click', 'press', 'navigate']);

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
    /** Live pages: the interaction navigated (execution context destroyed) or `navigate` ran. */
    navigated?: boolean;
    /** Live pages: ms spent in `waitFor` beyond the planned moment (shifted later steps). */
    waitedMs?: number;
    /** Set when `afterStep` was called at the arrival (before the interaction). */
    capturedAt?: 'arrival';
    error?: string;
}

/** Shared, mutable run state (Node keeps the clock and the cursor across documents). */
export interface RunState {
    /** Wall-clock time of the timeline's t0 (page clock, epoch ms). */
    t0Wall: number;
    /** Accumulated `waitFor` overrun: later steps are scheduled `shiftMs` later than written. */
    shiftMs: number;
    /** Last cursor point, restored after a navigation. */
    lastPoint: { x: number; y: number } | null;
    /** Number of navigations survived. */
    navigations: number;
    /** Set by the main-frame `framenavigated` listener; consumed by the next re-boot check. */
    needsReboot?: boolean;
    /** In-flight re-boot, so concurrent callers share one boot and count one navigation. */
    rebooting?: Promise<boolean>;
}

export interface LiveOptions {
    /** Boot options for a freshly navigated document (cursor, drift, resetFocusStyles, defaultCps). */
    boot: Record<string, any>;
    /** `waitFor` selector timeout. Default 15000. */
    waitForTimeoutMs?: number;
    /** Time box for a navigation to load and the runtime to re-boot. Default 15000. */
    navigationTimeoutMs?: number;
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
    /** Live page handling (record). */
    live?: LiveOptions;
    /** Filled by the driver; pass your own object to read t0Wall/shiftMs/lastPoint afterwards. */
    state?: RunState;
    /** Steps for which `afterStep` runs at the arrival (before the interaction), e.g. navigating clicks in a guide. */
    captureBeforeAct?: (step: Step) => boolean;
    beforeStep?: (step: Step) => void | Promise<void>;
    afterStep?: (step: Step, result: StepResult) => void | Promise<void>;
}

const OWN_ANIM_MESSAGE = 'page defines its own window.__anim (not the anim-cli runtime); it cannot be driven';

/** Make sure the runtime is present and booted (without a timeline, so it never self-plays). */
export async function ensureRuntime(page: Page, timeline: Timeline, opts: InjectOptions = {}): Promise<void> {
    const kind: string = await page.evaluate(() => { const a = (window as any).__anim; return !a ? 'none' : (typeof a.boot === 'function' && typeof a.runStep === 'function' ? 'ours' : 'foreign'); });
    if (kind === 'foreign') throw new Error(OWN_ANIM_MESSAGE);
    const present = kind === 'ours';
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

/** Playwright's errors when the document went away under a running evaluate (a real navigation). */
export function isNavigationError(e: any): boolean {
    return /Execution context was destroyed|Target (page|frame|context) .*closed|Frame was detached|Navigation|navigat/i.test(errorMessage(e));
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

function appendError(result: StepResult, msg: string): void {
    result.error = result.error ? `${result.error}; ${msg}` : msg;
}

/**
 * Live pages: after a navigation the new document has the runtime (init script) but no boot.
 * Wait for load, boot with the last cursor point, and continue the Node-owned clock. Serialized
 * (concurrent callers share one boot) and time-boxed (a navigation that never loads is stopped
 * with window.stop() and reported instead of hanging the recording).
 */
export async function ensureLive(page: Page, live: LiveOptions, state: RunState): Promise<boolean> {
    if (state.rebooting) return state.rebooting;
    const timeoutMs = live.navigationTimeoutMs ?? 15000;
    const work = (async (): Promise<boolean> => {
        try {
            await page.waitForLoadState('load', { timeout: timeoutMs });
        } catch (e: any) {
            await page.evaluate(() => window.stop()).catch(() => {});
            throw new Error(`navigation did not load within ${timeoutMs}ms (stopped): ${errorMessage(e)}`);
        }
        const kind: string = await page.evaluate(() => { const a = (window as any).__anim; return !a ? 'none' : (typeof a.boot === 'function' && typeof a.runStep === 'function' ? (a.isReady() ? 'ready' : 'ours') : 'foreign'); }).catch(() => 'none');
        if (kind === 'foreign') throw new Error(OWN_ANIM_MESSAGE);
        // A booted runtime means the document is the same one (a new document has no boot); the
        // framenavigated flag also fires for same-document navigations (pushState), so it never
        // forces a re-boot by itself.
        if (kind === 'ready') { state.needsReboot = false; return false; }
        if (kind === 'none') await page.addScriptTag({ content: runtimeSource() });
        await page.evaluate((o) => { (window as any).__anim.boot(o); }, { ...live.boot, cursorPoint: state.lastPoint });
        await page.waitForFunction(() => (window as any).__anim && (window as any).__anim.isReady(), null, { timeout: timeoutMs });
        await page.evaluate((elapsed) => { (window as any).__anim.start(elapsed); }, Date.now() - state.t0Wall);
        state.needsReboot = false;
        state.navigations++;
        return true;
    })();
    state.rebooting = withTimeout(work, timeoutMs + 1000, 're-boot after navigation').finally(() => { state.rebooting = undefined; });
    return state.rebooting;
}

export async function runTimeline(page: Page, timeline: Timeline, opts: RunOptions): Promise<StepResult[]> {
    const steps = timeline.steps;
    const settleMs = opts.settleMs ?? 300;
    const stepTimeoutMs = opts.stepTimeoutMs ?? 30000;
    const afterStepAt = opts.afterStepAt ?? 'interaction';
    const live = opts.live;
    const state: RunState = opts.state ?? { t0Wall: 0, shiftMs: 0, lastPoint: null, navigations: 0 };
    if (opts.state) { opts.state.shiftMs = 0; opts.state.navigations = 0; opts.state.needsReboot = false; opts.state.rebooting = undefined; }
    const results: StepResult[] = new Array(steps.length);

    // t0 on the page's clock (epoch ms), not Date.now() after the round trip: export trims the video
    // to this instant and an evaluate round trip alone can cost a frame or two.
    state.t0Wall = await page.evaluate(() => { const a = (window as any).__anim; a.start(); const s = a.getState(); return s.timeOrigin + s.t0; });
    const t0 = state.t0Wall;

    const onNavigated = (frame: Frame) => { if (frame === page.mainFrame()) state.needsReboot = true; };
    if (live) page.on('framenavigated', onNavigated);

    const label = (step: Step) => `step ${step.index} (${step.action}${step.target ? ' ' + step.target : ''})`;
    const nowMs = () => Date.now() - t0;

    /** Everything that must happen before the cursor starts moving: re-boot after a navigation, beforeStep, waitFor. */
    const prepare = async (i: number): Promise<StepResult> => {
        const step = steps[i];
        const result: StepResult = {
            index: step.index, id: step.id, action: step.action, target: step.target,
            scheduledMs: step.timeMs, actualMs: NaN,
        };
        results[i] = result;
        if (live) {
            try {
                const rebooted = await ensureLive(page, live, state);
                // A re-boot here means the previous interaction navigated (even when its runStep
                // resolved before the navigation committed).
                if (rebooted && i > 0 && results[i - 1]) results[i - 1].navigated = true;
            } catch (e: any) { appendError(result, `re-boot after navigation: ${errorMessage(e)}`); return result; }
        }
        if (opts.beforeStep) {
            try { await opts.beforeStep(step); }
            catch (e: any) { appendError(result, `beforeStep hook: ${errorMessage(e)}`); return result; }
        }
        if (live && step.waitFor !== undefined && step.waitFor !== null) {
            const started = Date.now();
            try {
                if (typeof step.waitFor === 'number') await page.waitForTimeout(step.waitFor);
                else await page.waitForSelector(String(step.waitFor), { state: 'visible', timeout: live.waitForTimeoutMs ?? 15000 });
            } catch (e: any) {
                appendError(result, `waitFor ${JSON.stringify(step.waitFor)}: ${errorMessage(e)}`);
            }
            result.waitedMs = Date.now() - started;
        }
        return result;
    };

    const fire = async (i: number, leadMs: number, result: StepResult): Promise<void> => {
        const step = steps[i];
        // A step that did not run (hook threw, target vanished, page navigated) still reaches
        // afterStep with result.error set, so guides keep an entry (and numbering) and exit 1.
        const finishFailed = async () => {
            if (opts.afterStep) {
                try { await opts.afterStep(step, result); }
                catch (e: any) { appendError(result, `afterStep hook: ${errorMessage(e)}`); }
            }
        };
        if (result.error && !/^waitFor /.test(result.error)) { await finishFailed(); return; }

        const navigatedOk = (e: any) => !!live && isNavigationError(e) && NAVIGATING_ACTIONS.has(step.action);
        const twoPhase = !!(opts.captureBeforeAct && opts.captureBeforeAct(step));
        let token: number | undefined;
        let afterStepDone = false;
        try {
            const r: StepResult & { token?: number; phase?: string } = await withTimeout(
                page.evaluate(
                    ([s, o]) => (window as any).__anim.runStep(s, o),
                    [step, { leadMs, instant: !!opts.instant, holdBeforeAct: twoPhase }] as [Step, { leadMs: number; instant: boolean; holdBeforeAct: boolean }],
                ),
                stepTimeoutMs,
                label(step),
            );
            if (r.phase === 'arrival') {
                // Two-phase: capture at the arrival, then act.
                const holdToken = r.token!;
                delete r.token; delete r.phase;
                Object.assign(result, r);
                if (result.point) state.lastPoint = result.point;
                result.capturedAt = 'arrival';
                if (opts.afterStep) {
                    try { await opts.afterStep(step, result); }
                    catch (e: any) { appendError(result, `afterStep hook: ${errorMessage(e)}`); }
                }
                afterStepDone = true;
                const acted: StepResult & { token?: number } = await withTimeout(
                    page.evaluate((t) => (window as any).__anim.act(t), holdToken),
                    stepTimeoutMs,
                    `${label(step)} act`,
                );
                token = acted.token;
                delete acted.token;
                Object.assign(result, acted, { capturedAt: 'arrival' });
            } else {
                token = r.token;
                delete r.token;
                Object.assign(result, r);
            }
            if (result.point) state.lastPoint = result.point;
        } catch (e: any) {
            if (navigatedOk(e)) {
                // The interaction itself navigated (form submit, link): count it as done at this moment.
                result.actualMs = nowMs();
                result.completedMs = result.actualMs;
                result.navigated = true;
            } else {
                appendError(result, errorMessage(e));
                if (!afterStepDone) await finishFailed();
                return;
            }
        }

        // Driver-side actions at the interaction moment.
        if (step.action === 'press' && typeof step.value === 'string') {
            try { await page.keyboard.press(step.value); }
            catch (e: any) { appendError(result, `keyboard.press(${JSON.stringify(step.value)}): ${errorMessage(e)}`); }
        }
        if (step.action === 'navigate' && typeof step.url === 'string') {
            if (live) {
                try {
                    await page.goto(step.url, { waitUntil: 'load', timeout: live.navigationTimeoutMs ?? 15000 });
                    result.navigated = true;
                    result.completedMs = nowMs();
                    token = undefined;
                } catch (e: any) {
                    await page.evaluate(() => window.stop()).catch(() => {});
                    appendError(result, `navigate ${step.url}: ${errorMessage(e)}`);
                }
            } else {
                appendError(result, 'navigate only runs under `record` (live pages)');
            }
        }

        const awaitCompletion = async () => {
            if (token === undefined || Number.isFinite(result.completedMs ?? NaN)) return;
            try {
                result.completedMs = await withTimeout(
                    page.evaluate((t) => (window as any).__anim.whenDone(t), token),
                    stepTimeoutMs,
                    `${label(step)} completion`,
                );
            } catch (e: any) {
                if (navigatedOk(e)) { result.completedMs = nowMs(); result.navigated = true; }
                else appendError(result, errorMessage(e));
            }
        };

        const at = afterStepAt === 'auto' ? captureAtFor(step) : afterStepAt;
        if (at === 'completion') await awaitCompletion();
        if (result.navigated && live) {
            // Give the new document a chance to be ready before a capture hook looks at it.
            try { await ensureLive(page, live, state); } catch (e: any) { appendError(result, `re-boot after navigation: ${errorMessage(e)}`); }
        }
        if (!afterStepDone) {
            if (opts.mode === 'step' && settleMs > 0 && !opts.instant) await page.waitForTimeout(settleMs);
            if (opts.afterStep) {
                try { await opts.afterStep(step, result); }
                catch (e: any) { appendError(result, `afterStep hook: ${errorMessage(e)}`); }
            }
        }
        await awaitCompletion();
    };

    try {
        if (opts.mode === 'step') {
            for (let i = 0; i < steps.length; i++) {
                const result = await prepare(i);
                await fire(i, opts.leadMs ?? DEFAULT_LEAD_MS, result);
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
            let leadMs = leadMsFor(step, steps[i - 1]);
            const startAt = t0 + step.timeMs - leadMs + state.shiftMs;
            const delay = startAt - Date.now();
            if (delay > 0) await page.waitForTimeout(delay);
            const result = await prepare(i);
            if (live) {
                // Preparation (re-boot after a navigation, waitFor) may run past the planned start. The
                // cursor lead absorbs it first (down to a press-only lead); only what is left beyond the
                // planned interaction moment shifts this and every later step, so the written spacing
                // between steps is preserved on the recording.
                const plannedInteraction = t0 + step.timeMs + state.shiftMs;
                const now = Date.now();
                if (now + leadMs > plannedInteraction) {
                    leadMs = Math.max(MIN_LIVE_LEAD_MS, Math.round(plannedInteraction - now));
                    const late = Math.round(now + leadMs - plannedInteraction);
                    if (late > 50) state.shiftMs += late;
                }
            }
            // fire() never rejects (hook and evaluate errors land in result.error), so an
            // unhandled rejection cannot escape before Promise.all.
            pending.push(fire(i, leadMs, result).catch((e) => { appendError(results[i], errorMessage(e)); }));
        }
        await Promise.all(pending);
        return results;
    } finally {
        if (live) page.off('framenavigated', onNavigated);
    }
}
