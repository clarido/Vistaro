import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { Issue, Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, isReel, CURSOR_ACTIONS, TARGET_REQUIRED, issueFor as schemaIssue, deviceKind, emulateMobileFor, cliConfigPath, resolveConfigPath, configStem, FramingReport, SUBTITLE_PLACES } from '../engine/schema';
import { runTimeline, ensureRuntime, LiveOptions } from '../engine/driver';
import { bootOptions } from '../engine/inject';
import { launchPage, fileUrl, ViewportOptions, assertReachable, sanitizeUrl, resolveViewport } from '../browser';
import { extractStrings, isAutoStepId, stringsPathFor, localizedStringsFiles } from '../engine/strings';
import { displayPath } from '../catalog';
import { runResetCommand, resolveResetCommand } from '../reset';

export interface CheckOptions extends ViewportOptions {
    static?: boolean;
    /** Validate for `record` (a live page): navigate/waitFor are expected, no index.html; probes the page when a URL is known. */
    live?: boolean;
    /** Live probe: page to open (default meta.url). Without a URL, `--live` is a static pass. */
    url?: string;
    storageState?: string;
    ignoreHttpsErrors?: boolean;
    /** Live probe: reset command run before the pass (default meta.reset). */
    resetCmd?: string;
    /** Allow `meta.reset` from anim.config.json to run (a shell command out of a file). */
    allowReset?: boolean;
    /** Validate as a guide: a numbered step without a title is an error, not a warning. */
    guide?: boolean;
    json?: boolean;
    locale?: string;
    /** --config: a timeline other than <dir>/anim.config.json (cwd-relative on the CLI). */
    config?: string;
    /** --trace: record per-step overlay geometry to <dir>/trace.json during the browser pass. */
    trace?: boolean;
}

/** One line of trace.json: what the step did, and where the runtime's furniture sat right after
 *  it (cursor point, spotlight box, placed subtitle chip, active camera window -- authored px).
 *  Motion as data: an author answers "did the cursor cross the chip" by reading, not watching. */
export interface TraceRecord {
    index: number;
    id: string;
    action: string;
    target?: string;
    /** Measured interaction moment (null in the JSON when the step failed before interacting; NaN
     *  serializes as null, so the file's type is null there). */
    actualMs: number;
    completedMs?: number;
    error?: string;
    cursor: { x: number; y: number } | null;
    spotlight: { x: number; y: number; w: number; h: number } | null;
    subtitle: { x: number; y: number; w: number; h: number; place: string } | null;
    camera: { scale: number; window: { x: number; y: number; w: number; h: number } } | null;
}

/** Sub-pixel layout rounding routinely puts an element a pixel over an edge; below this it is noise. */
const CROP_TOLERANCE_PX = 2;

interface TargetProbe {
    error?: string;
    count: number;
    rendered?: boolean;
    /** tag#id/class "text snippet" of the first match, so a report can say WHICH element a selector resolved to. */
    descriptor?: string;
    /** el or an ancestor is scaled to nothing (a CSS scale(0) pre-hide is invisible without opacity). */
    transformHidden?: boolean;
    /** Faintest computed opacity on the self -> documentElement chain, 0 to 1. */
    effectiveOpacity?: number;
    /** Rect-level cropping (px): outside the viewport, and outside the worst clipping ancestor.
     *  Absent on the early-return paths (bad selector, no match), which never reach the measurement. */
    outsideViewport?: number;
    clipOverflow?: number;
    /** True when a previous `camera` step still holds the page under a transform. */
    cameraActive?: boolean;
    /** How much of the target's box survives its clipping ancestors, 0 (nothing) to 1 (all of it). */
    visibleFraction?: number;
    clippedBy?: string;
    clipped?: boolean;
    anchored?: boolean;
    anchorSelector?: string;
    width?: number;
    height?: number;
    display?: string;
    visibility?: string;
    opacity?: number;
    inViewport?: boolean;
}

/** Same Issue shape as the static pass; the browser pass reports about a target unless told otherwise. */
const issueFor = (step: Step, level: Issue['level'], message: string, field = 'target'): Issue =>
    schemaIssue(step, level, message, field);

/**
 * The per-step probe shared by the mockup pass and the live pass: inspect the step's own target
 * right before the step runs (missing, hidden, 0x0, clipped, off-screen), then let the step run so
 * targets revealed by earlier steps are checked in the state they will really be in.
 */
