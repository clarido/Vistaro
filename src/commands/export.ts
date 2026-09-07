import * as path from 'path';
import * as fs from 'fs';
import { recordEvent } from '../manifest';
import { Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, isReel, computeDurationMs, formatTime, leadMsFor, DEFAULT_TAIL_MS, deviceKind, reelOptions, intrinsicDurationMs, parseTime, emulateMobileFor } from '../engine/schema';
import { runTimeline, ensureRuntime, StepResult, RunState, LiveOptions, RunAbortedError, errorMessage } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions, resolveViewport, closeWithWatchdog, sanitizeUrl } from '../browser';
import { bootOptions } from '../engine/inject';
import { encodeMp4, encodeGif, encodeWebm, extractPoster, cutClip, probeDurationMs, describeAsset } from '../media/ffmpeg';
import { synthesizeSteps, synthesizeScript, mixNarration, narrationOverruns, ttsEngine, VoiceOptions, NarrationClip } from '../media/tts';
import { buildGuide, resolveCrop, VideoInfo } from './guide';
import { hashGuideDir, relPosix, displayPath } from '../catalog';
import { subtitleCues, buildVtt } from '../media/vtt';
import { chaptersFor, ffmetadata } from '../media/chapters';
import { runResetCommand, resolveResetCommand } from '../reset';

export interface ExportOptions extends ViewportOptions {
    /** Seconds; overrides the computed timeline length. Required when there is no anim.config.json (default 5). */
    duration?: string;
    output: string;
    voiceover?: string;
    narration?: boolean;
    voice?: string;
    /** commander: --no-subtitles / --no-chapters give false. */
    subtitles?: boolean;
    chapters?: boolean;
    clips?: string;
    tail?: string;
    force?: boolean;
    locale?: string;
    /** Also capture the step-by-step guide (guide.json/.md/.html + assets) after the video. */
    guide?: boolean;
    guideDir?: string;
    crop?: string | number | false;
    hideCursor?: boolean;
    /** Accept self-signed certificates on live pages. */
    ignoreHttpsErrors?: boolean;
    /** Live pages: shell command run before each pass (recording, guide replay); overrides meta.reset. */
    resetCmd?: string;
    /** Live pages: abandon the recording at the first `waitFor` timeout. */
    failFast?: boolean;
    /** Allow `meta.reset` from anim.config.json to run (a shell command out of a file). */
    allowReset?: boolean;
}

/** Output containers `export`/`record` can write; anything else is refused before the browser starts. */
const VIDEO_FORMATS = ['mp4', 'webm', 'gif'];
/**
 * A reel's GIF is a web asset, not an archive: the LONG edge is capped at 720 and the rate at 15fps.
 * The cap is on the long edge rather than the width because a phone reel is portrait: 720 wide is
 * 292k pixels at 16:9 but 1.12M at 9:19.5, so pinning the width shipped a mobile GIF ~3.7x heavier
 * than the desktop one it was meant to undercut.
 */
const REEL_GIF_LONG_EDGE = 720;
const REEL_GIF_FPS = 15;

/** A live page instead of a local file: the runtime is injected at document start and navigations are survived. */
export interface LiveSession {
    url: string;
    storageState?: string;
    /** Manifest command name (`record`). */
    command: string;
    /** Already-loaded timeline (record loads it for the URL); avoids a second parse. */
    timeline?: Timeline;
}

export interface ExportSummary {
    output: string;
    durationMs: number;
    /** Reel deliverables written beside the video. */
    webm?: string;
    poster?: string;
    gif?: string;
    vtt?: string;
    chapters: number;
    narration?: string;
    clips: string[];
    guide?: string;
    results: StepResult[];
    /** Steps that failed during the recording (target missing, waitFor timeout, hook error). */
    failedSteps: StepResult[];
    /** Guide steps that failed during capture (`export --guide`). */
    failedGuideSteps: number;
    /** --force: step failures are reported but do not fail the command. */
    force?: boolean;
}

