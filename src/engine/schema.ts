import * as fs from 'fs';
import * as path from 'path';

/**
 * Timeline schema: parsing, normalization and validation of anim.config.json.
 *
 * Two on-disk forms are accepted:
 *   - legacy bare array:  [ { "time": "2s", "action": "click", ... }, ... ]
 *   - object form:        { "meta": { ... }, "steps": [ ... ] }
 * Both normalize to a Timeline { meta, steps } where every step carries `timeMs`,
 * a stable `id`, a 1-based `index`, and (when it has a subtitle) `subtitleMs`.
 *
 * Timing semantics: a step's `time` is the moment the interaction happens (click,
 * focus, first typed char, highlight pulse). Cursor travel is scheduled *before* it,
 * see leadMsFor().
 */

export const ACTIONS = [
    'wait', 'click', 'focus', 'type', 'highlight', 'hover', 'camera', 'scroll',
    'fadeIn', 'transitionScreen', 'navigate', 'press',
] as const;
export type Action = typeof ACTIONS[number];

/** Actions that must have a `target` selector. */
export const TARGET_REQUIRED: ReadonlySet<string> = new Set([
    'click', 'focus', 'type', 'highlight', 'hover', 'scroll', 'fadeIn', 'transitionScreen',
]);
/** Actions where the cursor travels to the target and a spotlight highlight is shown. */
export const CURSOR_ACTIONS: ReadonlySet<string> = new Set(['click', 'focus', 'type', 'highlight', 'hover']);

/** Deprecated aliases, rewritten at parse time. */
export const ACTION_ALIASES: Record<string, Action> = { showText: 'fadeIn' };

export const DEFAULT_LEAD_MS = 950;
export const DEFAULT_TAIL_MS = 2500;
export const DEFAULT_CPS = 25;
export const DEFAULT_CAMERA_DURATION_S = 2.5;
export const SUBTITLE_HOLD_MS = 4000;
export const SUBTITLE_MIN_MS = 1000;

export interface TimelineMeta {
    title?: string;
    slug?: string;
    app?: string;
    url?: string;
    locale?: string;
    tailMs?: number;
    cursor?: 'mac' | 'windows' | 'none';
    resetFocusStyles?: boolean;
    drift?: boolean;
    voice?: { openai?: string; say?: string };
    [key: string]: any;
}

export interface Step {
    /** 1-based position in the timeline. */
    index: number;
    id: string;
    /** Original `time` value as written in the config. */
    time: string | number;
    /** Interaction moment in milliseconds (NaN if unparseable; reported by validateTimeline). */
    timeMs: number;
    action: string;
    target?: string;
    value?: string;
    title?: string;
    subtitle?: string | null;
    /** Display window for `subtitle`, derived by subtitleWindows(). Present only when subtitle is set. */
    subtitleMs?: number;
    narration?: string;
    note?: string;
    translatable?: boolean;
    crop?: number | false;
    guide?: boolean;
    waitFor?: string | number;
    url?: string;
    cps?: number;
    scale?: number;
    x?: number | string;
    y?: number | string;
    duration?: number;
    xOffset?: number | string;
    yOffset?: number | string;
    /** Set when the action was rewritten from a deprecated alias (e.g. showText). */
    deprecatedAction?: string;
    [key: string]: any;
}

export interface Timeline {
    meta: TimelineMeta;
    steps: Step[];
    /** true when the file was a bare array (legacy form). */
    legacy: boolean;
}

export interface Issue {
    level: 'error' | 'warning';
    /** 1-based step index, when the issue concerns a single step. */
    step?: number;
    id?: string;
    field?: string;
    message: string;
    /** Convenience copies for readable output. */
    time?: string | number;
    action?: string;
    target?: string;
}

export interface SubtitleWindow {
    index: number;
    id: string;
    startMs: number;
    endMs: number;
    text: string;
}