function probeHooks(page: Page, where: string, issues: Issue[], staticIssues: Issue[], reelTimeline = false, trace?: TraceRecord[]) {
    // Steps whose target is already statically wrong would only produce a duplicate browser error.
    const staticTargetErrors = new Set(staticIssues.filter(i => i.level === 'error' && i.field === 'target').map(i => i.step));
    const reportedMissing = new Set<number>();
    return {
        beforeStep: async (step: Step) => {
            if (typeof step.target !== 'string' || !step.target.trim()) return;
            const probe: TargetProbe = await page.evaluate((sel: string) => {
                let all: NodeListOf<Element>;
                try { all = document.querySelectorAll(sel); } catch (e: any) { return { error: e.message, count: 0 }; }
                if (!all.length) return { count: 0 };
                const el = all[0];
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                // checkVisibility() is false when the element or an ancestor is display:none / visibility:hidden.
                const rendered = typeof (el as any).checkVisibility === 'function'
                    ? (el as any).checkVisibility({ visibilityProperty: true })
                    : cs.display !== 'none' && cs.visibility !== 'hidden';
                var anim = (window as any).__anim;
                var anchor = anim.anchorOf(el);
                var ar = anchor.getBoundingClientRect();
                // The faintest opacity on the chain self -> documentElement, and whether any
                // transform on that chain collapses the element away: a card pre-hidden by a
                // wrapper's opacity 0 or by scale(0) -- its own or an ancestor's -- is as
                // invisible as one hiding itself, and the reveal warning below must not call it
                // visible. The transform test lives in the runtime (anim.transformHidden): a
                // NON-collapsed transform (the translate(-50%, -50%) centering idiom) hides
                // nothing and must not suppress the warning.
                var effOpacity = parseFloat(cs.opacity);
                if (!Number.isFinite(effOpacity) || effOpacity < 0) effOpacity = 1;
                var opAnc = el.parentElement;
                while (opAnc && opAnc !== document.documentElement && effOpacity > 0) {
                    var op = parseFloat(getComputedStyle(opAnc).opacity);
                    if (Number.isFinite(op) && op >= 0 && op < effOpacity) effOpacity = op;
                    opAnc = opAnc.parentElement;
                }
                // No inner function declarations here: tsx/esbuild would wrap them in a `__name`
                // helper that does not exist inside the page (the callback is serialized by Playwright).
                // The runtime scrolls a clipped target into view before interacting; mirror that here
                // so the warning only fires when scrolling cannot reveal it.
                let clipped = anim.isClipped(el);
                if (clipped) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); clipped = anim.isClipped(el); }
                // How much of the rect falls outside the viewport, and outside any ancestor that
                // clips. isClipped above only tests the centre point, so an element cropped along one
                // edge passes it while half of it is missing from the frame.
                var rr = el.getBoundingClientRect();
                // A camera push deliberately shows a subset of the page, so under one "outside the
                // viewport" is the intended framing rather than a fault. Ask the runtime rather than
                // reading the <body> transform: drift puts one there at boot (`check --live` keeps
                // drift when meta.drift is true), which would disable this check for the whole run.
                var cameraActive = !!(anim.cameraActive && anim.cameraActive());
                var outsideViewport = Math.max(0, -rr.left) + Math.max(0, rr.right - window.innerWidth)
                    + Math.max(0, -rr.top) + Math.max(0, rr.bottom - window.innerHeight);
                var clippedBy = '';
                var clipOverflow = 0;
                // The part of the rect that survives every clipping ancestor. isClipped above only
                // asks whether the CENTRE point is hit-testable, which is wrong in both directions:
                // an element taller than its container has its centre outside it while most of it is
                // on screen, and an element cropped along one edge keeps its centre and looks fine.
                var vl = rr.left, vt = rr.top, vr2 = rr.right, vb = rr.bottom;
                var anc = el.parentElement;
                while (anc && anc !== document.documentElement) {
                    // Only overflow that cannot be reached counts, and only on the axis that hides it.
                    // `auto`/`scroll` content below the fold of a scrollable panel is the normal state
                    // of every long document (it fired on demo/, where the editor simply holds more
                    // text than its panel shows at once), and the common `overflow-x: hidden;
                    // overflow-y: auto` pane would otherwise report its scrollable height as a crop.
                    var acs = getComputedStyle(anc);
                    var hidesX = acs.overflowX === 'hidden' || acs.overflowX === 'clip';
                    var hidesY = acs.overflowY === 'hidden' || acs.overflowY === 'clip';
                    if (hidesX || hidesY) {
                        var abox = anc.getBoundingClientRect();
                        var over = 0;
                        if (hidesX) { over += Math.max(0, abox.left - rr.left) + Math.max(0, rr.right - abox.right); vl = Math.max(vl, abox.left); vr2 = Math.min(vr2, abox.right); }
                        if (hidesY) { over += Math.max(0, abox.top - rr.top) + Math.max(0, rr.bottom - abox.bottom); vt = Math.max(vt, abox.top); vb = Math.min(vb, abox.bottom); }
                        if (over > clipOverflow) { clipOverflow = over; clippedBy = anim.selectorOf(anc); }
                    }
                    anc = anc.parentElement;
                }
                return {
                    count: all.length, width: r.width, height: r.height, rendered, clipped,
                    descriptor: typeof anim.describeEl === 'function' ? anim.describeEl(el) : el.tagName.toLowerCase(),
                    transformHidden: typeof anim.transformHidden === 'function' ? !!anim.transformHidden(el) : false,
                    effectiveOpacity: effOpacity,
                    outsideViewport: Math.round(outsideViewport), clipOverflow: Math.round(clipOverflow), clippedBy, cameraActive,
                    visibleFraction: rr.width && rr.height
                        ? (Math.max(0, vr2 - vl) * Math.max(0, vb - vt)) / (rr.width * rr.height) : 0,
                    anchored: anchor !== el && ar.width > 0 && ar.height > 0,
                    anchorSelector: anchor !== el ? anim.selectorOf(anchor) : undefined,
                    display: cs.display, visibility: cs.visibility, opacity: parseFloat(cs.opacity),
                    inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
                };
            }, step.target);
            if (process.env.ANIM_DEBUG) console.error(`probe step ${step.index} ${step.target}: ${JSON.stringify(probe)}`);
            if (probe.error) {
                issues.push(issueFor(step, 'error', `invalid selector ${JSON.stringify(step.target)}: ${probe.error}`));
                return;
            }
            if (probe.count === 0) {
                issues.push(issueFor(step, TARGET_REQUIRED.has(step.action) ? 'error' : 'warning', `target ${JSON.stringify(step.target)} matches nothing in ${where} at this point of the timeline`));
                reportedMissing.add(step.index);
                return;
            }
            const animatesAll = step.action === 'animate' && !!step.all;
            if (probe.count > 1 && !animatesAll) {
                // Naming the first match is the point: "which one is used" is exactly the fact an
                // author needs when the selector resolved to the wrong element of the set.
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} matches ${probe.count} elements; the first one is used: ${probe.descriptor}`));
            }
            // `animate` with `all` runs once per match, so the real count sets the step's length; the
            // authored `count` only feeds the static estimate that `export` records against.
            if (animatesAll) {
                if (probe.count === 1) {
                    issues.push(issueFor(step, 'warning', `"all": true but ${JSON.stringify(step.target)} matches a single element (nothing to stagger against; drop "all" or widen the selector)`, 'all'));
                } else if (typeof step.count === 'number' && probe.count > step.count) {
                    const stagger = typeof step.stagger === 'number' && step.stagger > 0 ? step.stagger : 0;
                    const overrunMs = Math.round(stagger * 1000 * (probe.count - step.count));
                    issues.push(issueFor(step, 'warning', `${probe.count} elements match ${JSON.stringify(step.target)} but "count" says ${step.count}: the step runs ${overrunMs}ms longer than the timeline estimates (set "count" to ${probe.count})`, 'count'));
                } else if (typeof step.count === 'number' && probe.count < step.count) {
                    issues.push(issueFor(step, 'info', `${probe.count} elements match ${JSON.stringify(step.target)} but "count" says ${step.count}: the estimate is longer than the step needs`, 'count'));
                }
            }
            // Reel constraint (AGENTS.md "Authoring a reel" #2): an element animated in from a hidden
            // `from` state must already be hidden in CSS, because the first keyframe applies when the
            // step runs, not at page load. Probed immediately before the step, so an earlier reveal
            // followed by a re-hide (a pulse) is judged in the state the page is really in. Hidden is
            // hidden however it was achieved: a wrapper's opacity 0 and the element's own scale(0)
            // are both invisible now, and neither will flash.
            if (step.action === 'animate' && step.from && typeof step.from === 'object') {
                const fromOpacity0 = step.from.opacity === 0 || step.from.opacity === '0';
                const fromScale0 = step.from.scale === 0 || step.from.scale === '0' || step.from.scaleX === 0 || step.from.scaleX === '0' || step.from.scaleY === 0 || step.from.scaleY === '0';
                const visibleNow = probe.rendered !== false && (probe.effectiveOpacity ?? 1) > 0.05 && !probe.transformHidden;
                if ((fromOpacity0 || fromScale0) && visibleNow) {
                    const hiddenState = fromScale0 ? 'scale 0' : 'opacity 0';
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} (${probe.descriptor}) is fully visible right now, but this step animates it from ${hiddenState}: it stays on screen until ${step.time ?? '?'} and then pops out and back in. Pre-hide it in CSS (${hiddenState}) -- the "from" state applies when the step runs, not at page load`, 'from'));
                }
            }
            // A reel has no cursor, so none of the cursor-action checks below fire for it and its
            // steps were previously probed for existence only. The most expensive reel mistake is a
            // payoff that is not in frame: it does not error, and it survives a contact sheet because
            // the clip is cropped rather than broken.
            if (reelTimeline) {
                if (!probe.cameraActive && (probe.outsideViewport ?? 0) > CROP_TOLERANCE_PX) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} extends ${probe.outsideViewport}px outside the ${where} viewport when this step runs: that part is not in the recorded frame`));
                } else if ((probe.clipOverflow ?? 0) > CROP_TOLERANCE_PX) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is cropped by ${probe.clipOverflow}px by ${probe.clippedBy || 'an ancestor'} (overflow is not visible): the hidden part never reaches the video`));
                }
            }
            // An `animate` step is usually what reveals its target, so a hidden or transparent
            // starting state is the intent rather than a fault, exactly as for fadeIn.
            const revealsTarget = step.action === 'fadeIn' || step.action === 'transitionScreen' || step.action === 'animate';
            if (!revealsTarget && probe.rendered === false) {
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is hidden when this step runs (display: ${probe.display}, visibility: ${probe.visibility}, or an ancestor is hidden)`));
            } else if (!revealsTarget && (!probe.width || !probe.height) && !(step.action === 'type' && probe.anchored)) {
                // An empty caret span being typed into is fine when a sized ancestor can carry the spotlight;
                // any other 0x0 target renders nothing in the frame.
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has zero size when this step runs (${Math.round(probe.width || 0)}x${Math.round(probe.height || 0)}px)${step.action === 'type' ? ' and no sized ancestor to spotlight' : ''}`));
            } else if (step.action === 'type' && probe.anchored && (!probe.width || !probe.height)) {
                const info = issueFor(step, 'info', reelTimeline
                    ? `target ${JSON.stringify(step.target)} is 0x0 (empty caret); typing is anchored to its sized ancestor ${probe.anchorSelector}`
                    : `target ${JSON.stringify(step.target)} is 0x0 (empty caret); the spotlight uses its sized ancestor ${probe.anchorSelector}`);
                info.highlightFallback = probe.anchorSelector;
                issues.push(info);
            } else if (!revealsTarget && CURSOR_ACTIONS.has(step.action) && probe.clipped && (probe.visibleFraction ?? 1) === 0) {
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is clipped by an overflow container and cannot be scrolled into view; the cursor and typed text will be off-frame`));
            } else if (!revealsTarget && CURSOR_ACTIONS.has(step.action) && (probe.clipOverflow ?? 0) > CROP_TOLERANCE_PX) {
                // isClipped only tests the centre point, so a target hidden along one edge reaches
                // here having passed every check above. For a guide the consequence is worse than for
                // a reel: the step frame IS the documentation, and it documents the visible sliver.
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is cropped by ${probe.clipOverflow}px by ${probe.clippedBy || 'an ancestor'} (overflow is not visible): the guide frame for this step shows only the part that is inside it`));
            } else if (!revealsTarget && probe.opacity === 0) {
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has opacity 0 when this step runs`));
            } else if (!revealsTarget && step.action !== 'scroll' && CURSOR_ACTIONS.has(step.action) && probe.inViewport === false) {
                issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is outside the viewport when this step runs (add a "scroll" step first)`));
            }
        },
        afterStep: async (step: Step, result: { error?: string; completedMs?: number; actualMs: number }) => {
            // A missing target was already reported by the probe above; don't list it twice.
            if (result.error && !reportedMissing.has(step.index) && !staticTargetErrors.has(step.index)) {
                issues.push(issueFor(step, 'error', `step failed in the browser: ${result.error}`, 'action'));
            }
            // --trace: one record per step, gathered right where the step ran so the geometry is
            // the state the video was in at that moment (a camera step's transform is already
            // applied under step mode's instant execution). Failures included: a step that errored
            // is often exactly the one whose geometry needs reading.
            if (trace) {
                // A record survives even when the page cannot answer (a live navigation destroyed
                // the context mid-step): the geometry fields are null and the step keeps its row,
                // so trace.json never silently loses steps.
                const overlays = await page.evaluate(() => (window as any).__anim.overlayState()).catch(() => null);
                const o = overlays || { cursor: null, spotlight: null, subtitle: null, camera: null };
                trace.push({
                    index: step.index, id: step.id, action: step.action, target: step.target,
                    actualMs: result.actualMs, completedMs: result.completedMs, error: result.error,
                    cursor: o.cursor, spotlight: o.spotlight, subtitle: o.subtitle, camera: o.camera,
                });
            }
            if (result.error) return;
            // A camera step re-frames the page, and a wrong framing (the selector resolved to the
            // wrong element, a push onto mostly background) is invisible to every check above: the
            // page is not broken, it is just aimed wrong. So the camera step reports what the viewer
            // ends up looking at as FACTS -- window, what is in frame, what is cut, how much of the
            // window is content -- which an author diffs against the timeline's intent as text.
            if (step.action === 'camera') {
                const report: FramingReport | null = await page.evaluate((sel: string | null) => (window as any).__anim.framingReport(sel), step.target ?? null);
                if (report) {
                    const w = report.window;
                    const parts = [`framing after the move: scale ${report.scale}, window ${w.w}x${w.h} at (${w.x}, ${w.y})`];
                    if (report.target) parts.push(`target ${report.target.name} (${Math.round(report.target.visibleFraction * 100)}% visible, ${Math.round(report.target.windowCoverage * 100)}% of the window)`);
                    if (report.inFrame.length) parts.push(`in frame: ${report.inFrame.map(f => `${f.name} ${Math.round(f.coverage * 100)}%`).join(', ')}`);
                    if (report.sliced.length) parts.push(`cut by the frame edge: ${report.sliced.map(s => `${s.name} (${s.by})`).join(', ')}`);
                    parts.push(`content coverage ${Math.round(report.contentCoverage * 100)}%`);
                    const info = issueFor(step, 'info', parts.join(' · '), 'camera');
                    info.framing = report;
                    issues.push(info);
                    // A push-in that frames mostly background is the one framing that is suspicious
                    // on its own: content was around (the page has it) and the window missed it.
                    // Deliberate empty framing exists, so this is a warning, never an error.
                    if (report.scale > 1.05 && report.contentCoverage < 0.15) {
                        issues.push(issueFor(step, 'warning', `the zoomed window is ${Math.round((1 - report.contentCoverage) * 100)}% background (content coverage ${Math.round(report.contentCoverage * 100)}%): check that the camera target is the element to show and that its selector resolved where intended`, 'camera'));
                    }
                }
            }
            // The chip dodges the spotlighted target, the cursor and the camera's framed content on
            // its own; a collision here means every placement overlapped and the least-bad one was
            // taken (a crowded frame) -- unless the step pinned the cue, in which case the pin won.
            if (typeof step.subtitle === 'string' && step.subtitle.trim()) {
                const hits: { what: string; areaPx: number }[] | null = await page.evaluate(() => (window as any).__anim.subtitleCollisions());
                if (hits && hits.length) {
                    // The browser pass runs even with schema errors, so an invalid place value (which
                    // the runtime ignores) must not claim the pin won; the dodge ran in that case.
                    const pinned = typeof step.subtitlePlace === 'string' && SUBTITLE_PLACES.includes(step.subtitlePlace);
                    const advice = pinned
                        ? `the cue is pinned there by subtitlePlace, so the automatic dodge did not run (move the pin, shorten the subtitle, or lower meta.subtitleScale)`
                        : `every placement collides, so the least-bad one was taken (shorten the subtitle, lower meta.subtitleScale, reframe the step, or pin the cue elsewhere with subtitlePlace)`;
                    issues.push(issueFor(step, 'warning', `the subtitle chip covers the ${hits[0].what} at this step: ${advice}`, 'subtitle'));
                }
            }
        },
    };
}

