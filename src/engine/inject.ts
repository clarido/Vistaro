import * as fs from 'fs';
import * as path from 'path';
import { Timeline, computeDurationMs, reelOptions, AutoplayMode, DEFAULT_CPS } from './schema';

/** Absolute path of the plain-JS browser runtime, read from disk and injected as text. */
export const RUNTIME_PATH = path.join(__dirname, 'runtime.js');
/** Absolute path of the tour scheduler injected beside the runtime for a tour scenario page. */
export const TOUR_BRIDGE_PATH = path.join(__dirname, 'tour-bridge.js');

let cachedRuntime: string | undefined;
let cachedBridge: string | undefined;

/** Source of src/engine/runtime.js (cached after first read). */
export function runtimeSource(): string {
    if (cachedRuntime === undefined) cachedRuntime = fs.readFileSync(RUNTIME_PATH, 'utf8');
    return cachedRuntime;
}

/** Source of src/engine/tour-bridge.js (cached after first read). */
export function tourBridgeSource(): string {
    if (cachedBridge === undefined) cachedBridge = fs.readFileSync(TOUR_BRIDGE_PATH, 'utf8');
    return cachedBridge;
}

export type CursorStyle = 'mac' | 'windows' | 'none';

export interface InjectOptions {
    /** CLI cursor override; falls back to meta.cursor, then 'mac'. */
    cursor?: CursorStyle | string;
    loop?: boolean;
    drift?: boolean;
    resetFocusStyles?: boolean;
    /** Root zoom for a scaled recording (see ViewportOptions.scale); 1 leaves the page alone. */
    zoom?: number;
    /** Profile chrome overrides; each falls back to what meta.kind / meta.reel resolve to. */
    spotlight?: boolean;
    ripple?: boolean;
    subtitles?: boolean;
    autoplay?: AutoplayMode;
    /** Override the computed playback length (used for the loop reload). */
    durationMs?: number;
}

export interface BootOptions {
    cursor: CursorStyle;
    loop: boolean;
    drift: boolean;
    resetFocusStyles: boolean;
    /** Chrome: the runtime's own primitives early-return when these are off. */
    spotlight: boolean;
    ripple: boolean;
    subtitles: boolean;
    /** Carried for a later phase; the runtime stores it without acting on it yet. */
    autoplay: AutoplayMode;
    /**
     * `:root { zoom: N }`, emitted with the rest of the runtime CSS so it is in place before first
     * paint. Pairs with an N-times-larger viewport to record at N pixels per CSS pixel.
     */
    zoom: number;
    durationMs: number;
    /** Typing speed used when a `type` step has no `cps` (schema DEFAULT_CPS). */
    defaultCps: number;
    timeline?: { meta: Record<string, any>; steps: any[] };
    cursorPoint?: { x: number; y: number } | null;
}

function normalizeCursor(c: unknown): CursorStyle {
    return c === 'windows' || c === 'none' ? c : 'mac';
}

/** Resolve the options handed to `__anim.boot` from timeline meta + CLI overrides. */
export function bootOptions(timeline: Timeline, opts: InjectOptions = {}, withTimeline = true): BootOptions {
    const meta = timeline.meta || {};
    // The profile resolves the chrome; a CLI override still wins over it.
    const reel = reelOptions(timeline);
    const boot: BootOptions = {
        cursor: normalizeCursor(opts.cursor ?? meta.cursor ?? 'mac'),
        loop: opts.loop ?? reel.loop,
        drift: opts.drift ?? (meta.drift !== undefined ? !!meta.drift : true),
        resetFocusStyles: opts.resetFocusStyles ?? !!meta.resetFocusStyles,
        spotlight: opts.spotlight ?? reel.spotlight,
        ripple: opts.ripple ?? reel.ripple,
        subtitles: opts.subtitles ?? reel.subtitles,
        autoplay: opts.autoplay ?? reel.autoplay,
        zoom: opts.zoom && opts.zoom > 0 ? opts.zoom : 1,
        durationMs: opts.durationMs ?? computeDurationMs(timeline),
        defaultCps: DEFAULT_CPS,
    };
    if (withTimeline) boot.timeline = { meta: { title: meta.title, slug: meta.slug, locale: meta.locale }, steps: timeline.steps };
    return boot;
}

/** JSON safe to embed inside a <script> element. */
export function scriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const START = '<!-- anim-cli-runtime:start -->';
const END = '<!-- anim-cli-runtime:end -->';

/** Remove a previously injected runtime block so build is idempotent on its own output. */
export function stripRuntime(html: string): string {
    const s = html.indexOf(START);
    const e = html.indexOf(END);
    if (s === -1 || e === -1 || e < s) return html;
    return html.slice(0, s) + html.slice(e + END.length);
}

/**
 * Inline the runtime plus a `__anim.boot({...})` call before </body>.
 * The page self-plays when opened directly; a Playwright driver sets
 * `window.__ANIM_DRIVEN = true` before load to keep the in-page scheduler off.
 */
export function buildAnimatedHtml(html: string, timeline: Timeline, opts: InjectOptions = {}): string {
    const boot = bootOptions(timeline, opts, true);
    const block = `\n${START}\n<script>\n${runtimeSource()}\nwindow.__anim.boot(${scriptJson(boot)});\n</script>\n${END}\n`;
    let out = stripRuntime(html);
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${block}</body>`);
    else out += block;
    return out;
}

/**
 * A scenario page for the tour shell: the same mockup, the same runtime, plus the message-driven
 * scheduler. Three things differ from `build`:
 *   - `autoplay: 'message'` so the page never starts on its own (the shell owns playback);
 *   - `subtitles: false` because the shell draws the caption in its own chrome, where it can be
 *     selected, translated by the browser, and read by a screen reader;
 *   - `loop: false` -- looping is the shell's call, made after the last step reports in.
 * The timeline travels with the page so the scheduler can replay any prefix of it instantly.
 */
export function buildTourPage(html: string, timeline: Timeline, opts: InjectOptions = {}): string {
    const boot = bootOptions(timeline, {
        ...opts,
        subtitles: false,
        autoplay: 'message',
        loop: false,
        // Drift scales <body> to 1.025 from a centred origin, which overhangs the viewport by 1.25%
        // per edge (16px at 1280). In a fullscreen video that overhang is merely off-screen; inside a
        // tour canvas it is CROPPED by the frame, so a full-bleed panel loses 16px of itself and its
        // spotlight ring with it. Same reason live pages default it off. An author still opts in.
        drift: opts.drift ?? (timeline.meta.drift !== undefined ? !!timeline.meta.drift : false),
    }, true);
    const payload = { meta: { tailMs: timeline.meta?.tailMs }, steps: timeline.steps };
    const block = `\n${START}\n<script>\n${runtimeSource()}\n${tourBridgeSource()}\n`
        + `window.__anim.boot(${scriptJson(boot)});\nwindow.__tour.boot(${scriptJson(payload)});\n</script>\n${END}\n`;
    let out = stripRuntime(html);
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${block}</body>`);
    else out += block;
    return out;
}