/** Shared by export and record: the success line, or the failure summary + exit code 1. */
export function reportOutcome(verb: string, summary: ExportSummary, extra = ''): void {
    const rel = displayPath;
    const details = (summary.vtt ? `, subtitles ${rel(summary.vtt)}` : '') +
        (summary.chapters ? `, ${summary.chapters} chapters` : '') +
        (summary.narration ? `, narration mixed in` : '') +
        (summary.clips.length ? `, ${summary.clips.length} clips` : '') +
        (summary.guide ? `, guide ${rel(path.dirname(summary.guide))}/` : '');
    const failed = summary.failedSteps.length;
    if (failed || summary.failedGuideSteps) {
        const parts: string[] = [];
        if (failed) parts.push(`${failed} step(s) failed during the recording: ${summary.failedSteps.map(r => `step ${r.index} (${r.action}${r.target ? ' ' + r.target : ''})`).join(', ')}`);
        if (summary.failedGuideSteps) parts.push(`${summary.failedGuideSteps} guide step(s) failed during capture (see guide.json "error" fields)`);
        const head = summary.force ? 'warning  (--force)' : 'FAILED:';
        console.error(`\n${head} ${parts.join('; ')}. ${verb} ${rel(summary.output)} (${formatTime(summary.durationMs)}${extra})${details}, but it is missing what those steps were meant to show; see anim.manifest.json for per-step errors.`);
        if (!summary.force) process.exitCode = 1;
        return;
    }
    console.log(`\nSuccess! ${verb} ${rel(summary.output)} (${formatTime(summary.durationMs)}${extra})${details}.`);
}

const LEGACY_DEFAULT_DURATION_S = 5;
/** Settle after boot before the timeline clock starts (a few captured frames precede t0). */
const START_SETTLE_MS = 120;
/** Measured lag between the document's first-paint entry and Playwright's first recorded frame. */
const FIRST_FRAME_LAG_MS = 35;
/** Playwright records at a fixed 25fps. */
const RECORD_FRAME_MS = 40;

/**
 * `export <dir>`: record the timeline with Playwright (driven by src/engine/driver.ts),
 * then encode MP4/GIF with ffmpeg, plus <basename>.vtt subtitles, MP4 chapters per titled
 * step, and optional per-step TTS narration. Falls back to a blind wait for pages that
 * have no timeline (or an animated.html without the runtime).
 */