/** Run the timeline in a headless page (step mode, instant) and probe each target right before its step. */
export async function browserCheck(dir: string, timeline: Timeline, opts: ViewportOptions, staticIssues: Issue[] = [], trace?: TraceRecord[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    const htmlPath = path.resolve(dir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        issues.push({ level: 'error', message: `${htmlPath} not found` });
        return issues;
    }
    const launched = await launchPage({ ...opts, deviceScaleFactor: 1, emulateMobile: emulateMobileFor(timeline) });
    const { page } = launched;
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    try {
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        await ensureRuntime(page, timeline, { drift: false, zoom: resolveViewport(opts).scale });

        // Two authoring traps that fail silently and are very hard to see once they have happened:
        // both produce a plausible-looking video at the wrong scale rather than an error.
        if (isReel(timeline) && resolveViewport(opts).isMobile) {
            const page_ = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="viewport"]');
                const widths: number[] = [];
                for (const sheet of Array.from(document.styleSheets)) {
                    let rules: CSSRuleList | undefined;
                    try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; }
                    for (const rule of Array.from(rules || [])) {
                        const cond = (rule as CSSMediaRule).conditionText;
                        if (!cond) continue;
                        const m = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(cond);
                        if (m) widths.push(parseFloat(m[1]));
                    }
                }
                return { hasViewportMeta: !!meta, maxWidths: widths, innerWidth: window.innerWidth };
            });
            // The frame width the reel is recorded at, which is what the page must fit; `innerWidth`
            // is 980 here precisely because the emulation being warned about is already in effect.
            const frameWidth = resolveViewport(opts).width;
            if (!page_.hasViewportMeta) {
                issues.push({ level: 'warning', field: 'viewport', message: `index.html declares no <meta name="viewport">: mobile emulation lays this page out at ${page_.innerWidth}px and it is rendered at about ${(frameWidth / page_.innerWidth).toFixed(2)}x on a ${frameWidth}px frame, so text comes out unreadably small. Add <meta name="viewport" content="width=device-width, initial-scale=1">` });
            }
            // The mobile styles have to still match at the width the reel is recorded at, which is the
            // viewport times --scale. A breakpoint below it silently yields the desktop layout.
            const layoutWidth = page_.hasViewportMeta ? frameWidth : page_.innerWidth;
            const tooNarrow = page_.maxWidths.filter(w => w < layoutWidth);
            if (tooNarrow.length && tooNarrow.length === page_.maxWidths.length) {
                issues.push({ level: 'warning', field: 'viewport', message: `every max-width media query (${[...new Set(tooNarrow)].sort((a, b) => a - b).map(w => w + 'px').join(', ')}) is below the ${layoutWidth}px width this reel lays out at, so the mobile layout will not apply: raise the breakpoint above the widest viewport it is recorded at (viewport x --scale)` });
            }
        }
        await runTimeline(page, timeline, { mode: 'step', instant: true, settleMs: 0, ...probeHooks(page, 'index.html', issues, staticIssues, isReel(timeline), trace) });
    } finally {
        await launched.close();
    }
    for (const msg of pageErrors) issues.push({ level: 'warning', message: `page error while running the timeline: ${msg}` });
    return issues;
}

