import * as fs from 'fs';
import * as path from 'path';
import { readManifest } from '../manifest';
import { applyStrings, readStrings, resolveLocale, stringsPath, stringsPathFor, isLocaleCode } from './strings';

/**
 * Timeline schema: parsing, normalization and validation of vistaro.config.json.
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
/** Where a cue's chip may sit; mirrored as SUB_PLACES in src/engine/runtime.js (test/constants.test.ts asserts equality). */
export const SUBTITLE_PLACES: readonly string[] = ['bottom', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right'];
/** Cursor styles `meta.cursor` (and `--cursor`) accept. */
export const CURSOR_STYLES: readonly string[] = ['mac', 'windows', 'none'];

// --- Motion tokens (meta.motion) ------------------------------------------------------------------
// Named durations a timeline sets once instead of per step. An action with no `duration` reads the
// token MOTION_TOKEN_FOR_ACTION maps it to -- but only when meta.motion actually sets that token:
// unset, every action keeps today's per-action default, so a timeline without meta.motion renders
// exactly as before. A step may also name a token (`"duration": "fast"`); that reference resolves
// to meta.motion's value, else to DEFAULT_MOTION_S. Resolved at parse time (resolveMotion), so the
// runtime, the length estimate and every scheduler see plain seconds.
export const MOTION_TOKENS = ['fast', 'base', 'slow'] as const;
export type MotionToken = typeof MOTION_TOKENS[number];
/** What a token reference means when meta.motion does not set it (seconds). UI-motion norms: 200 ms / 400 ms / a deliberate 1.2 s camera move. */
export const DEFAULT_MOTION_S: Record<MotionToken, number> = { fast: 0.2, base: 0.4, slow: 1.2 };
/** Which token an action without `duration` reads, when meta.motion sets it. */
export const MOTION_TOKEN_FOR_ACTION: Readonly<Record<string, MotionToken>> = { animate: 'base', fadeIn: 'base', transitionScreen: 'base', camera: 'slow' };
/** Keys meta.motion accepts: the three durations plus the default easings. */
export const MOTION_KEYS = [...MOTION_TOKENS, 'ease', 'cameraEase'] as const;

export interface MotionTokens {
    fast?: number;
    base?: number;
    slow?: number;
    /** Default easing for `animate` and `camera` steps that name none. */
    ease?: EasingName;
    /** Default easing for `camera` alone (wins over `ease` there): a camera move usually wants an in-out curve. */
    cameraEase?: EasingName;
}

function validSeconds(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Apply meta.motion to the steps, in place and idempotently (applyDevice calls it again after a
 * per-device block may have brought in a token reference): a token-name `duration` becomes seconds,
 * and an action with no `duration`/`ease` takes the token meta.motion sets for it. Invalid token
 * values are left for validateTimeline to report and are never copied onto a step.
 */
export function resolveMotion(timeline: Timeline): void {
    const m: unknown = timeline.meta?.motion;
    const motion: Record<string, unknown> = m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : {};
    const tokenValue = (t: MotionToken): number | undefined => (validSeconds(motion[t]) ? motion[t] as number : undefined);
    const easeOk = (e: unknown): e is EasingName => typeof e === 'string' && (EASING_NAMES as readonly string[]).includes(e);
    for (const s of timeline.steps) {
        if (typeof s.duration === 'string' && (MOTION_TOKENS as readonly string[]).includes(s.duration)) {
            const t = s.duration as MotionToken;
            s.durationToken = t;
            s.duration = tokenValue(t) ?? DEFAULT_MOTION_S[t];
        } else if (s.duration === undefined && typeof s.action === 'string' && MOTION_TOKEN_FOR_ACTION[s.action]) {
            const t = MOTION_TOKEN_FOR_ACTION[s.action];
            const v = tokenValue(t);
            if (v !== undefined) { s.duration = v; s.durationToken = t; }
        }
        if (s.ease === undefined && (s.action === 'animate' || s.action === 'camera')) {
            const e = s.action === 'camera' && easeOk(motion.cameraEase) ? motion.cameraEase : motion.ease;
            if (easeOk(e)) s.ease = e;
        }
    }
}

// --- Brand kit (meta.brand) ---------------------------------------------------------------------
// The colours and furniture a video wears. Values go into CSS verbatim (as the tour theme does), so
// contrast is the author's call -- check measures it and warns below 4.5:1. `meta.brand` may also be
// a path to a shared JSON file (relative to the timeline file) holding the same object, so a team
// sets its brand once; loadTimeline reads it in place. Unset, nothing about the chrome changes.
export const BRAND_KEYS = ['accent', 'caption', 'cursor', 'logo', 'intro', 'outro'] as const;
export const BRAND_CAPTION_KEYS = ['font', 'color', 'background', 'radius'] as const;
export const BRAND_LOGO_KEYS = ['src', 'place', 'height'] as const;
export const BRAND_CARD_KEYS = ['title', 'subtitle', 'duration', 'background', 'color'] as const;
/** Corners a logo may sit in. */
export const LOGO_PLACES: readonly string[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const DEFAULT_INTRO_S = 2;
export const DEFAULT_OUTRO_S = 2.5;
/** Defaults the contrast check assumes for the parts a brand leaves unset (the runtime's own glass chip and card). */
export const DEFAULT_CAPTION_COLORS = { color: '#ffffff', background: 'rgba(20,20,20,0.75)' };
export const DEFAULT_CARD_COLORS = { color: '#ffffff', background: '#0f172a' };
export const MIN_CONTRAST = 4.5;

export interface BrandCard { title?: string; subtitle?: string; duration?: number; background?: string; color?: string }
export interface BrandKit {
    accent?: string;
    caption?: { font?: string; color?: string; background?: string; radius?: string | number };
    cursor?: string;
    logo?: string | { src?: string; place?: string; height?: number };
    intro?: BrandCard;
    outro?: BrandCard;
}

/** The brand object when meta.brand is one (after loadTimeline resolved a file path), else undefined. */
export function brandOf(timeline: Timeline): BrandKit | undefined {
    const b = timeline.meta?.brand;
    return b && typeof b === 'object' && !Array.isArray(b) ? b as BrandKit : undefined;
}

/** Seconds an intro/outro card holds, or 0 when the brand has none. */
export function cardDurationMs(card: unknown, fallbackS: number): number {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return 0;
    const d = (card as BrandCard).duration;
    return Math.round((validSeconds(d) && d > 0 ? d : fallbackS) * 1000);
}
export function introMs(timeline: Timeline): number { return cardDurationMs(brandOf(timeline)?.intro, DEFAULT_INTRO_S); }
export function outroMs(timeline: Timeline): number { return cardDurationMs(brandOf(timeline)?.outro, DEFAULT_OUTRO_S); }

/**
 * Read a `meta.brand` that names a file: relative to the timeline file, JSON holding the brand
 * object. Replaces the string with the object and records the absolute path on the timeline
 * (`brandFile`), which build-all hashes so editing the shared brand rebuilds every guide using it.
 */
export function loadBrandFile(timeline: Timeline, configFile: string): void {
    const ref = timeline.meta?.brand;
    if (typeof ref !== 'string') return;
    const file = path.resolve(path.dirname(configFile), ref);
    if (!fs.existsSync(file)) throw new Error(`${configFile}: meta.brand names ${ref}, which does not exist (${file})`);
    let brand: unknown;
    try { brand = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: invalid JSON in the brand file (${e.message})`); }
    if (!brand || typeof brand !== 'object' || Array.isArray(brand)) throw new Error(`${file}: a brand file must hold one object of brand tokens (${BRAND_KEYS.join(', ')})`);
    timeline.meta.brand = brand;
    timeline.brandFile = file;
}

// Contrast (WCAG 2.x relative luminance). Parses the colour forms a brand realistically uses --
// #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and a few names -- and returns null for anything
// else (a var(), a gradient), in which case the check stays quiet rather than guess.
const NAMED_COLORS: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], transparent: [0, 0, 0] };
export function parseCssColor(v: unknown): { r: number; g: number; b: number; a: number } | null {
    if (typeof v !== 'string') return null;
    const s = v.trim().toLowerCase();
    if (NAMED_COLORS[s]) { const [r, g, b] = NAMED_COLORS[s]; return { r, g, b, a: s === 'transparent' ? 0 : 1 }; }
    let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) {
        let h = m[1];
        if (h.length <= 4) h = h.split('').map(c => c + c).join('');
        const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
        return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
    if (m) {
        const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return { r: +m[1], g: +m[2], b: +m[3], a: Math.max(0, Math.min(1, alpha)) };
    }
    return null;
}
function luminance(c: { r: number; g: number; b: number }): number {
    const ch = (x: number) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
/**
 * Contrast ratio of `fg` text on `bg`. A translucent background is composited over BOTH black and
 * white and the worse ratio is returned: the chip floats over arbitrary page content, so its real
 * backdrop is unknown. null when either colour cannot be parsed.
 */
export function contrastRatio(fg: unknown, bg: unknown): number | null {
    const f = parseCssColor(fg), b = parseCssColor(bg);
    if (!f || !b) return null;
    const over = (base: number) => ({ r: b.r * b.a + base * (1 - b.a), g: b.g * b.a + base * (1 - b.a), b: b.b * b.a + base * (1 - b.a) });
    const ratio = (bgc: { r: number; g: number; b: number }) => { const l1 = luminance(f), l2 = luminance(bgc); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const backs = b.a >= 1 ? [b] : [over(0), over(255)];
    return Math.round(Math.min(...backs.map(ratio)) * 100) / 100;
}

// --- Capability registry ------------------------------------------------------------------------
// The one place an action, a step field, a meta field or an easing is DESCRIBED. The tables in
// AGENTS.md (between the capabilities markers) and `capabilities --json` are both rendered from
// here by src/commands/capabilities.ts, so the manual and the command cannot disagree, and
// test/capabilities.test.ts fails when a member of ACTIONS / EASING_NAMES has no entry. Lists that
// the schema already holds (the target-required actions, the easings, the placements) are spelled
// from those constants, never retyped.

/** One documented field: `names` share the row (e.g. `from` / `to`). */
export interface FieldDoc {
    names: readonly string[];
    description: string;
}

/** What an action does, and the human rule for when its guide frame is taken (see captureAtFor). */
export interface ActionDoc {
    description: string;
    guideFrame: string;
}

const codeList = (xs: readonly string[]) => xs.map(x => `\`${x}\``).join(', ');
/** `a`, `b` or `c` */
const orList = (xs: readonly string[]) => xs.length < 2 ? codeList(xs) : `${codeList(xs.slice(0, -1))} or \`${xs[xs.length - 1]}\``;

export const ACTION_DOCS: Record<Action, ActionDoc> = {
    click: { description: 'Cursor travels, spotlight, press, ripple, real `el.click()` so the page\'s own handlers run.', guideFrame: 'At the interaction (+300 ms settle), spotlight held; a click that hides its own target (a screen swap, a navigation) is captured just before the click instead, and records `capturedAt: "arrival"`.' },
    focus: { description: 'Cursor travels, spotlight, `el.focus()`.', guideFrame: 'Interaction.' },
    type: { description: 'Cursor travels, focuses, types `value` character by character. Under `check`/`preview`/`export`/`record`/`guide` the driver types inputs, textareas and contenteditable through the real keyboard (`page.keyboard`), so the app\'s own key handlers and framework value trackers (React\'s controlled inputs) see genuine events; plain elements with a caret, and a self-playing `animated.html`, are typed by the page itself through the native value setter.', guideFrame: 'Completion (full text visible).' },
    highlight: { description: 'Spotlight pulse without a click ("notice this").', guideFrame: 'Interaction.' },
    hover: { description: 'Cursor moves onto the element.', guideFrame: 'Interaction.' },
    press: { description: 'Keyboard key from `value` (no target).', guideFrame: 'Interaction.' },
    camera: { description: 'Pan/zoom the page toward the target (or `x`/`y`); `scale: 1` pulls back. The cursor and the spotlight ride along, staying on the element they were on.', guideFrame: 'Completion (zoomed framing).' },
    scroll: { description: 'Smooth-scroll the target into view.', guideFrame: 'Completion.' },
    fadeIn: { description: 'Reveal the target (display/opacity) with a fade.', guideFrame: 'Completion.' },
    transitionScreen: { description: 'Fade the current screen out and the target screen in.', guideFrame: 'Completion.' },
    navigate: { description: 'Live pages only: open `url`.', guideFrame: 'Arrival on the new page.' },
    animate: { description: 'Animate `target` from `from` to `to` with the Web Animations API (`fill: both`, so the end state persists). With `all` it runs on every match, `stagger` seconds apart.', guideFrame: 'Completion (all elements settled).' },
    wait: { description: 'Nothing visible; a beat, or a subtitle change.', guideFrame: 'Interaction (the moment of the step).' },
};

/** Order of the rows in the actions table (the order an author meets them, not ACTIONS' order). */
export const ACTION_DOC_ORDER: readonly Action[] = ['click', 'focus', 'type', 'highlight', 'hover', 'press', 'camera', 'scroll', 'fadeIn', 'transitionScreen', 'navigate', 'animate', 'wait'];

export const EASING_DOCS: Record<EasingName, string> = {
    linear: 'Constant speed. Mechanical; for progress bars and counters, rarely for UI.',
    easeInCubic: 'Starts slow, leaves fast. For exits: an element accelerating off screen.',
    easeOutCubic: 'Arrives fast, settles slow. The default for `animate`; for entrances.',
    easeInOutCubic: 'Slow, fast, slow. The camera\'s default; for moves between two resting states.',
    easeOutBack: 'Overshoots slightly, then settles. For a pop-in that should feel tactile.',
    easeOutExpo: 'Very fast arrival, long settle. For a confident reveal.',
    spring: 'A springy overshoot, stronger than `easeOutBack`. Use sparingly.',
};

export const META_FIELD_DOCS: readonly FieldDoc[] = [
    { names: ['title'], description: 'Guide title (H1 of `guide.md`, `<title>` of `guide.html`, `meta.title` string key).' },
    { names: ['slug'], description: 'Identifier used in `guide.json`; defaults to the directory name.' },
    { names: ['app'], description: 'Application name shown in the guide.' },
    { names: ['url'], description: 'Default page for `record` (live pages).' },
    { names: ['locale'], description: 'Language of the inline text (default `en`).' },
    { names: ['tailMs'], description: 'Hold after the last step, default 2500 (`--tail` overrides).' },
    { names: ['subtitleScale'], description: 'Multiplier on the automatic subtitle chip size (font and wrap width), default `1`; `1.4` makes it 40% bigger. The chip is sized to the recorded frame (~4% of its height) and repositioned out of the way of the cursor and the spotlight automatically, so there is nothing to author here unless the design wants it louder or quieter.' },
    { names: ['cursor'], description: `${orList(CURSOR_STYLES)} (default \`mac\`).` },
    { names: ['resetFocusStyles'], description: 'Before each step, reset every `.input` and `button` in the page to fixed light colours (border `#E2E8F0`, no shadow, `#FAFAFA` background, `#3B82F6` for `.btn-primary`): a crutch for mockups built with those classes, not a general focus-outline reset.' },
    { names: ['drift'], description: 'Slight page drift while the cursor glides (default on for mockups; off on live pages, where a transformed `<body>` can break a real app\'s fixed layout, unless `"drift": true`).' },
    { names: ['voice'], description: '`{ "openai": "alloy", "say": "Samantha" }` narration voices per engine.' },
    { names: ['kind'], description: '`guide` (default) or `reel`. A reel is a silent marketing clip: no spotlight, ripple or subtitle bar, no guide-shaped validation, and `--guide` on it is an error.' },
    { names: ['reel'], description: 'Overrides of whatever `kind` implies: `spotlight`, `ripple`, `subtitles`, `loop` (booleans), `autoplay` (`immediate`, `inview`, `message`), `poster` (`last` (default), `first`, or a time such as `"3.2s"`). An explicit value always beats the profile default.' },
    { names: ['motion'], description: `Named durations and default easings, set once instead of per step: ${MOTION_TOKENS.map(t => `\`${t}\``).join(', ')} (seconds), \`ease\` (default easing for \`animate\` and \`camera\`) and \`cameraEase\` (wins for \`camera\`). An action with no \`duration\` reads its token when this object sets it -- ${Object.entries(MOTION_TOKEN_FOR_ACTION).map(([a, t]) => `\`${a}\` → \`${t}\``).join(', ')} -- and keeps its built-in default otherwise, so a timeline without \`motion\` renders exactly as before. A step may also name a token: \`"duration": "fast"\` (unset tokens mean ${MOTION_TOKENS.map(t => `${t} ${DEFAULT_MOTION_S[t]} s`).join(', ')}). See the motion tokens table below.` },
    { names: ['brand'], description: 'The brand kit the video wears: `accent` (spotlight, ripple, step badge), `caption` (`font`, `color`, `background`, `radius`), `cursor` (pointer fill), `logo` (an image path relative to `index.html`, or `{ src, place, height }`), `intro` / `outro` cards (`title`, `subtitle`, `duration`, `background`, `color`). Or a path, relative to the timeline, to a shared JSON brand file holding the same object. Values go into CSS verbatim; `check` warns on an unknown token and on caption or card text below 4.5:1 contrast. See the brand tokens table below.' },
    { names: ['reset'], description: 'Live pages: a shell command run before each pass over the app (the recording, then the `--guide` replay), e.g. `"npm run db:seed"` or `"curl -X POST http://localhost:3000/api/test/reset"`. It runs in the shell, in the CLI\'s working directory, so a timeline is executable content: it runs only when you pass `--allow-reset`, and the command refuses rather than silently skipping a reset the timeline depends on. `--reset-cmd` gives your own command instead and never needs the flag. See [Live pages](#live-pages).' },
];