/** "2s" | "2000ms" | "2" | 2 | 2.5 -> milliseconds. NaN when unparseable. */
export function parseTime(t: unknown): number {
    if (typeof t === 'number') return Number.isFinite(t) ? Math.round(t * 1000) : NaN;
    if (typeof t !== 'string') return NaN;
    const s = t.trim();
    let m = /^(-?\d+(?:\.\d+)?)\s*ms$/i.exec(s);
    if (m) return Math.round(parseFloat(m[1]));
    m = /^(-?\d+(?:\.\d+)?)\s*s?$/i.exec(s);
    if (m) return Math.round(parseFloat(m[1]) * 1000);
    return NaN;
}

export function formatTime(ms: number): string {
    if (!Number.isFinite(ms)) return '?';
    return (ms / 1000).toFixed(ms % 1000 === 0 ? 1 : 2).replace(/0+$/, '').replace(/\.$/, '.0') + 's';
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

/** Normalize a raw config (bare array or object form) into a Timeline. Throws on a structurally invalid document. */
export function parseTimeline(raw: unknown): Timeline {
    let meta: TimelineMeta = {};
    let rawSteps: unknown;
    let legacy = false;
    if (Array.isArray(raw)) {
        rawSteps = raw;
        legacy = true;
    } else if (raw && typeof raw === 'object') {
        const obj = raw as any;
        if (obj.meta != null && (typeof obj.meta !== 'object' || Array.isArray(obj.meta))) {
            throw new Error('"meta" must be an object');
        }
        meta = { ...(obj.meta || {}) };
        rawSteps = obj.steps;
        if (!Array.isArray(rawSteps)) throw new Error('config must be an array of steps or an object with a "steps" array');
    } else {
        throw new Error('config must be an array of steps or an object with a "steps" array');
    }

    const steps: Step[] = (rawSteps as unknown[]).map((s, i) => {
        const index = i + 1;
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
            throw new Error(`step ${index} must be an object`);
        }
        const src = s as Record<string, any>;
        let action = typeof src.action === 'string' ? src.action : src.action;
        let deprecatedAction: string | undefined;
        if (typeof action === 'string' && ACTION_ALIASES[action]) {
            deprecatedAction = action;
            action = ACTION_ALIASES[action];
        }
        const step: Step = {
            ...src,
            index,
            id: typeof src.id === 'string' && src.id.trim() ? src.id.trim() : `step-${pad2(index)}`,
            time: src.time,
            timeMs: parseTime(src.time),
            action,
        };
        if (deprecatedAction) step.deprecatedAction = deprecatedAction;
        return step;
    });

    const timeline: Timeline = { meta, steps, legacy };
    for (const w of subtitleWindows(timeline)) {
        steps[w.index - 1].subtitleMs = w.endMs - w.startMs;
    }
    return timeline;
}