/**
 * `check --live` with a URL: open the live page like `record` does (runtime at document start,
 * storage state) and replay the timeline in step mode, probing each target right before its step.
 * The interactions run for real (the same page state `record` will see), so a typo'd selector costs
 * seconds here instead of a full recording. A timeline that writes data needs `meta.reset`/`--reset-cmd`
 * before `record`, exactly as it does between the recording and the guide replay.
 */
export async function liveCheck(timeline: Timeline, url: string, opts: CheckOptions, staticIssues: Issue[] = [], trace?: TraceRecord[]): Promise<Issue[]> {
    const issues: Issue[] = [];
    // Cheapest and most local checks first: a refused `meta.reset` should not cost a network round
    // trip, and nothing here may reach stdout -- `check --json` must still print one JSON document.
    let resetCmd: string | undefined;
    try { resetCmd = resolveResetCommand({ explicit: opts.resetCmd, fromTimeline: timeline.meta.reset, allowReset: opts.allowReset }); }
    catch (e: any) { issues.push({ level: 'error', message: e.message }); return issues; }
    if (opts.storageState && !fs.existsSync(opts.storageState)) {
        issues.push({ level: 'error', message: `storage state file not found: ${opts.storageState}` });
        return issues;
    }
    try { await assertReachable(url, { ignoreHttpsErrors: opts.ignoreHttpsErrors }); }
    catch (e: any) { issues.push({ level: 'error', message: e.message }); return issues; }
    try { runResetCommand(resetCmd, 'live probe', m => console.error(m)); }
    catch (e: any) { issues.push({ level: 'error', message: e.message }); return issues; }
    const launched = await launchPage({ ...opts, deviceScaleFactor: 1, driven: true, emulateMobile: emulateMobileFor(timeline), storageState: opts.storageState, runtime: true, ignoreHttpsErrors: opts.ignoreHttpsErrors });
    const { page } = launched;
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    // The probe is meant to cost seconds: a selector that never appears must not burn the 15s
    // recording default, once per step. An explicit per-step waitForTimeoutMs still wins.
    const live: LiveOptions = { boot: bootOptions(timeline, { drift: timeline.meta.drift === true }, false), waitForTimeoutMs: 5000 };
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await ensureRuntime(page, timeline, { drift: timeline.meta.drift === true });
        await runTimeline(page, timeline, { mode: 'step', instant: true, settleMs: 0, live, ...probeHooks(page, 'the page', issues, staticIssues, isReel(timeline), trace) });
    } finally {
        await launched.close();
    }
    for (const msg of pageErrors) issues.push({ level: 'warning', message: `page error while running the timeline: ${msg}` });
    return issues;
}