export const STEP_FIELD_DOCS: readonly FieldDoc[] = [
    { names: ['id'], description: 'Stable identifier. Strings files and guide frames attach to it; auto ids (`step-03`) shift when a step is inserted, so `check`/`localize` warn about them once a strings file exists.' },
    { names: ['time'], description: `**Moment of the interaction** (the click, the first typed character, the highlight pulse): \`"2s"\`, \`"2000ms"\` or a number of seconds. The cursor starts travelling up to ${DEFAULT_LEAD_MS} ms earlier (lead = min(${DEFAULT_LEAD_MS} ms, gap to the previous step, time)). Steps must be in order.` },
    { names: ['action'], description: 'See the actions table below.' },
    { names: ['target'], description: `CSS selector. Required for ${ACTIONS.filter(a => TARGET_REQUIRED.has(a)).join(', ')}. A 0x0 target (an empty caret span) is spotlighted through its sized ancestor.` },
    { names: ['value'], description: `Text for \`type\` (typed at \`cps\` characters per second, default ${DEFAULT_CPS}) or the key for \`press\` (\`Enter\`, \`Tab\`, \`Control+K\`).` },
    { names: ['cps'], description: `\`type\`: characters per second (default ${DEFAULT_CPS}).` },
    { names: ['title'], description: 'Step heading in the guide and the chapter name in the MP4. Every numbered guide step needs one: `check` warns, and `guide` / `export --guide` / `record --guide` refuse without it (the fallback verbs are English and would leak into a localized guide). Hide choreography steps with `"guide": false` instead.' },
    { names: ['subtitle'], description: `Shown in the video's subtitle bar from \`time\` until the next subtitle (held at most ${SUBTITLE_HOLD_MS / 1000} s, at least ${SUBTITLE_MIN_MS / 1000} s) and written to the \`.vtt\`; also the narration text when \`narration\` is absent. \`null\` clears the bar. Nothing to author about placement: the bar moves itself out of the way of the target, the cursor and the content a camera push framed.` },
    { names: ['subtitlePlace'], description: `Pins this step's cue to one placement (${codeList(SUBTITLE_PLACES)}), taking it out of the automatic dodge for as long as the cue runs -- for a composition the author knows, like a camera push framing low content. \`check\` still warns when a pinned cue covers something.` },
    { names: ['narration'], description: 'Text spoken at `time` with `--narration` (mixed into the MP4).' },
    { names: ['note'], description: 'Extra sentence under the step in the guide.' },
    { names: ['translatable'], description: '`true` when `value` is user-visible text that must be translated (it becomes a string key).' },
    { names: ['crop'], description: 'Guide crop padding in px for this step, or `false` for the full frame only.' },
    { names: ['from', 'to'], description: '`animate`: the start and end state. `x`, `y` (px), `scale`, `scaleX`, `scaleY`, `rotate` (deg) compose into one transform, applied in the order translate, scale, rotate; every other key (`opacity`, any CSS property) is passed through as-is.' },
    { names: ['all'], description: '`animate`: animate every match of `target`, not just the first.' },
    { names: ['stagger'], description: '`animate`: seconds between successive elements when `all` is set.' },
    { names: ['count'], description: '`animate`: how many elements `target` is expected to match, so the length estimate is right. `check` warns when the real count differs.' },
    { names: ['ease'], description: `Named easing for \`animate\` and \`camera\`: ${codeList(EASING_NAMES)} (see the easings table below).` },
    { names: ['spotlight', 'ripple'], description: '`false` suppresses that chrome for this step alone (no ring is shown at all, not merely left where it was).' },
    { names: ['only'], description: `${DEVICE_KINDS.map(d => `\`"${d}"\``).join(' or ')}: the step is dropped entirely for the other device.` },
    { names: ['mobile', 'desktop'], description: 'An object shallow-merged into the step when rendering for that device; the key itself is then stripped. Fields the override omits are inherited.' },
    { names: ['guide'], description: '`false` hides the step from the guide (it still runs in the video).' },
    { names: ['captureAt'], description: 'Override the guide/preview frame moment: `"interaction"` or `"completion"`. On a `type` step driven from the CLI both show the full text: the driver types through the keyboard and the step\'s interaction is only over once the last character has landed.' },
    { names: ['waitFor'], description: 'Live pages: a selector to wait for (visible) or a number of ms before the cursor moves; the delay shifts the rest of the timeline.' },
    { names: ['waitForTimeoutMs'], description: 'Live pages: how long a `waitFor` selector may wait before giving up (default 15000). A timeout is reported as a warning naming the step, not as a slow load; `record --fail-fast` abandons the recording at the first one.' },
    { names: ['url'], description: '`navigate` (live pages): the page to open.' },
    { names: ['scale', 'x', 'y', 'xOffset', 'yOffset'], description: '`camera`: zoom factor (default 1, a pan without zoom; 1.3 is a typical push-in) and framing; `x`/`y` centre the camera on a point instead of a target, `xOffset`/`yOffset` nudge the framing after that centre is solved (positive moves the focus right/down, so the window travels with it -- the same sign convention as the cursor-point offsets of the same name). On cursor actions `xOffset`/`yOffset` nudge the cursor point off the target\'s centre.' },
    { names: ['duration'], description: `Seconds. \`camera\`: length of the pan (default ${DEFAULT_CAMERA_DURATION_S}). \`animate\`: length of one element's motion (default ${DEFAULT_ANIMATE_DURATION_S}). \`fadeIn\`/\`transitionScreen\`: length of the fade (default: the element's own CSS transition, else ${DEFAULT_FADE_MS / 1000} s).` },
];