/** Read and parse `<dir>/anim.config.json`. Throws with a readable message when missing or invalid. */
export function loadTimeline(dir: string, _opts: { locale?: string } = {}): Timeline {
    const p = path.resolve(dir, 'anim.config.json');
    if (!fs.existsSync(p)) {
        throw new Error(`anim.config.json not found in ${path.resolve(dir)} (run \`init-config ${dir}\` to scaffold one)`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e: any) {
        throw new Error(`${p}: invalid JSON (${e.message})`);
    }
    try {
        return parseTimeline(raw);
    } catch (e: any) {
        throw new Error(`${p}: ${e.message}`);
    }
}

/** Milliseconds a `type` step spends typing. */
export function typingDurationMs(step: Step): number {
    if (step.action !== 'type' || typeof step.value !== 'string') return 0;
    const cps = typeof step.cps === 'number' && step.cps > 0 ? step.cps : DEFAULT_CPS;
    return Math.round((step.value.length / cps) * 1000);
}

/** Time a step keeps animating after its interaction moment (typing, camera move, fades). */
export function intrinsicDurationMs(step: Step): number {
    switch (step.action) {
        case 'type': return typingDurationMs(step);
        case 'camera': return Math.round((typeof step.duration === 'number' ? step.duration : DEFAULT_CAMERA_DURATION_S) * 1000);
        case 'fadeIn':
        case 'transitionScreen': return 800;
        case 'scroll': return 600;
        default: return 0;
    }
}

/** Total playback length: last step's interaction + its intrinsic duration + meta.tailMs (default 2500). */
export function computeDurationMs(timeline: Timeline): number {
    const tail = typeof timeline.meta.tailMs === 'number' ? timeline.meta.tailMs : DEFAULT_TAIL_MS;
    let end = 0;
    for (const s of timeline.steps) {
        if (!Number.isFinite(s.timeMs)) continue;
        end = Math.max(end, s.timeMs + intrinsicDurationMs(s));
    }
    return end + tail;
}

/** Subtitle display windows: each subtitle shows until the next subtitle, or 4s, never less than 1s. */
export function subtitleWindows(timeline: Timeline): SubtitleWindow[] {
    const out: SubtitleWindow[] = [];
    const steps = timeline.steps;
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (!s.subtitle || !Number.isFinite(s.timeMs)) continue;
        let nextMs = s.timeMs + SUBTITLE_HOLD_MS;
        for (let j = i + 1; j < steps.length; j++) {
            if (steps[j].subtitle && Number.isFinite(steps[j].timeMs)) { nextMs = steps[j].timeMs; break; }
        }
        const endMs = s.timeMs + Math.max(SUBTITLE_MIN_MS, nextMs - s.timeMs);
        out.push({ index: s.index, id: s.id, startMs: s.timeMs, endMs, text: String(s.subtitle) });
    }
    return out;
}

/**
 * How long before `step.timeMs` the cursor starts travelling:
 * min(950, gap since the previous step's interaction, timeMs). A step at 0s gets 0 (cursor appears on target).
 */
export function leadMsFor(step: Step, prev?: Step): number {
    let lead = DEFAULT_LEAD_MS;
    if (Number.isFinite(step.timeMs)) lead = Math.min(lead, Math.max(0, step.timeMs));
    if (prev && Number.isFinite(prev.timeMs) && Number.isFinite(step.timeMs)) {
        lead = Math.min(lead, Math.max(0, step.timeMs - prev.timeMs));
    }
    return lead;
}

function issueFor(step: Step, level: Issue['level'], message: string, field?: string): Issue {
    return { level, step: step.index, id: step.id, field, message, time: step.time, action: step.action, target: step.target };
}