export async function checkCommand(dir: string, options: CheckOptions = {}): Promise<void> {
    const log = options.json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    let issues: Issue[] = [];
    let timeline: Timeline | undefined;
    let note = '';
    let kind = options.static ? 'static' : 'static + browser';
    try {
        timeline = loadTimeline(dir, { locale: options.locale, device: deviceKind(options.device), config: cliConfigPath(options.config) });
    } catch (e: any) {
        issues.push({ level: 'error', message: e.message });
    }
    if (timeline) {
        // --guide asks whether this timeline makes a good help document; a reel is not one.
        if (options.guide && isReel(timeline)) {
            issues.push({ level: 'error', field: 'guide', message: 'timeline is kind: "reel": guides are not produced for reels (a reel is a silent marketing clip with no numbered steps); drop --guide, or set meta.kind to "guide"' });
        }
        issues.push(...validateTimeline(timeline, { live: !!options.live, guide: !!options.guide && !isReel(timeline) }));
        if (timeline.strings) {
            const st = timeline.strings;
            const file = path.basename(st.file);
            for (const key of st.unknown) issues.push({ level: 'warning', field: 'strings', message: `${file}: key "${key}" matches no step or field (step ids: ${timeline.steps.map(s => s.id).join(', ')})` });
            if (st.missing.length) issues.push({ level: 'info', field: 'strings', message: `${file}: ${st.missing.length} string(s) missing, inline text used: ${st.missing.slice(0, 6).join(', ')}${st.missing.length > 6 ? ', …' : ''}` });
            if (st.untranslated.length && timeline.locale !== timeline.baseLocale) issues.push({ level: 'info', field: 'strings', message: `${file}: ${st.untranslated.length} string(s) still identical to the source text: ${st.untranslated.slice(0, 6).join(', ')}${st.untranslated.length > 6 ? ', …' : ''}` });
        } else if (timeline.locale && timeline.locale !== timeline.baseLocale) {
            issues.push({ level: 'info', field: 'strings', message: `locale "${timeline.locale}" requested but no ${displayPath(stringsPathFor(timeline.configFile!, timeline.locale))}; inline text used` });
        }
        // Translations attach to step ids: auto-generated step-NN ids silently move when a step is inserted.
        // Per timeline, not per directory: the directory scan missed scenarios/x.strings.fr.json and
        // fired for an untranslated scenario merely because the default timeline beside it was localized.
        const localized = !!timeline.strings || localizedStringsFiles(timeline.configFile!).length > 0;
        if (localized) {
            const auto = Object.keys(extractStrings(timeline)).map(k => /^steps\.(.+)\.[a-z]+$/.exec(k)?.[1]).filter((id): id is string => !!id && isAutoStepId(id));
            const ids = [...new Set(auto)];
            if (ids.length) issues.push({ level: 'warning', field: 'id', message: `${ids.length} localized step(s) use auto-generated ids (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}); give them explicit "id"s so inserting a step does not re-attach their translations` });
        }
        const timingErrors = hasErrors(issues.filter(i => i.field === 'time' || i.field === 'action'));
        // Filled by the browser/live pass when --trace asked for it.
        const trace: TraceRecord[] | undefined = options.trace ? [] : undefined;
        if (options.live) {
            // The probe runs the timeline for real against the app (clicks, keystrokes, saves), so it
            // is opt-in per invocation: an explicit --url. A bare --live stays the static pass it has
            // always been, even when meta.url would supply an address.
            const url = options.static ? undefined : options.url;
            if (!url) {
                kind = 'static, live timeline';
                note = options.static
                    ? 'Live timeline: static pass only (drop --static and pass --url to probe the targets against the page).'
                    : `Live timeline: static pass. Pass --url <url>${timeline.meta.url ? ` (meta.url is ${sanitizeUrl(timeline.meta.url)})` : ''} to probe every target against the page; the probe replays the timeline for real, so clicks, keystrokes and saves happen.`;
            } else if (timingErrors) {
                kind = 'static, live timeline';
                note = 'Live probe skipped until the timing/action errors above are fixed.';
            } else {
                kind = 'static + live probe';
                log(`Probing ${sanitizeUrl(url)}${options.storageState ? ` with storage state ${options.storageState}` : ''}...`);
                issues.push(...await liveCheck(timeline, url, options, issues, trace));
            }
        } else if (!options.static && !timingErrors) {
            issues.push(...await browserCheck(dir, timeline, options, issues, trace));
        } else if (!options.static) {
            kind = 'static';
            note = 'Browser pass skipped until the timing/action errors above are fixed.';
        }
        if (trace && trace.length) {
            const stem = configStem(dir, cliConfigPath(options.config));
            const out = path.join(dir, stem ? `trace.${stem}.json` : 'trace.json');
            fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), source: { dir: path.basename(path.resolve(dir)), config: path.basename(timeline.configFile ?? 'anim.config.json') }, steps: trace }, null, 2) + '\n');
            log(`Wrote ${out} (${trace.length} step records: cursor, spotlight, subtitle and camera geometry per step).`);
        } else if (options.trace) {
            log('No trace written: the browser pass did not run (fix the errors above, or drop --static).');
        }
    }
    const rank = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || rank[a.level] - rank[b.level]);

    const errors = issues.filter(i => i.level === 'error').length;
    const warnings = issues.filter(i => i.level === 'warning').length;
    const infos = issues.length - errors - warnings;
    if (options.json) {
        process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
    } else {
        for (const issue of issues) console.log(formatIssue(issue));
        // `timeline` stays undefined when loadTimeline threw (missing file, bad JSON, a typo'd
        // --config): the failure is reported as an issue and the summary below still runs, so
        // neither of these reads may assume it loaded.
        const where = timeline?.configFile ?? resolveConfigPath(dir, cliConfigPath(options.config));
        const fullPass = kind === 'static + browser' || kind === 'static + live probe';
        if (errors + warnings === 0 && timeline) console.log(`${infos ? '\n' : ''}OK: ${where} (${timeline.steps.length} steps, ${kind} check${infos ? `, ${infos} info` : ''}).`);
        else console.log(`\n${errors} error(s), ${warnings} warning(s)${infos ? `, ${infos} info` : ''} in ${where}${fullPass ? '' : ` (${kind} check only)`}.`);
    }
    if (note) log(note);
    process.exitCode = errors > 0 ? 1 : 0;
}