/** One row per meta.motion key. */
export const MOTION_TOKEN_DOCS: readonly FieldDoc[] = [
    { names: ['fast'], description: `Seconds; a reference name a step can use (\`"duration": "fast"\`). Unset: ${DEFAULT_MOTION_S.fast} s.` },
    { names: ['base'], description: `Seconds; the default length of ${Object.entries(MOTION_TOKEN_FOR_ACTION).filter(([, t]) => t === 'base').map(([a]) => `\`${a}\``).join(', ')} when set. Unset: those actions keep their own defaults; a \`"base"\` reference means ${DEFAULT_MOTION_S.base} s.` },
    { names: ['slow'], description: `Seconds; the default length of ${Object.entries(MOTION_TOKEN_FOR_ACTION).filter(([, t]) => t === 'slow').map(([a]) => `\`${a}\``).join(', ')} when set. Unset: ${DEFAULT_CAMERA_DURATION_S} s for a camera; a \`"slow"\` reference means ${DEFAULT_MOTION_S.slow} s.` },
    { names: ['ease'], description: 'Default easing for `animate` and `camera` steps that name none (see the easings table).' },
    { names: ['cameraEase'], description: 'Default easing for `camera` alone, winning over `ease` there: a camera move usually wants an in-out curve while entrances want an ease-out.' },
];