/** Static validation. Errors make `build`/`check` fail; warnings are informational. */
export function validateTimeline(timeline: Timeline): Issue[] {
    const issues: Issue[] = [];
    const steps = timeline.steps;
    const seenIds = new Map<string, number>();
    let prevMs: number | undefined;

    if (steps.length === 0) issues.push({ level: 'warning', message: 'timeline has no steps' });

    for (const s of steps) {
        if (s.time === undefined || s.time === null) {
            issues.push(issueFor(s, 'error', 'missing "time"', 'time'));
        } else if (!Number.isFinite(s.timeMs)) {
            issues.push(issueFor(s, 'error', `invalid "time" ${JSON.stringify(s.time)} (use "2s", "2000ms" or a number of seconds)`, 'time'));
        } else if (s.timeMs < 0) {
            issues.push(issueFor(s, 'error', `"time" must not be negative`, 'time'));
        } else if (prevMs !== undefined && s.timeMs < prevMs) {
            issues.push(issueFor(s, 'error', `"time" ${formatTime(s.timeMs)} is earlier than the previous step (${formatTime(prevMs)}); steps must be in chronological order`, 'time'));
        }
        if (Number.isFinite(s.timeMs)) prevMs = s.timeMs;

        if (typeof s.action !== 'string' || !s.action) {
            issues.push(issueFor(s, 'error', 'missing "action"', 'action'));
        } else if (!(ACTIONS as readonly string[]).includes(s.action)) {
            issues.push(issueFor(s, 'error', `unknown action "${s.action}" (expected one of: ${ACTIONS.join(', ')})`, 'action'));
        } else {
            if (s.deprecatedAction) {
                issues.push(issueFor(s, 'warning', `action "${s.deprecatedAction}" is deprecated, use "${s.action}"`, 'action'));
            }
            if (TARGET_REQUIRED.has(s.action) && (typeof s.target !== 'string' || !s.target.trim())) {
                issues.push(issueFor(s, 'error', `action "${s.action}" requires a "target" selector`, 'target'));
            }
            if (s.action === 'type' && (typeof s.value !== 'string' || s.value.length === 0)) {
                issues.push(issueFor(s, 'error', 'action "type" requires a non-empty "value" string', 'value'));
            }
            if (s.action === 'navigate' && (typeof s.url !== 'string' || !s.url)) {
                issues.push(issueFor(s, 'error', 'action "navigate" requires a "url"', 'url'));
            }
            if (s.action === 'press' && (typeof s.value !== 'string' || !s.value)) {
                issues.push(issueFor(s, 'error', 'action "press" requires a "value" (key name, e.g. "Enter")', 'value'));
            }
            if (s.action === 'camera' && s.scale == null && s.target == null && s.x == null && s.y == null) {
                issues.push(issueFor(s, 'warning', 'camera step has no "scale", "target", "x" or "y"; it resets the camera', 'scale'));
            }
        }
        if (s.target !== undefined && typeof s.target !== 'string') {
            issues.push(issueFor(s, 'error', '"target" must be a CSS selector string', 'target'));
        }
        if (s.cps !== undefined && (typeof s.cps !== 'number' || s.cps <= 0)) {
            issues.push(issueFor(s, 'error', '"cps" must be a positive number', 'cps'));
        }
        if (s.waitFor !== undefined && typeof s.waitFor !== 'string' && typeof s.waitFor !== 'number') {
            issues.push(issueFor(s, 'error', '"waitFor" must be a selector string or a number of milliseconds', 'waitFor'));
        }
        if (s.scale !== undefined && (typeof s.scale !== 'number' || s.scale <= 0)) {
            issues.push(issueFor(s, 'error', '"scale" must be a positive number', 'scale'));
        }
        if (s.duration !== undefined && (typeof s.duration !== 'number' || s.duration < 0)) {
            issues.push(issueFor(s, 'error', '"duration" must be a number of seconds', 'duration'));
        }

        const dup = seenIds.get(s.id);
        if (dup !== undefined) issues.push(issueFor(s, 'warning', `duplicate id "${s.id}" (also used by step ${dup})`, 'id'));
        else seenIds.set(s.id, s.index);
    }

    // Typing overrun: a type step whose typing runs past the next interaction.
    // Camera moves and waits are not interactions (typing while the camera pushes in is a normal beat).
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.action !== 'type' || typeof s.value !== 'string' || !Number.isFinite(s.timeMs)) continue;
        const typeMs = typingDurationMs(s);
        const next = steps.slice(i + 1).find(n => Number.isFinite(n.timeMs) && n.action !== 'camera' && n.action !== 'wait');
        if (next && s.timeMs + typeMs > next.timeMs) {
            issues.push(issueFor(s, 'warning', `typing ${s.value!.length} chars takes ${typeMs}ms and overruns the next step at ${formatTime(next.timeMs)} by ${s.timeMs + typeMs - next.timeMs}ms (raise "cps" or space the steps out)`, 'value'));
        }
    }

    return issues;
}

export function hasErrors(issues: Issue[]): boolean {
    return issues.some(i => i.level === 'error');
}

/** One readable line per issue, e.g. `error    step 3 (5s type #x): message`. */
export function formatIssue(issue: Issue): string {
    const level = issue.level === 'error' ? 'error  ' : 'warning';
    if (issue.step === undefined) return `${level}  ${issue.message}`;
    const where = [issue.time !== undefined ? formatTime(parseTime(issue.time)) : null, issue.action, issue.target]
        .filter(Boolean).join(' ');
    return `${level}  step ${issue.step}${where ? ` (${where})` : ''}: ${issue.message}`;
}
