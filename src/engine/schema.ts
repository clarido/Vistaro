import * as fs from 'fs';
import * as path from 'path';
import { readManifest } from '../manifest';
import { applyStrings, readStrings, resolveLocale, stringsPath, stringsPathFor, isLocaleCode } from './strings';

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
    'fadeIn', 'transitionScreen', 'navigate', 'press', 'animate',
] as const;
export type Action = typeof ACTIONS[number];

/** Actions that must have a `target` selector. */
export const TARGET_REQUIRED: ReadonlySet<string> = new Set([
    'click', 'focus', 'type', 'highlight', 'hover', 'scroll', 'fadeIn', 'transitionScreen', 'animate',
]);
/** Actions where the cursor travels to the target and a spotlight highlight is shown. */
export const CURSOR_ACTIONS: ReadonlySet<string> = new Set(['click', 'focus', 'type', 'highlight', 'hover']);
/** Actions whose result is only visible once they finish (typing, camera, fades, scroll). */
export const STATE_ACTIONS: ReadonlySet<string> = new Set(['type', 'camera', 'fadeIn', 'transitionScreen', 'scroll', 'navigate', 'animate']);

export type CaptureAt = 'interaction' | 'completion';

/**
 * When a guide/preview frame of this step is taken: cursor actions at the interaction (+settle,
 * inside the held spotlight), state actions at completion (full typed text, zoomed framing,
 * faded-in element). `step.captureAt` overrides.
 */
export function captureAtFor(step: Step): CaptureAt {
    if (step.captureAt === 'interaction' || step.captureAt === 'completion') return step.captureAt;
    return STATE_ACTIONS.has(step.action) ? 'completion' : 'interaction';
}

/** A marketing clip rather than a help document: no guide chrome, no guide validation. */
export function isReel(timeline: Timeline): boolean {
    return timeline.meta?.kind === 'reel';
}

/**
 * Whether Chromium's mobile emulation (isMobile/hasTouch/mobile UA) is used for this timeline when
 * the device is mobile. Reels only: they declare a viewport meta and are authored for a phone, while
 * a guide mockup usually declares none and would be laid out at 980px and shrunk to fit.
 *
 * Every command that opens a browser context for a timeline derives it from here, so preview, check
 * and export cannot disagree about the conditions a reel renders under.
 */
export function emulateMobileFor(timeline: Timeline | undefined): boolean {
    return !!timeline && isReel(timeline);
}

/**
 * The effective chrome and playback flags. `kind` picks the defaults (a reel is silent and loops,
 * a guide shows its chrome once) and an explicit `meta.reel` value always wins over that default.
 */