/** One row per meta.brand key. */
export const BRAND_TOKEN_DOCS: readonly FieldDoc[] = [
    { names: ['accent'], description: 'Colour of the spotlight ring (border and glow), the click ripple and the guide\'s numbered badge. Applied as inline styles, so any CSS colour works.' },
    { names: ['caption'], description: `Subtitle chip overrides: ${codeList(BRAND_CAPTION_KEYS)} (\`radius\` in px or any CSS length). Wins over both chip styles (the guide's glass pill and the reel's stadium bar); a \`background\` also drops the glass blur.` },
    { names: ['cursor'], description: 'Fill colour of the pointer sprite (`mac` or `windows`).' },
    { names: ['logo'], description: `A small image held in a corner during playback: a path relative to \`index.html\` (or a URL), or \`{ src, place, height }\` with \`place\` one of ${codeList(LOGO_PLACES)} (default \`top-right\`) and \`height\` in px (default 36). The subtitle chip dodges it; guide frames hide it. Also shown on the intro/outro cards.` },
    { names: ['intro'], description: `A full-frame title card the video opens on: \`title\` (required), \`subtitle\`, \`duration\` (seconds, default ${DEFAULT_INTRO_S}), \`background\`, \`color\`. It covers the page, so start the first step after it (\`check\` warns per step). Shown by \`export\`/\`record\` and a self-playing page; never in guide frames, previews or tours.` },
    { names: ['outro'], description: `A closing card shown for the clip's last \`duration\` seconds (default ${DEFAULT_OUTRO_S}), appended after the tail, so the clip grows by that much. Same keys as \`intro\`.` },
];