export async function exportCommand(outputDir: string, options: ExportOptions): Promise<void> {
    const tempVideoDir = path.join(outputDir, '.temp-video');
    try {
        const summary = await runExport(outputDir, options, tempVideoDir);
        reportOutcome('Video exported to', summary);
    } catch (error: any) {
        console.error(`Export failed: ${error && error.message ? error.message : error}`);
        process.exitCode = 1;
    } finally {
        try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

export async function runExport(outputDir: string, options: ExportOptions, tempVideoDir: string, session?: LiveSession): Promise<ExportSummary> {
    // Input page (a live session has no local page): with anim.config.json present, index.html is
    // always recorded with the runtime injected, so an edit to index.html after `build` can never
    // produce a video that disagrees with check/preview; animated.html is the self-playing page for
    // humans. Without a timeline, a built animated.html keeps the legacy blind-wait path.
    let htmlPath = path.resolve(outputDir, 'index.html');
    if (!session) {
        const animated = path.resolve(outputDir, 'animated.html');
        const hasConfig = fs.existsSync(path.resolve(outputDir, 'anim.config.json'));
        if ((!hasConfig || !fs.existsSync(htmlPath)) && fs.existsSync(animated)) htmlPath = animated;
        if (!fs.existsSync(htmlPath)) throw new Error(`could not find index.html or animated.html in ${outputDir}`);
    }
    const hasRuntime = session ? true : fs.readFileSync(htmlPath, 'utf8').includes('window.__anim');

    // Timeline (optional for legacy directories without anim.config.json; required for a live session).
    let timeline: Timeline | undefined;
    if (session && !fs.existsSync(path.resolve(outputDir, 'anim.config.json'))) throw new Error(`anim.config.json not found in ${outputDir} (record needs a timeline)`);
    if (fs.existsSync(path.resolve(outputDir, 'anim.config.json'))) {
        timeline = session?.timeline ?? loadTimeline(outputDir, { locale: options.locale, device: deviceKind(options.device) });
        const issues = validateTimeline(timeline, { live: !!session, guide: !!options.guide });
        for (const issue of issues) console.error(formatIssue(issue));
        if (hasErrors(issues)) {
            if (!options.force) throw new Error(`${issues.filter(i => i.level === 'error').length} validation error(s) in anim.config.json (use --force to export anyway)`);
            console.error('--force: exporting despite validation errors; failing steps are skipped.');
        }
        if (options.tail !== undefined) {
            const tail = parseFloat(options.tail);
            if (!Number.isFinite(tail) || tail < 0) throw new Error(`invalid --tail "${options.tail}" (milliseconds)`);
            timeline.meta.tailMs = tail;
        }
    }

    // Duration: --duration (seconds, may be fractional) > computed from the timeline > legacy 5s.
    let durationMs: number;
    let autoDuration = false;
    if (options.duration !== undefined) {
        const s = parseFloat(options.duration);
        if (!Number.isFinite(s) || s <= 0) throw new Error(`invalid duration "${options.duration}". Must be a positive number of seconds.`);
        durationMs = Math.round(s * 1000);
    } else if (timeline) {
        durationMs = computeDurationMs(timeline);
        autoDuration = true;
    } else {
        durationMs = LEGACY_DEFAULT_DURATION_S * 1000;
    }

    const driven = !!timeline;
    const reel = !!timeline && isReel(timeline);
    // Route on the extension up front: `-o clip.webm` used to reach ffmpeg as an MP4 encode and fail there.
    const ext = (options.output.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) || '';
    if (!VIDEO_FORMATS.includes(ext)) {
        throw new Error(`unsupported output format ${JSON.stringify('.' + ext)}: use ${VIDEO_FORMATS.map(e => '.' + e).join(', ')}`);
    }
    const isGif = ext === 'gif';
    if (!session && !driven && hasRuntime) console.log('Note: no anim.config.json next to animated.html; recording with a blind wait (the page self-plays).');
    if (!session && !driven && !hasRuntime) console.log(`Note: ${path.basename(htmlPath)} has no timeline runtime; recording a blind ${formatTime(durationMs)} wait. Run \`build\` for driven exports (auto duration, subtitles, chapters).`);
    if (isGif && (options.narration || options.voiceover || options.clips || options.guide || options.subtitles !== false || options.chapters !== false)) {
        console.error('warning  .gif output has no audio, chapters or subtitle track: --narration/--voiceover/subtitles/chapters are ignored, and there is no video link/clips for .gif output in the guide.');
    }
    // A reel is a silent marketing clip: no narration, no captions, no per-step clips. Ignored with a
    // warning rather than refused, exactly as .gif output already behaves.
    if (reel && (options.narration || options.voiceover || options.clips)) {
        console.error('warning  kind: "reel" is always silent and has no per-step clips: --narration/--voiceover/--clips are ignored.');
    }
    if (reel && session) {
        console.error('warning  recording a reel against a live page: the reel profile only changes the chrome; delivery extras (webm/poster/gif) are written for local exports.');
    }
    if (options.guide && !driven) throw new Error('--guide needs anim.config.json (guide steps come from the timeline)');
    if (options.guide && timeline && isReel(timeline)) throw new Error('--guide: the timeline is kind: "reel" and guides are not produced for reels (a reel is a silent marketing clip with no numbered steps); drop --guide, or set meta.kind to "guide"');

    // Fail fast (before a long recording) on things we can check now.
    const voice: VoiceOptions = {};
    if (!isGif && options.narration) {
        if (!driven) throw new Error('--narration needs anim.config.json (narration text comes from the steps)');
        const engine = ttsEngine(); // throws with a clear message on Linux without OPENAI_API_KEY
        if (options.voice) { if (engine === 'openai') voice.openai = options.voice; else voice.say = options.voice; }
    } else if (!isGif && options.voiceover) {
        if (!fs.existsSync(options.voiceover)) throw new Error(`voiceover script not found: ${options.voiceover}`);
        const engine = ttsEngine();
        if (options.voice) { if (engine === 'openai') voice.openai = options.voice; else voice.say = options.voice; }
    }

    const resetCmd = session ? resolveResetCommand({ explicit: options.resetCmd, fromTimeline: timeline?.meta.reset, allowReset: options.allowReset }) : undefined;
    if (resetCmd) runResetCommand(resetCmd, 'recording');
    console.log(`Starting video ${session ? 'recording' : 'export'}. Duration: ${formatTime(durationMs)}. Device: ${options.device || 'desktop'}.`);
    // __ANIM_DRIVEN only when the Node driver runs the timeline; a built page without a config self-plays.
    // Live pages get the runtime at document start (survives navigations) and the auth storage state.
    // The zoom that pairs with a scaled viewport. A live page keeps its own breakpoints, so `record`
    // stays at 1x: zooming a real app would reflow it into a layout its CSS was never written for.
    let recordScale = resolveViewport(options).scale;
    if (session && recordScale !== 1) {
        console.error(`warning  --scale ${recordScale} is ignored for a live recording: the page's own breakpoints decide its layout.`);
        recordScale = 1;
    }
    const launched = await launchPage({ ...options, emulateMobile: emulateMobileFor(timeline), scale: session ? 1 : options.scale, recordVideoDir: tempVideoDir, driven, storageState: session?.storageState, runtime: !!session, ignoreHttpsErrors: options.ignoreHttpsErrors });
    const { page } = launched;
    const pageUrl = session ? session.url : fileUrl(htmlPath);
    const shownUrl = session ? sanitizeUrl(session.url) : pageUrl;
    // Live pages: no body drift by default (a transformed <body> can break a real app's fixed layout).
    const liveBoot = session && timeline ? bootOptions(timeline, { drift: timeline.meta.drift === true }, false) : undefined;
    const live: LiveOptions | undefined = liveBoot ? { boot: liveBoot } : undefined;
    let firstPaintWall = NaN;
    const readFirstPaint = async (p: import('playwright').Page) => {
        await p.waitForFunction(() => performance.getEntriesByType('paint').some(e => e.name === 'first-paint'), null, { timeout: 1500 }).catch(() => {});
        return p.evaluate(() => { const paint = performance.getEntriesByType('paint').find(e => e.name === 'first-paint'); return paint ? performance.timeOrigin + paint.startTime : NaN; });
    };
    const open = async (p: import('playwright').Page, forRecording = false) => {
        if (session && forRecording) {
            // The recorder starts at page creation, before a slow server has painted anything: give it
            // a known first document and anchor the trim on THAT paint, then open the live URL.
            // An empty body never paints (no first-paint entry): draw something invisible.
            await p.setContent('<!doctype html><html><body style="margin:0;background:#fff"><p style="color:#fff;margin:0">.</p></body></html>', { waitUntil: 'load' });
            firstPaintWall = await readFirstPaint(p);
            if (!Number.isFinite(firstPaintWall)) console.error('warning  could not read the recorder anchor (first paint); timestamps may lead the picture by the server latency');
        }
        await p.goto(pageUrl, { waitUntil: 'load', timeout: 30000 });
        if (session) await p.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    };
    let results: StepResult[] = [];
    const runState: RunState = { t0Wall: 0, shiftMs: 0, lastPoint: null, navigations: 0 };
    let t0Wall = 0;
    // Set once this run's manifest event is written, so an abort after it cannot write a second.
    let eventRecorded = false;
    let loadWall = 0;
    let closeWall = 0;
    try {
    try {
        console.log(`Opening ${shownUrl} in headless browser...`);
        await open(page, true);
        loadWall = Date.now();
        if (driven) {
            if (live) await ensureRuntime(page, timeline!, { drift: timeline!.meta.drift === true });
            else await ensureRuntime(page, timeline!, { zoom: recordScale });
            // Make sure a few frames of the settled page are in the recording before the clock starts,
            // so t0 is always at a positive offset that can be trimmed exactly.
            await page.waitForTimeout(START_SETTLE_MS);
            // Local pages: the document's first paint is where Playwright's recording starts; read it now
            // (the entry can lag the load event by a few frames), before any navigation replaces the document.
            if (!session) firstPaintWall = await readFirstPaint(page);
            const transformed = await page.evaluate(() => getComputedStyle(document.documentElement).transform !== 'none').catch(() => false);
            if (transformed) console.error('warning  the page transforms <html>; cursor/highlight overlays are positioned on <html> and will be offset (known limitation)');
            results = await runTimeline(page, timeline!, { mode: 'timed', live, state: runState, failFast: !!options.failFast && !!live });
            t0Wall = runState.t0Wall;
            if (runState.navigations) console.log(`Survived ${runState.navigations} navigation${runState.navigations > 1 ? 's' : ''}; runtime re-booted each time.`);
            // waitFor delays pushed every later step: the recording must be that much longer too. A
            // slow load and a timed-out waitFor stretch it the same way but mean different things, and
            // a timeout the gap to the next step absorbs stretches nothing at all -- which is exactly
            // when it is easiest to miss, so it is reported on its own.
            if (runState.shiftMs > 0) durationMs += runState.shiftMs;
            const timedOutSteps = runState.timedOutSteps ?? [];
            const timeoutShift = runState.timeoutShiftMs ?? 0;
            if (timedOutSteps.length) {
                const which = timedOutSteps.map(i => { const r = results.find(x => x.index === i); return `step ${i}${r ? ` (${r.action}${r.target ? ' ' + r.target : ''}, waited ${r.waitedMs}ms)` : ''}`; }).join(', ');
                console.error(`warning  waitFor timed out on ${which}: the steps after it probably ran against the wrong page state (fix the selector, lower "waitForTimeoutMs", or use --fail-fast).${timeoutShift > 0 ? ` ${timeoutShift}ms of the recording is that timeout, not a real load.` : ''}`);
            }
            const genuineShift = runState.shiftMs - timeoutShift;
            if (genuineShift > 0) console.log(`waitFor delays shifted the timeline by ${genuineShift}ms; recording ${formatTime(durationMs)} instead of ${formatTime(durationMs - runState.shiftMs)}.`);
            else if (runState.shiftMs > 0) console.log(`Recording ${formatTime(durationMs)} instead of ${formatTime(durationMs - runState.shiftMs)} because of the waitFor timeout(s) above.`);
            if (autoDuration) {
                // Do not trust the static estimate alone: an element's own CSS transition (e.g. a 3s
                // fade) is only known once measured, so hold until the last step really completed + tail.
                const tailMs = typeof timeline!.meta.tailMs === 'number' ? timeline!.meta.tailMs : DEFAULT_TAIL_MS;
                const lastCompleted = Math.max(0, ...results.map(r => Number.isFinite(r.completedMs ?? NaN) ? r.completedMs! : 0));
                if (lastCompleted + tailMs > durationMs + 100) {
                    console.log(`Extending to ${formatTime(lastCompleted + tailMs)}: the last step completed at ${lastCompleted}ms (static estimate was ${formatTime(durationMs)}).`);
                }
                if (lastCompleted + tailMs > durationMs) durationMs = lastCompleted + tailMs;
            }
            const nowMs = Date.now() - t0Wall; // Node-owned clock (valid across navigations)
            if (nowMs < durationMs) await page.waitForTimeout(durationMs - nowMs);
            for (const r of results) if (r.error) console.error(`warning  step ${r.index} (${r.action}${r.target ? ' ' + r.target : ''}) failed during recording: ${r.error}`);
        } else {
            await page.waitForTimeout(durationMs);
        }
    } finally {
        // The recorder writes its final frame when the page actually closes (inside page.close()),
        // not when we decide to close, so stamp the wall clock right after the page is gone.
        const closeStart = Date.now();
        await closeWithWatchdog(() => page.close(), 'page');
        closeWall = Date.now();
        if (process.env.ANIM_DEBUG) console.error(`page.close took ${closeWall - closeStart}ms`);
        await closeWithWatchdog(() => launched.context.close(), 'context'); // flushes the webm to disk; the browser stays up for --guide
        if (process.env.ANIM_DEBUG) console.error(`context close took ${Date.now() - closeWall}ms; load->t0 ${t0Wall - loadWall}ms`);
    }
    return await encodeAndFinish();
    } catch (e: any) {
        // Anything that ends the run before its own event is written -- an abandoned recording
        // (--fail-fast), a page that died mid-recording, a failed encode, a guide replay whose reset
        // refused -- still records what happened, so a run never disappears from the manifest. The
        // last case is why this sits outside the recording try: the MP4 is already on disk by then.
        if (e instanceof RunAbortedError) results = e.results;
        else if (runState.results?.length) results = runState.results;
        if (driven) { try { recordAbandoned(abortReason(e)); } catch { /* the original failure matters more */ } }
        throw e;
    } finally {
        // Whatever failed above (open, runtime, recording, encode, guide), the browser must go, or the CLI never exits.
        await closeWithWatchdog(() => launched.browser.close(), 'browser');
    }

    /** The whole failure on one bounded line: errorMessage() keeps only the first, and a Playwright error's detail is on the rest. */
    function abortReason(e: any): string {
        return String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 500);
    }

    /** Fields both manifest events share, so a new one is never added to only half of them. */
    function baseEvent(): Record<string, any> {
        const rel = (p: string) => relPosix(path.resolve(outputDir), p);
        return {
            command: session ? session.command : 'export',
            url: session ? sanitizeUrl(session.url) : undefined,
            storageState: session?.storageState ? rel(path.resolve(session.storageState)) : undefined,
            navigations: runState.navigations || undefined, shiftMs: runState.shiftMs || undefined,
            timedOutSteps: runState.timedOutSteps?.length ? runState.timedOutSteps : undefined,
            device: options.device, theme: options.theme,
            locale: timeline?.locale ?? options.locale ?? timeline?.meta.locale,
            driven, reset: resetCmd ? true : undefined,
            steps: results.map(r => ({ index: r.index, id: r.id, actualMs: r.actualMs, completedMs: r.completedMs, navigated: r.navigated || undefined, waitedMs: r.waitedMs || undefined, error: r.error })),
        };
    }

    /** Manifest event for a run that ended early: the shared fields plus `aborted`, and `output` only if a file was actually left behind. */
    function recordAbandoned(message: string): void {
        if (eventRecorded) return; // encodeAndFinish already wrote this run's event
        const out = path.resolve(options.output);
        recordEvent(outputDir, {
            ...baseEvent(),
            aborted: message,
            output: fs.existsSync(out) ? relPosix(path.resolve(outputDir), out) : undefined,
        });
    }

    async function encodeAndFinish(): Promise<ExportSummary> {

    const files = fs.readdirSync(tempVideoDir).filter(f => f.endsWith('.webm'));
    if (files.length === 0) throw new Error('video recording failed, no .webm found.');
    const webmFile = path.join(tempVideoDir, files[0]);

    // Where the timeline's t0 sits in the recording. Playwright's video t=0 is the first screencast
    // frame, which arrives FIRST_FRAME_LAG_MS after the document's first paint (measured, see
    // test "first changed video frame"); the end of the file is useless as an anchor because the
    // recorder pads the tail with max(gap since the last frame, 1s) at close.
    let startOffsetMs = 0;
    if (driven && t0Wall) {
        const anchor = Number.isFinite(firstPaintWall) ? firstPaintWall + FIRST_FRAME_LAG_MS : loadWall;
        // Snap to the nearest recorded frame (the recorder emits exact 40ms frames), 1ms before its
        // timestamp so ffmpeg keeps that frame: the cut error is then within half a frame either way.
        const frames = Math.round(Math.max(0, t0Wall - anchor) / RECORD_FRAME_MS);
        startOffsetMs = frames > 0 ? frames * RECORD_FRAME_MS - 1 : 0;
        if (process.env.ANIM_DEBUG) {
            console.error(`trim: first-paint -> t0 ${Math.round(t0Wall - firstPaintWall)}ms, load -> t0 ${Math.round(t0Wall - loadWall)}ms, t0 -> close ${Math.round(closeWall - t0Wall)}ms, recorded ${probeDurationMs(webmFile)}ms, offset ${startOffsetMs}ms`);
            fs.copyFileSync(webmFile, path.resolve(options.output).replace(/\.[^.]+$/, '') + '.debug.webm');
        }
    }

    const outputFile = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const base = outputFile.replace(/\.[^.]+$/, '');
    const summary: ExportSummary = { output: outputFile, durationMs, chapters: 0, clips: [], results, failedSteps: results.filter(r => r.error), failedGuideSteps: 0, force: !!options.force };
    let narrationClips: NarrationClip[] | undefined;

    // Actual interaction times (fall back to scheduled when a step failed).
    const actualMs = (step: Step) => {
        const r = results.find(x => x.index === step.index);
        return r && Number.isFinite(r.actualMs) ? r.actualMs : step.timeMs;
    };

    const gifOptions = reel ? { longEdge: REEL_GIF_LONG_EDGE, fps: REEL_GIF_FPS } : {};
    if (isGif) {
        console.log('Optimizing frames for high-quality GIF export...');
        encodeGif(webmFile, outputFile, { startMs: startOffsetMs, durationMs, ...gifOptions });
    } else if (ext === 'webm') {
        console.log(`Encoding WebM: ${outputFile}...`);
        encodeWebm(webmFile, outputFile, { startMs: startOffsetMs, durationMs });
    } else {
        // Subtitles (.vtt next to the video). A reel carries its words in the page around it.
        if (driven && !reel && options.subtitles !== false) {
            const cues = subtitleCues(timeline!, actualMs, durationMs);
            if (cues.length) {
                summary.vtt = base + '.vtt';
                fs.writeFileSync(summary.vtt, buildVtt(cues));
            }
        }
        // Chapters (ffmetadata muxed into the MP4); a reel has no numbered steps to chapter.
        let chaptersFile: string | undefined;
        if (driven && !reel && options.chapters !== false) {
            const chapters = chaptersFor(timeline!, durationMs, actualMs);
            if (chapters.length) {
                chaptersFile = path.join(tempVideoDir, 'chapters.ffmeta');
                fs.writeFileSync(chaptersFile, ffmetadata(chapters, timeline!.meta.title));
                summary.chapters = chapters.length;
            }
        }
        // Audio: per-step narration, or the legacy whole-script voiceover.
        let audio: string | undefined;
        if (reel) {
            // Silent by definition: skip synthesis entirely rather than mixing and then muting.
        } else if (options.narration) {
            console.log('Synthesizing narration per step...');
            const clips = await synthesizeSteps(timeline!, actualMs, { dir: outputDir, voice, log: m => console.log(m) });
            if (!clips.length) {
                console.error('warning  --narration: no step has "narration" or "subtitle" text; exporting without audio.');
            } else {
                for (const w of narrationOverruns(clips, durationMs)) console.error(`warning  ${w}`);
                audio = mixNarration(clips, path.join(tempVideoDir, 'narration.m4a'));
                summary.narration = audio;
                narrationClips = clips;
            }
        } else if (options.voiceover) {
            console.log(`Generating TTS audio from ${options.voiceover}...`);
            audio = await synthesizeScript(options.voiceover, voice, tempVideoDir);
            summary.narration = audio;
        }
        console.log(`Converting to MP4: ${outputFile}...`);
        encodeMp4({ input: webmFile, output: outputFile, audio, chaptersFile, startMs: startOffsetMs, durationMs, muted: reel });

        // A reel ships in every form a homepage needs: WebM beside the MP4, a poster to show before
        // playback, and a GIF for the places that take neither.
        if (reel) {
            summary.webm = base + '.webm';
            console.log(`Encoding WebM: ${summary.webm}...`);
            encodeWebm(webmFile, summary.webm, { startMs: startOffsetMs, durationMs });
            summary.poster = base + '.poster.png';
            // The poster is the payoff frame, not the opening one: a reel's first step is usually a
            // reveal, so its own time shows a half-faded element over an empty panel. Default to the
            // last step's COMPLETION, overridable per timeline with meta.reel.poster.
            const completionMs = (st: Step) => {
                const r = results.find(x => x.index === st.index);
                return r && Number.isFinite(r.completedMs) ? r.completedMs! : actualMs(st) + intrinsicDurationMs(st);
            };
            const spec = reelOptions(timeline!).poster;
            const steps = timeline!.steps.filter(st => Number.isFinite(actualMs(st)));
            let posterAtMs = 0;
            if (spec === 'first') posterAtMs = steps.length ? completionMs(steps[0]) : 0;
            else if (spec === 'last') posterAtMs = steps.reduce((max, st) => Math.max(max, completionMs(st)), 0);
            else posterAtMs = parseTime(spec as string | number);
            if (!Number.isFinite(posterAtMs)) posterAtMs = 0;
            posterAtMs = Math.min(Math.max(0, posterAtMs), Math.max(0, durationMs - 100));
            console.log(`Extracting poster at ${(posterAtMs / 1000).toFixed(2)}s: ${summary.poster}...`);
            extractPoster(outputFile, summary.poster, posterAtMs);
            summary.gif = base + '.gif';
            console.log(`Encoding GIF (long edge ${REEL_GIF_LONG_EDGE}px, ${REEL_GIF_FPS}fps): ${summary.gif}...`);
            encodeGif(webmFile, summary.gif, { startMs: startOffsetMs, durationMs, ...gifOptions });
            console.log(`  ${path.basename(summary.gif)}: ${describeAsset(summary.gif)}`);
        }

        // Per-step clips cut from the master.
        if (options.clips && driven && !reel) {
            const ext = options.clips === 'gif' ? 'gif' : 'mp4';
            const steps = timeline!.steps;
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i];
                const start = Math.max(0, actualMs(s) - leadMsFor(s, steps[i - 1]));
                if (start >= durationMs) continue; // past the end of a shortened export
                const end = i + 1 < steps.length ? Math.max(start + 500, actualMs(steps[i + 1]) - leadMsFor(steps[i + 1], s)) : durationMs;
                const clip = `${base}-step-${String(s.index).padStart(2, '0')}.${ext}`;
                cutClip(outputFile, clip, start, Math.min(end, durationMs));
                summary.clips.push(clip);
            }
        }
    }

    const measured = probeDurationMs(outputFile);
    if (Number.isFinite(measured) && Math.abs(measured - durationMs) > 750) {
        console.error(`warning  encoded length is ${measured}ms, expected ${durationMs}ms`);
    }

    // Pass 2: guide capture on a fresh page in the same browser (no video, no drift).
    let guideDir: string | undefined;
    if (options.guide) {
        guideDir = path.resolve(options.guideDir || path.join(outputDir, 'guide'));
        const actual = new Map<number, number>();
        for (const r of results) if (Number.isFinite(r.actualMs)) actual.set(r.index, r.actualMs);
        const clipFiles = new Map<number, string>();
        for (const c of summary.clips) { const m = /-step-(\d+)\.(mp4|gif)$/.exec(c); if (m) clipFiles.set(parseInt(m[1], 10), c); }
        const navigated = new Set<number>(results.filter(r => r.navigated).map(r => r.index));
        const video: VideoInfo | undefined = isGif ? undefined : {
            file: outputFile, durationMs, vtt: summary.vtt, narration: !!narrationClips && narrationClips.length > 0,
            actualMs: actual, narrationClips, clipFiles, navigated,
        };
        if (resetCmd) runResetCommand(resetCmd, 'guide replay');
        console.log('Capturing guide frames...');
        const g = await buildGuide(launched.browser, outputDir, timeline!, {
            outDir: guideDir, crop: resolveCrop(options.crop), clips: options.clips, video, viewport: options,
            hideCursor: options.hideCursor, locale: options.locale, log: m => console.log(m), warn: m => console.error(m),
            session: session ? { open: (p) => open(p, false), storageState: session.storageState, live: live!, ignoreHttpsErrors: options.ignoreHttpsErrors } : undefined,
            navigated,
        });
        summary.guide = g.json;
        summary.failedGuideSteps = g.capture.steps.filter(s => s.error).length;
        if (session) {
            // The guide pass is a second run of the same timeline against the same app. A step that
            // succeeded in the recording and failed here almost always means the page state differs
            // between the two passes (a step that saved data is not idempotent), not a bad selector.
            const recorded = new Map(results.map(r => [r.index, r]));
            for (const s of g.capture.steps) {
                const first = recorded.get(s.index);
                if (s.error && first && !first.error) {
                    console.error(`warning  step ${s.index}${s.title ? ` (${s.title})` : ''} succeeded during the recording but failed on the guide replay (${s.error}): the page state likely differs between the two passes (a step that writes data is not idempotent). Reset the app between passes with meta.reset or --reset-cmd, or run \`record\` without --guide, reset, then \`guide --url … --storage-state …\`.`);
                }
            }
        }
    }

    // Paths in the manifest are relative to the output directory (never absolute, never cwd-relative).
    const relToDir = (p: string) => relPosix(path.resolve(outputDir), p);
    recordEvent(outputDir, {
        ...baseEvent(),
        duration: durationMs / 1000, output: relToDir(outputFile),
        voiceover: options.voiceover ? relToDir(path.resolve(options.voiceover)) : undefined, narration: !!options.narration, subtitles: summary.vtt ? path.basename(summary.vtt) : false,
        chapters: summary.chapters, clips: summary.clips.map(c => path.basename(c)), guide: guideDir ? relToDir(guideDir) : undefined,
        contentHash: driven ? hashGuideDir(outputDir) : undefined,
    });
    eventRecorded = true;
    return summary;
    }
}