export function reelOptions(timeline: Timeline): ResolvedReelOptions {
    const reel = isReel(timeline);
    const o: ReelOptions = timeline.meta?.reel || {};
    const flag = (v: boolean | undefined, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
    return {
        spotlight: flag(o.spotlight, !reel),
        ripple: flag(o.ripple, !reel),
        subtitles: flag(o.subtitles, !reel),
        loop: flag(o.loop, reel),
        autoplay: o.autoplay ?? (reel ? 'inview' : 'immediate'),
        poster: o.poster ?? 'last',
    };
}

/**
 * Named easings an `animate` or `camera` step may use. The curves themselves live in runtime.js
 * (EASINGS); this list exists only to validate the name before the browser sees it, so the two must
 * be kept in step -- test/constants.test.ts asserts they hold the same names.
 */
export const EASING_NAMES = ['linear', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeOutBack', 'easeOutExpo', 'spring'] as const;
export type EasingName = typeof EASING_NAMES[number];

/** Render targets a timeline can be resolved for; `mobile`/`desktop`/`only` in a step key off this. */
export type DeviceKind = 'desktop' | 'mobile';
export const DEVICE_KINDS: readonly DeviceKind[] = ['desktop', 'mobile'];

/** Transform-composing keys of an `animate` step's `from`/`to`; anything else is a raw CSS property. */
export const TRANSFORM_KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'] as const;

/** Deprecated aliases, rewritten at parse time. */
export const ACTION_ALIASES: Record<string, Action> = { showText: 'fadeIn' };

// These, plus DEFAULT_TAIL_MS and SUBTITLE_HOLD_MS below, are mirrored as literals in
// src/engine/runtime.js (plain JS cannot import); test/constants.test.ts asserts they stay equal.
export const DEFAULT_LEAD_MS = 950;
export const DEFAULT_CPS = 25;
export const DEFAULT_CAMERA_DURATION_S = 2.5;
export const DEFAULT_FADE_MS = 800;
export const DEFAULT_SCROLL_MS = 600;
export const DEFAULT_ANIMATE_DURATION_S = 0.6;
export const DEFAULT_TAIL_MS = 2500;
export const SUBTITLE_HOLD_MS = 4000;
export const SUBTITLE_MIN_MS = 1000;

/**
 * Output profile. `guide` (the default) is documentation: spotlight, ripple, subtitle bar and the
 * guide-oriented validations. `reel` is a silent marketing clip: that chrome is off and the guide
 * validations do not apply. Every flag stays individually overridable through `meta.reel`.
 */
export type TimelineKind = 'guide' | 'reel';
export const TIMELINE_KINDS: readonly TimelineKind[] = ['guide', 'reel'];
export type AutoplayMode = 'immediate' | 'inview' | 'message';
export const AUTOPLAY_MODES: readonly AutoplayMode[] = ['immediate', 'inview', 'message'];

/** Per-timeline overrides of the profile defaults; see reelOptions() for how they resolve. */
export interface ReelOptions {
    spotlight?: boolean;
    ripple?: boolean;
    subtitles?: boolean;
    loop?: boolean;
    autoplay?: AutoplayMode;
    /**
     * Which frame becomes the poster: `"last"` (default) the final step's completion, which is the
     * composed payoff a `<video poster>` should show; `"first"` the opening step's completion; or an
     * explicit time ("3.2s", or seconds as a number) for a specific beat.
     */
    poster?: 'last' | 'first' | string | number;
}

export interface ResolvedReelOptions {
    spotlight: boolean;
    ripple: boolean;
    subtitles: boolean;
    loop: boolean;
    autoplay: AutoplayMode;
    poster: 'last' | 'first' | string | number;
}

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
    /** Output profile: `reel` switches the guide chrome and the guide validations off. Default `guide`. */
    kind?: TimelineKind;
    /** Individual overrides of whatever `kind` implies. */
    reel?: ReelOptions;
    /**
     * Live pages: a shell command run before each pass over the page (the recording, then the guide
     * replay) to put the app back into its starting state. A timeline that writes data is not
     * idempotent, and `record --guide` replays it twice. `--reset-cmd` overrides it.
     */
    reset?: string;
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
    /** Suppress the spotlight / click ripple for this step alone (the profile default otherwise applies). */
    spotlight?: boolean;
    ripple?: boolean;
    /** `animate`: start and end state. `x`/`y` (px), `scale`/`scaleX`/`scaleY`, `rotate` (deg) compose
     *  into one transform (translate, then scale, then rotate); every other key is a raw CSS property. */
    from?: Record<string, string | number>;
    to?: Record<string, string | number>;
    /** `animate`: animate every match of `target` rather than the first. */
    all?: boolean;
    /** `animate`: seconds between successive elements when `all` is set. */
    stagger?: number;
    /** `animate`: how many elements `target` is expected to match, so the length estimate is right. */
    count?: number;
    /** Named easing for `animate` and `camera` (see EASING_NAMES). */
    ease?: EasingName | string;
    /** Per-device overrides, shallow-merged into the step when the render device matches. */
    mobile?: Record<string, any>;
    desktop?: Record<string, any>;
    /** Render this step for one device only; it is dropped entirely for the other. */
    only?: DeviceKind;
    crop?: number | false;
    guide?: boolean;
    /** Guide/preview frame moment override: "interaction" or "completion" (default per action, see captureAtFor). */
    captureAt?: 'interaction' | 'completion';
    waitFor?: string | number;
    /** Live pages: how long `waitFor` (a selector) may wait before giving up, in ms (default 15000). */
    waitForTimeoutMs?: number;
    url?: string;
    cps?: number;
    /** camera: zoom factor (1 = none). */
    scale?: number;
    x?: number | string;
    y?: number | string;
    /**
     * Seconds. camera: length of the pan/zoom (default 2.5). fadeIn / transitionScreen: length of the
     * fade; when set it overrides the element's own CSS transition, when absent the runtime honours
     * that transition and the static estimate is 0.8s.
     */
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
    /** Locale the timeline was loaded for (--locale > manifest > meta.locale), when any. */
    locale?: string;
    /** Source language of the strings (manifest baseLocale set by `localize`, else meta.locale). */
    baseLocale?: string;
    /** Strings file applied by loadTimeline, with its key report. */
    strings?: { file: string; locale: string; applied: string[]; unknown: string[]; missing: string[]; untranslated: string[] };
    /** Absolute path of the file this timeline was read from; set by loadTimeline. */
    configFile?: string;
}

export interface Issue {
    /** info = nothing wrong, but worth knowing (e.g. which ancestor carries the spotlight for a 0x0 target). */
    level: 'error' | 'warning' | 'info';
    /** 1-based step index, when the issue concerns a single step. */
    step?: number;
    id?: string;
    field?: string;
    message: string;
    /** Convenience copies for readable output. */
    time?: string | number;
    action?: string;
    target?: string;
    /** Selector of the sized ancestor the spotlight uses when the target itself is 0x0. */
    highlightFallback?: string;
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
        let action = src.action;
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
    assignSubtitleWindows(timeline);
    return timeline;
}

/**
 * Which timeline file a directory means: `config` relative to `dir` (absolute passes through),
 * else `anim.config.json`. One place decides it, so the strings file, the content hash and the
 * output names all derive from the same answer.
 */
export function resolveConfigPath(dir: string, config?: string): string {
    return path.resolve(dir, config || 'anim.config.json');
}

/**
 * Read and parse the directory's timeline (`opts.config`, else `<dir>/anim.config.json`), then
 * overlay that timeline's strings file when one exists for
 * the resolved locale (--locale > anim.manifest.json locale > meta.locale). Every command loads
 * its timeline through here, so a localized directory renders translated titles, subtitles,
 * narration, notes and translatable typed values without touching the choreography.
 * Throws with a readable message when missing or invalid.
 */
export function loadTimeline(dir: string, opts: { locale?: string; device?: DeviceKind; config?: string } = {}): Timeline {
    const p = resolveConfigPath(dir, opts.config);
    if (!fs.existsSync(p)) {
        // Keyed on where it RESOLVED, not on whether an option was passed, so an explicit
        // --config anim.config.json still gets the scaffolding hint.
        throw new Error(p === path.resolve(dir, 'anim.config.json')
            ? `anim.config.json not found in ${path.resolve(dir)} (run \`init-config ${dir}\` to scaffold one)`
            : `timeline not found: ${p}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e: any) {
        throw new Error(`${p}: invalid JSON (${e.message})`);
    }
    let timeline: Timeline;
    try {
        timeline = parseTimeline(raw);
    } catch (e: any) {
        throw new Error(`${p}: ${e.message}`);
    }
    const manifest = readManifest(dir);
    const locale = resolveLocale(opts.locale, manifest.locale, timeline.meta.locale);
    // Legacy manifests carried a directory name in baseLocale; only a locale code is trusted.
    timeline.baseLocale = (isLocaleCode(manifest.baseLocale) ? manifest.baseLocale : undefined) || timeline.meta.locale || undefined;
    if (locale) {
        timeline.locale = locale;
        const file = stringsPathFor(p, locale);
        if (fs.existsSync(file)) {
            let strings;
            try { strings = readStrings(file); } catch (e: any) { throw new Error(e.message); }
            const report = applyStrings(timeline, strings);
            timeline.strings = { file, locale, ...report };
        }
    }
    // After the strings are applied (so a translated override still lands) and before any validation,
    // so every caller downstream sees one already-resolved timeline.
    if (opts.device) applyDevice(timeline, opts.device);
    timeline.configFile = p;
    return timeline;
}

/**
 * Store each subtitle's display window on its step. Looked up by `index` rather than by position,
 * because a device-resolved timeline can have gaps in its numbering.
 */
export function assignSubtitleWindows(timeline: Timeline): void {
    const byIndex = new Map(timeline.steps.map(s => [s.index, s]));
    for (const s of timeline.steps) delete s.subtitleMs;
    for (const w of subtitleWindows(timeline)) {
        const step = byIndex.get(w.index);
        if (step) step.subtitleMs = w.endMs - w.startMs;
    }
}

/**
 * Resolve the per-device fields in place: drop `only` steps meant for the other device, shallow-merge
 * a matching `mobile`/`desktop` block into the step, then strip all three keys so nothing downstream
 * needs to know which device this is.
 *
 * Runs after ids are assigned, so dropping a step never renumbers the auto ids (`step-03`) that a
 * strings file is keyed on; `index` therefore keeps the authored numbering and can be non-contiguous.
 */
export function applyDevice(timeline: Timeline, device: DeviceKind): Timeline {
    const other: DeviceKind = device === 'mobile' ? 'desktop' : 'mobile';
    timeline.steps = timeline.steps.filter(s => typeof s.only !== 'string' || s.only === device);
    for (const s of timeline.steps) {
        const override = s[device];
        if (override && typeof override === 'object' && !Array.isArray(override)) {
            Object.assign(s, override);
            if ('time' in override) s.timeMs = parseTime(s.time);
        }
        delete s[device];
        delete s[other];
        delete s.only;
    }
    // Unconditionally, because a subtitle's window runs until the NEXT subtitle: dropping an `only`
    // step invalidates the window of the step before it just as surely as retiming one does, and
    // re-deriving when nothing moved is a no-op.
    assignSubtitleWindows(timeline);
    return timeline;
}

/** The render device a `--device` flag selects; anything unrecognised renders as desktop. */
export function deviceKind(device: unknown): DeviceKind {
    return device === 'mobile' ? 'mobile' : 'desktop';
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
        case 'transitionScreen': return typeof step.duration === 'number' && step.duration >= 0 ? Math.round(step.duration * 1000) : DEFAULT_FADE_MS;
        case 'scroll': return DEFAULT_SCROLL_MS;
        case 'animate': {
            // An estimate: the last element starts `stagger` x (count - 1) after the first. `count` is
            // an authored hint, so export still extends the recording when the real match count is higher.
            const durationMs = Math.round((typeof step.duration === 'number' ? step.duration : DEFAULT_ANIMATE_DURATION_S) * 1000);
            const stagger = typeof step.stagger === 'number' && step.stagger > 0 ? step.stagger : 0;
            const count = typeof step.count === 'number' && step.count > 0 ? Math.floor(step.count) : 1;
            return durationMs + Math.round(stagger * 1000 * Math.max(0, count - 1));
        }
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

/**
 * Subtitle display windows: each subtitle shows until the next subtitle, or 4s, never less than 1s.
 * `startMsOf` anchors the windows (scheduled times by default; measured interaction times during export);
 * `durationMs` drops windows starting at/after the end of a shortened export and clamps the last one.
 */
export function subtitleWindows(timeline: Timeline, startMsOf: (step: Step) => number = s => s.timeMs, durationMs?: number): SubtitleWindow[] {
    const out: SubtitleWindow[] = [];
    const subs = timeline.steps.filter(s => s.subtitle && Number.isFinite(startMsOf(s)));
    for (let i = 0; i < subs.length; i++) {
        const s = subs[i];
        const startMs = startMsOf(s);
        if (durationMs !== undefined && startMs >= durationMs) continue;
        const nextMs = i + 1 < subs.length ? startMsOf(subs[i + 1]) : startMs + SUBTITLE_HOLD_MS;
        let endMs = startMs + Math.max(SUBTITLE_MIN_MS, nextMs - startMs);
        if (durationMs !== undefined) endMs = Math.min(endMs, durationMs);
        out.push({ index: s.index, id: s.id, startMs, endMs, text: String(s.subtitle) });
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

/** An Issue carrying the step's identity. Shared with `check`, so both passes report the same shape. */
export function issueFor(step: Step, level: Issue['level'], message: string, field?: string): Issue {
    return { level, step: step.index, id: step.id, field, message, time: step.time, action: step.action, target: step.target };
}

/** A step that gets a numbered entry in the guide: not hidden with `guide: false`, and not target-less choreography (wait/camera/scroll). */
export function isGuideStep(step: Step): boolean {
    if (step.guide === false) return false;
    if (!step.target && (step.action === 'wait' || step.action === 'camera' || step.action === 'scroll')) return false;
    return true;
}

/** Above this many numbered steps a guide is usually two guides (guide.html is one flat scroll of full-width frames). */
export const GUIDE_STEPS_WARN_ABOVE = 10;

/**
 * Static validation. Errors make `build`/`check` fail; warnings are informational.
 * `live`: validating for `record`. `guide`: a guide is being produced, so a numbered step without a
 * `title` is an error (a heading-less step in a help document), not a warning.
 */
export function validateTimeline(timeline: Timeline, opts: { live?: boolean; guide?: boolean } = {}): Issue[] {
    const issues: Issue[] = [];
    const steps = timeline.steps;
    const meta = timeline.meta || {};
    // Profile: an unknown kind or a malformed `reel` block would silently fall back to guide
    // behaviour, so both are errors rather than warnings.
    if (meta.kind !== undefined && !TIMELINE_KINDS.includes(meta.kind)) {
        issues.push({ level: 'error', field: 'kind', message: `meta.kind must be ${TIMELINE_KINDS.map(k => `"${k}"`).join(' or ')} (got ${JSON.stringify(meta.kind)})` });
    }
    if (meta.reel !== undefined) {
        if (!meta.reel || typeof meta.reel !== 'object' || Array.isArray(meta.reel)) {
            issues.push({ level: 'error', field: 'reel', message: 'meta.reel must be an object of profile overrides (spotlight, ripple, subtitles, loop, autoplay)' });
        } else {
            for (const key of ['spotlight', 'ripple', 'subtitles', 'loop'] as const) {
                const v = (meta.reel as ReelOptions)[key];
                if (v !== undefined && typeof v !== 'boolean') issues.push({ level: 'error', field: 'reel', message: `meta.reel.${key} must be true or false (got ${JSON.stringify(v)})` });
            }
            const autoplay = (meta.reel as ReelOptions).autoplay;
            if (autoplay !== undefined && !AUTOPLAY_MODES.includes(autoplay)) {
                issues.push({ level: 'error', field: 'reel', message: `meta.reel.autoplay must be ${AUTOPLAY_MODES.map(a => `"${a}"`).join(', ')} (got ${JSON.stringify(autoplay)})` });
            }
            const poster = (meta.reel as ReelOptions).poster;
            if (poster !== undefined && poster !== 'last' && poster !== 'first') {
                const at = parseTime(poster as string | number);
                if (!Number.isFinite(at) || at < 0) {
                    issues.push({ level: 'error', field: 'reel', message: `meta.reel.poster must be "last", "first", or a time such as "3.2s" (got ${JSON.stringify(poster)})` });
                } else {
                    // Clamping silently would hand back the last frame while the config claims otherwise.
                    const clipMs = computeDurationMs(timeline);
                    if (at > clipMs) issues.push({ level: 'error', field: 'reel', message: `meta.reel.poster ${JSON.stringify(poster)} is past the end of the clip (${(clipMs / 1000).toFixed(2)}s)` });
                }
            }
            for (const key of Object.keys(meta.reel)) {
                if (!['spotlight', 'ripple', 'subtitles', 'loop', 'autoplay', 'poster'].includes(key)) issues.push({ level: 'warning', field: 'reel', message: `meta.reel: unknown key "${key}" ignored` });
            }
        }
    }
    // A reel is not a help document: the guide-shaped checks below do not apply to it.
    const reel = isReel(timeline);
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
            if (s.action === 'navigate') {
                if (typeof s.url !== 'string' || !s.url) issues.push(issueFor(s, 'error', 'action "navigate" requires a "url"', 'url'));
                else if (!opts.live) issues.push(issueFor(s, 'warning', 'action "navigate" only runs under `record` (live pages); build/export/preview ignore it', 'action'));
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
        if (s.captureAt !== undefined && s.captureAt !== 'interaction' && s.captureAt !== 'completion') {
            issues.push(issueFor(s, 'error', '"captureAt" must be "interaction" or "completion"', 'captureAt'));
        }
        if (s.waitFor !== undefined && typeof s.waitFor !== 'string' && typeof s.waitFor !== 'number') {
            issues.push(issueFor(s, 'error', '"waitFor" must be a selector string or a number of milliseconds', 'waitFor'));
        }
        if (s.waitForTimeoutMs !== undefined && (typeof s.waitForTimeoutMs !== 'number' || !(s.waitForTimeoutMs > 0))) {
            issues.push(issueFor(s, 'error', '"waitForTimeoutMs" must be a positive number of milliseconds', 'waitForTimeoutMs'));
        } else if (s.waitForTimeoutMs !== undefined && typeof s.waitFor !== 'string') {
            issues.push(issueFor(s, 'warning', '"waitForTimeoutMs" only applies to a "waitFor" selector', 'waitForTimeoutMs'));
        }
        // A numbered step in a help document needs a heading; the English fallback verbs ("Click .btn")
        // would leak into a localized guide.
        if (!reel && isGuideStep(s) && (typeof s.title !== 'string' || !s.title.trim())) {
            issues.push(issueFor(s, opts.guide ? 'error' : 'warning', `guide step has no "title" (a numbered step in the help guide needs a heading; set "guide": false to hide choreography steps)`, 'title'));
        }
        // `animate`: the shape of the motion. A malformed from/to would silently animate nothing.
        if (s.action === 'animate') {
            for (const field of ['from', 'to'] as const) {
                const v = s[field];
                if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
                    issues.push(issueFor(s, 'error', `"${field}" must be an object of properties (opacity, x, y, scale, scaleX, scaleY, rotate, or any CSS property)`, field));
                }
            }
            if (s.from === undefined && s.to === undefined) {
                issues.push(issueFor(s, 'warning', '"animate" has neither "from" nor "to": the step will do nothing', 'action'));
            }
            if (s.all !== undefined && typeof s.all !== 'boolean') issues.push(issueFor(s, 'error', '"all" must be true or false', 'all'));
            if (s.stagger !== undefined && (typeof s.stagger !== 'number' || s.stagger < 0)) issues.push(issueFor(s, 'error', '"stagger" must be a number of seconds (>= 0)', 'stagger'));
            if (s.stagger !== undefined && !s.all) issues.push(issueFor(s, 'warning', '"stagger" only applies with "all": true (one element has nothing to stagger against)', 'stagger'));
            if (s.count !== undefined && (typeof s.count !== 'number' || !Number.isInteger(s.count) || s.count < 1)) {
                issues.push(issueFor(s, 'error', '"count" must be a whole number of elements (>= 1)', 'count'));
            }
        } else if (s.from !== undefined || s.to !== undefined || s.all !== undefined || s.stagger !== undefined) {
            issues.push(issueFor(s, 'warning', `"from"/"to"/"all"/"stagger" only apply to an "animate" step (this one is "${s.action}")`, 'action'));
        }
        if (s.ease !== undefined) {
            if (typeof s.ease !== 'string' || !EASING_NAMES.includes(s.ease as EasingName)) {
                issues.push(issueFor(s, 'error', `unknown easing ${JSON.stringify(s.ease)}; use one of ${EASING_NAMES.join(', ')}`, 'ease'));
            } else if (s.action !== 'animate' && s.action !== 'camera') {
                issues.push(issueFor(s, 'warning', `"ease" only applies to "animate" and "camera" steps (this one is "${s.action}")`, 'ease'));
            }
        }
        // Per-device fields are resolved in loadTimeline; a bad value would silently keep or drop a step.
        if (s.only !== undefined && !DEVICE_KINDS.includes(s.only as DeviceKind)) {
            issues.push(issueFor(s, 'error', `"only" must be ${DEVICE_KINDS.map(d => `"${d}"`).join(' or ')} (got ${JSON.stringify(s.only)})`, 'only'));
        }
        for (const device of DEVICE_KINDS) {
            const v = s[device];
            if (v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v))) {
                issues.push(issueFor(s, 'error', `"${device}" must be an object of per-device overrides`, device));
            }
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

    // Guide length: the guide is one flat scroll of full-width frames, one per numbered step.
    const numbered = steps.filter(isGuideStep).length;
    if (!reel && numbered > GUIDE_STEPS_WARN_ABOVE) {
        issues.push({ level: 'warning', field: 'guide', message: `${numbered} numbered guide steps: a guide this long is usually two guides; "guide": false hides choreography steps such as camera/wait from the numbering` });
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
    const level = issue.level === 'error' ? 'error  ' : issue.level === 'info' ? 'info   ' : 'warning';
    if (issue.step === undefined) return `${level}  ${issue.message}`;
    const where = [issue.time !== undefined ? formatTime(parseTime(issue.time)) : null, issue.action, issue.target]
        .filter(Boolean).join(' ');
    return `${level}  step ${issue.step}${where ? ` (${where})` : ''}: ${issue.message}`;
}