/** Every documented step field name, flattened. */
export function documentedStepFields(): string[] {
    return STEP_FIELD_DOCS.flatMap(f => [...f.names]);
}

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
    /** Multiplies the automatic subtitle chip size (font and wrap width); 1 is the default. */
    subtitleScale?: number;
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
    /** Named durations and default easings (see resolveMotion). */
    motion?: MotionTokens;
    /** Colours and furniture the video wears, or a path to a shared brand file (see loadBrandFile). */
    brand?: BrandKit | string;
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
    /**
     * Pin this step's cue to one placement ("top", "bottom-left", ...), taking it out of the
     * automatic dodge for as long as the cue runs. For a composition the author knows: a camera
     * push framing low content, a target that sits bottom-centre for the whole video.
     */
    subtitlePlace?: string;
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
    /** The meta.motion token `duration` was resolved from ("fast", "base", "slow"), set by resolveMotion. */
    durationToken?: MotionToken;
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
    /** Absolute path of the shared brand file meta.brand named, when it named one; set by loadTimeline. */
    brandFile?: string;
}

/** Framing facts attached to a `camera` step's info issue by the browser pass (see framingReport
 *  in runtime.js; the shape is duplicated there because the runtime cannot import this file). */
export interface FramingReport {
    scale: number;
    window: { x: number; y: number; w: number; h: number };
    target?: {
        selector: string;
        name: string;
        rect: { x: number; y: number; w: number; h: number };
        /** Share of the target itself that is inside the frame, 0 to 1. */
        visibleFraction: number;
        /** Share of the frame the target covers, 0 to 1. */
        windowCoverage: number;
    } | null;
    inFrame: { name: string; coverage: number }[];
    sliced: { name: string; by: string }[];
    /** Share of the frame covered by content rather than background, 0 to 1. */
    contentCoverage: number;
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
    /** Camera framing facts, on the info issue a `camera` step's report lands on (check --json). */
    framing?: FramingReport;
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

/**
 * CLI `--tail`: a bare number is milliseconds (the flag's documented unit); a string with an
 * explicit unit ("2500ms", "2.5s") is accepted too, on the timeline's own time grammar. NaN when
 * the value is neither -- a partial parse like "2sX" or a bare float with stray text must not
 * silently mean something else.
 */
export function parseTailMs(v: string): number {
    const s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
    return parseTime(s);
}

/** CLI `--duration`: a bare number of seconds, optionally fractional. NaN for anything else (units included). */
export function parseDurationS(v: string): number {
    const s = String(v).trim();
    return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
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
    resolveMotion(timeline);
    assignSubtitleWindows(timeline);
    return timeline;
}

/**
 * Which timeline file a directory means: `config` relative to `dir` (absolute passes through),
 * else `vistaro.config.json`. One place decides it, so the strings file, the content hash and the
 * output names all derive from the same answer.
 */
export function resolveConfigPath(dir: string, config?: string): string {
    const resolved = path.resolve(dir, config || 'vistaro.config.json');
    // 3.0 renamed the default timeline with no fallback. A 2.x project then has a timeline the CLI
    // would report as "not found", so name both files instead, from the one resolver every command uses.
    if (!config && !fs.existsSync(resolved) && fs.existsSync(path.resolve(dir, LEGACY_CONFIG))) {
        throw new Error(`${path.resolve(dir)} has ${LEGACY_CONFIG}, the Vistaro 2.x name: rename ${LEGACY_CONFIG} to vistaro.config.json (and ${LEGACY_MANIFEST}, if present, to vistaro.manifest.json) -- Vistaro 3.0 reads only the new names`);
    }
    return resolved;
}
const LEGACY_CONFIG = 'anim.config.json';
const LEGACY_MANIFEST = 'anim.manifest.json';

/**
 * A `--config` value as typed on the command line: resolved against the CWD, like every other path
 * option the CLI takes (-o, --storage-state, --guide-dir), then handed to loadTimeline absolute.
 * The library's own base is the timeline's directory; keeping the two apart is why every command
 * prints the path it resolved.
 */
export function cliConfigPath(config?: string): string | undefined {
    return config ? path.resolve(config) : undefined;
}

/**
 * The name a non-default timeline lends to its outputs (`scenarios/export-word.json` ->
 * `export-word`), or undefined for the directory's own. Two scenarios in one directory would
 * otherwise share `preview.png`, `animated.html` and `guide/`, and an author would read one
 * scenario's contact sheet while fixing the other's timeline.
 */
export function configStem(dir: string, config?: string): string | undefined {
    if (!config) return undefined;
    const p = resolveConfigPath(dir, config);
    if (p === path.resolve(dir, 'vistaro.config.json')) return undefined;
    return path.basename(p).replace(/\.json$/i, '');
}

/**
 * Read and parse the directory's timeline (`opts.config`, else `<dir>/vistaro.config.json`), then
 * overlay that timeline's strings file when one exists for
 * the resolved locale (--locale > vistaro.manifest.json locale > meta.locale). Every command loads
 * its timeline through here, so a localized directory renders translated titles, subtitles,
 * narration, notes and translatable typed values without touching the choreography.
 * Throws with a readable message when missing or invalid.
 */
export function loadTimeline(dir: string, opts: { locale?: string; device?: DeviceKind; config?: string } = {}): Timeline {
    const p = resolveConfigPath(dir, opts.config);
    if (!fs.existsSync(p)) {
        // Keyed on where it RESOLVED, not on whether an option was passed, so an explicit
        // --config vistaro.config.json still gets the scaffolding hint.
        throw new Error(p === path.resolve(dir, 'vistaro.config.json')
            ? `vistaro.config.json not found in ${path.resolve(dir)} (run \`init-config ${dir}\` to scaffold one)`
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
    // A shared brand file is read in place before anything renders, so every consumer sees the object.
    loadBrandFile(timeline, p);
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
    // A device block may bring a token reference ("duration": "fast") or a new action: resolve again.
    resolveMotion(timeline);
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

/** Total playback length: last step's interaction + its intrinsic duration + meta.tailMs (default 2500) + the brand's outro card, which plays after the tail. */
export function computeDurationMs(timeline: Timeline): number {
    const tail = typeof timeline.meta.tailMs === 'number' ? timeline.meta.tailMs : DEFAULT_TAIL_MS;
    let end = 0;
    for (const s of timeline.steps) {
        if (!Number.isFinite(s.timeMs)) continue;
        end = Math.max(end, s.timeMs + intrinsicDurationMs(s));
    }
    return end + tail + outroMs(timeline);
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
    // A negative tail can undercut the last step's own interaction, clipping the payoff while
    // chapters/cues are clamped to the shortened length; refuse it rather than clamp silently.
    if (meta.tailMs !== undefined && (typeof meta.tailMs !== 'number' || !Number.isFinite(meta.tailMs) || meta.tailMs < 0)) {
        issues.push({ level: 'error', field: 'tailMs', message: `meta.tailMs must be a non-negative number of milliseconds (got ${JSON.stringify(meta.tailMs)})` });
    }
    // A bad subtitleScale would silently fall back to 1 inside the runtime: report it here, where
    // the config can be fixed, instead of rendering a video at a size nobody asked for.
    if (meta.subtitleScale !== undefined && (typeof meta.subtitleScale !== 'number' || !Number.isFinite(meta.subtitleScale) || meta.subtitleScale <= 0)) {
        issues.push({ level: 'error', field: 'subtitleScale', message: `meta.subtitleScale must be a positive number multiplying the automatic subtitle size (got ${JSON.stringify(meta.subtitleScale)})` });
    }
    issues.push(...validateMotion(meta.motion), ...validateBrand(meta.brand));
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
        if (s.subtitlePlace !== undefined) {
            if (typeof s.subtitlePlace !== 'string' || !SUBTITLE_PLACES.includes(s.subtitlePlace)) {
                issues.push(issueFor(s, 'error', `"subtitlePlace" must be one of ${SUBTITLE_PLACES.map(p => `"${p}"`).join(', ')} (got ${JSON.stringify(s.subtitlePlace)})`, 'subtitlePlace'));
            } else if (!s.subtitle) {
                issues.push(issueFor(s, 'warning', '"subtitlePlace" pins this step\'s own cue but the step has no "subtitle"; it does nothing', 'subtitlePlace'));
            }
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
            issues.push(issueFor(s, 'error', `"duration" must be a number of seconds or a motion token (${MOTION_TOKENS.map(t => `"${t}"`).join(', ')})`, 'duration'));
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

    issues.push(...introOverlaps(timeline));

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

/** meta.motion: three non-negative durations in seconds and two named easings; anything else is reported. */
export function validateMotion(motion: unknown): Issue[] {
    if (motion === undefined) return [];
    const issues: Issue[] = [];
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) {
        return [{ level: 'error', field: 'motion', message: `meta.motion must be an object of motion tokens (${MOTION_KEYS.join(', ')})` }];
    }
    const m = motion as Record<string, unknown>;
    for (const t of MOTION_TOKENS) {
        if (m[t] !== undefined && !validSeconds(m[t])) issues.push({ level: 'error', field: 'motion', message: `meta.motion.${t} must be a non-negative number of seconds (got ${JSON.stringify(m[t])})` });
    }
    for (const k of ['ease', 'cameraEase'] as const) {
        if (m[k] !== undefined && (typeof m[k] !== 'string' || !(EASING_NAMES as readonly string[]).includes(m[k] as string))) {
            issues.push({ level: 'error', field: 'motion', message: `meta.motion.${k} must be one of ${EASING_NAMES.join(', ')} (got ${JSON.stringify(m[k])})` });
        }
    }
    for (const k of Object.keys(m)) {
        if (!(MOTION_KEYS as readonly string[]).includes(k)) issues.push({ level: 'warning', field: 'motion', message: `meta.motion: unknown token "${k}" ignored (known: ${MOTION_KEYS.join(', ')})` });
    }
    return issues;
}

/**
 * meta.brand: types, unknown tokens (warnings, so a typo'd "accnet" is not silently dropped), and
 * text contrast of the caption and the intro/outro cards against their backgrounds (a warning below
 * 4.5:1, the WCAG AA bar for body text). A string here means loadTimeline never resolved it -- the
 * timeline was parsed without a file to resolve against -- which is reported as such.
 */
export function validateBrand(brand: unknown): Issue[] {
    if (brand === undefined) return [];
    const issues: Issue[] = [];
    const err = (message: string) => issues.push({ level: 'error', field: 'brand', message });
    const warn = (message: string) => issues.push({ level: 'warning', field: 'brand', message });
    if (typeof brand === 'string') { warn(`meta.brand names a file (${brand}) that was not resolved here; it is read when the timeline is loaded from its directory`); return issues; }
    if (!brand || typeof brand !== 'object' || Array.isArray(brand)) { err(`meta.brand must be an object of brand tokens (${BRAND_KEYS.join(', ')}) or a path to a brand file`); return issues; }
    const b = brand as Record<string, any>;
    const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    const unknown = (obj: Record<string, unknown>, known: readonly string[], where: string) => {
        for (const k of Object.keys(obj)) if (!known.includes(k)) warn(`${where}: unknown token "${k}" ignored (known: ${known.join(', ')})`);
    };
    const str = (v: unknown, where: string) => { if (v !== undefined && (typeof v !== 'string' || !v.trim())) err(`${where} must be a non-empty string (a CSS value; got ${JSON.stringify(v)})`); };
    unknown(b, BRAND_KEYS, 'meta.brand');
    str(b.accent, 'meta.brand.accent');
    str(b.cursor, 'meta.brand.cursor');
    const contrast = (fg: unknown, bg: unknown, where: string) => {
        const r = contrastRatio(fg, bg);
        if (r !== null && r < MIN_CONTRAST) warn(`${where}: text ${JSON.stringify(fg)} on ${JSON.stringify(bg)} has a contrast ratio of ${r}:1, below ${MIN_CONTRAST}:1 (hard to read in a video watched small)`);
    };
    if (b.caption !== undefined) {
        if (!isObj(b.caption)) err(`meta.brand.caption must be an object (${BRAND_CAPTION_KEYS.join(', ')})`);
        else {
            unknown(b.caption, BRAND_CAPTION_KEYS, 'meta.brand.caption');
            for (const k of ['font', 'color', 'background'] as const) str(b.caption[k], `meta.brand.caption.${k}`);
            const r = b.caption.radius;
            if (r !== undefined && !(typeof r === 'string' && r.trim()) && !(typeof r === 'number' && r >= 0)) err(`meta.brand.caption.radius must be px (a number) or a CSS length (got ${JSON.stringify(r)})`);
            if (b.caption.color !== undefined || b.caption.background !== undefined) {
                contrast(b.caption.color ?? DEFAULT_CAPTION_COLORS.color, b.caption.background ?? DEFAULT_CAPTION_COLORS.background, 'meta.brand.caption');
            }
        }
    }
    if (b.logo !== undefined) {
        if (typeof b.logo === 'string') str(b.logo, 'meta.brand.logo');
        else if (!isObj(b.logo)) err('meta.brand.logo must be an image path/URL or { src, place, height }');
        else {
            unknown(b.logo, BRAND_LOGO_KEYS, 'meta.brand.logo');
            if (typeof b.logo.src !== 'string' || !b.logo.src.trim()) err('meta.brand.logo.src must be an image path (relative to index.html) or URL');
            if (b.logo.place !== undefined && !LOGO_PLACES.includes(b.logo.place)) err(`meta.brand.logo.place must be one of ${LOGO_PLACES.join(', ')} (got ${JSON.stringify(b.logo.place)})`);
            if (b.logo.height !== undefined && !(typeof b.logo.height === 'number' && b.logo.height > 0)) err('meta.brand.logo.height must be a positive number of px');
        }
    }
    for (const which of ['intro', 'outro'] as const) {
        const c = b[which];
        if (c === undefined) continue;
        if (!isObj(c)) { err(`meta.brand.${which} must be an object (${BRAND_CARD_KEYS.join(', ')})`); continue; }
        unknown(c, BRAND_CARD_KEYS, `meta.brand.${which}`);
        if (typeof c.title !== 'string' || !c.title.trim()) err(`meta.brand.${which}.title is required: the card's headline`);
        for (const k of ['subtitle', 'background', 'color'] as const) str(c[k], `meta.brand.${which}.${k}`);
        if (c.duration !== undefined && !(validSeconds(c.duration) && c.duration > 0)) err(`meta.brand.${which}.duration must be a positive number of seconds`);
        if (c.color !== undefined || c.background !== undefined) contrast(c.color ?? DEFAULT_CARD_COLORS.color, c.background ?? DEFAULT_CARD_COLORS.background, `meta.brand.${which}`);
    }
    return issues;
}

/**
 * The intro card covers the page for its whole duration: a step that interacts under it plays to
 * nobody. Warned per step (a `wait` with no subtitle is exempt -- it shows nothing anyway).
 */
function introOverlaps(timeline: Timeline): Issue[] {
    const ms = introMs(timeline);
    if (!ms) return [];
    return timeline.steps
        .filter(s => Number.isFinite(s.timeMs) && s.timeMs < ms && !(s.action === 'wait' && !s.subtitle))
        .map(s => issueFor(s, 'warning', `runs at ${formatTime(s.timeMs)}, under the brand intro card (shown until ${formatTime(ms)}): start the timeline after the intro`, 'time'));
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
