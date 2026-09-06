import * as path from 'path';
import * as fs from 'fs';
import { recordEvent } from '../manifest';
import { Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, computeDurationMs, formatTime, leadMsFor, DEFAULT_TAIL_MS } from '../engine/schema';
import { runTimeline, ensureRuntime, StepResult } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions } from '../browser';
import { encodeMp4, encodeGif, cutClip, probeDurationMs } from '../media/ffmpeg';
import { synthesizeSteps, synthesizeScript, mixNarration, narrationOverruns, ttsEngine, VoiceOptions, NarrationClip } from '../media/tts';
import { buildGuide, resolveCrop, VideoInfo } from './guide';
import { subtitleCues, buildVtt } from '../media/vtt';
import { chaptersFor, ffmetadata } from '../media/chapters';

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
}

export interface ExportSummary {
    output: string;
    durationMs: number;
    vtt?: string;
    chapters: number;
    narration?: string;
    clips: string[];
    guide?: string;
    results: StepResult[];
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
        const rel = (p: string) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };
        console.log(`\nSuccess! Video exported to ${rel(summary.output)} (${formatTime(summary.durationMs)})` +
            (summary.vtt ? `, subtitles ${rel(summary.vtt)}` : '') +
            (summary.chapters ? `, ${summary.chapters} chapters` : '') +
            (summary.narration ? `, narration mixed in` : '') +
            (summary.clips.length ? `, ${summary.clips.length} clips` : '') +
            (summary.guide ? `, guide ${rel(path.dirname(summary.guide))}/` : '') + '.');
    } catch (error: any) {
        console.error(`Export failed: ${error && error.message ? error.message : error}`);
        process.exitCode = 1;
    } finally {
        try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

export async function runExport(outputDir: string, options: ExportOptions, tempVideoDir: string): Promise<ExportSummary> {
    // We expect the animated HTML to be either animated.html or index.html
    let htmlPath = path.resolve(outputDir, 'animated.html');
    if (!fs.existsSync(htmlPath)) {
        htmlPath = path.resolve(outputDir, 'index.html');
        if (!fs.existsSync(htmlPath)) throw new Error(`could not find animated.html or index.html in ${outputDir}`);
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    const hasRuntime = html.includes('window.__anim');

    // Timeline (optional for legacy directories without anim.config.json).
    let timeline: Timeline | undefined;
    if (fs.existsSync(path.resolve(outputDir, 'anim.config.json'))) {
        timeline = loadTimeline(outputDir, { locale: options.locale });
        const issues = validateTimeline(timeline);
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
    const isGif = options.output.toLowerCase().endsWith('.gif');
    if (!driven && hasRuntime) console.log('Note: no anim.config.json next to animated.html; recording with a blind wait (the page self-plays).');
    if (!driven && !hasRuntime) console.log(`Note: ${path.basename(htmlPath)} has no timeline runtime; recording a blind ${formatTime(durationMs)} wait. Run \`build\` for driven exports (auto duration, subtitles, chapters).`);
    if (driven && !hasRuntime) console.log(`Note: ${path.basename(htmlPath)} was not built; injecting the runtime for this export (run \`build\` to persist it).`);
    if (isGif && (options.narration || options.voiceover || options.clips || options.subtitles !== false || options.chapters !== false)) {
        console.log('Note: .gif output has no audio, chapters or subtitle track; --narration/--voiceover/--clips/subtitles/chapters are ignored.');
    }

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

    console.log(`Starting video export. Duration: ${formatTime(durationMs)}. Device: ${options.device || 'desktop'}.`);
    // __ANIM_DRIVEN only when the Node driver runs the timeline; a built page without a config self-plays.
    const launched = await launchPage({ ...options, recordVideoDir: tempVideoDir, driven });
    const { page } = launched;
    let results: StepResult[] = [];
    let t0Wall = 0;
    let firstPaintWall = NaN;
    let loadWall = 0;
    let closeWall = 0;
    try {
        console.log(`Opening ${fileUrl(htmlPath)} in headless browser...`);
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        loadWall = Date.now();
        if (driven) {
            await ensureRuntime(page, timeline!, {});
            // Make sure a few frames of the settled page are in the recording before the clock starts,
            // so t0 is always at a positive offset that can be trimmed exactly.
            await page.waitForTimeout(START_SETTLE_MS);
            results = await runTimeline(page, timeline!, { mode: 'timed' });
            const clocks: { t0Wall: number; firstPaintWall: number } = await page.evaluate(() => {
                const s = (window as any).__anim.getState();
                const paint = performance.getEntriesByType('paint').find(e => e.name === 'first-paint');
                return { t0Wall: s.timeOrigin + s.t0, firstPaintWall: paint ? performance.timeOrigin + paint.startTime : NaN };
            });
            t0Wall = clocks.t0Wall;
            firstPaintWall = clocks.firstPaintWall;
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
            const nowMs: number = await page.evaluate(() => (window as any).__anim.now());
            if (nowMs < durationMs) await page.waitForTimeout(durationMs - nowMs);
            for (const r of results) if (r.error) console.error(`warning  step ${r.index} (${r.action}${r.target ? ' ' + r.target : ''}) failed during recording: ${r.error}`);
        } else {
            await page.waitForTimeout(durationMs);
        }
    } finally {
        // The recorder writes its final frame when the page actually closes (inside page.close()),
        // not when we decide to close, so stamp the wall clock right after the page is gone.
        const closeStart = Date.now();
        await page.close().catch(() => {});
        closeWall = Date.now();
        if (process.env.ANIM_DEBUG) console.error(`page.close took ${closeWall - closeStart}ms`);
        await launched.context.close().catch(() => {}); // flushes the webm to disk; the browser stays up for --guide
        if (process.env.ANIM_DEBUG) console.error(`context close took ${Date.now() - closeWall}ms; load->t0 ${t0Wall - loadWall}ms`);
    }
    try {
        return await encodeAndFinish();
    } finally {
        await launched.browser.close().catch(() => {});
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
    const summary: ExportSummary = { output: outputFile, durationMs, chapters: 0, clips: [], results };
    let narrationClips: NarrationClip[] | undefined;

    // Actual interaction times (fall back to scheduled when a step failed).
    const actualMs = (step: Step) => {
        const r = results.find(x => x.index === step.index);
        return r && Number.isFinite(r.actualMs) ? r.actualMs : step.timeMs;
    };

    if (outputFile.toLowerCase().endsWith('.gif')) {
        console.log('Optimizing frames for high-quality GIF export...');
        encodeGif(webmFile, outputFile, { startMs: startOffsetMs, durationMs });
    } else {
        // Subtitles (.vtt next to the video).
        if (driven && options.subtitles !== false) {
            const cues = subtitleCues(timeline!, actualMs, durationMs);
            if (cues.length) {
                summary.vtt = base + '.vtt';
                fs.writeFileSync(summary.vtt, buildVtt(cues));
            }
        }
        // Chapters (ffmetadata muxed into the MP4).
        let chaptersFile: string | undefined;
        if (driven && options.chapters !== false) {
            const chapters = chaptersFor(timeline!, durationMs, actualMs);
            if (chapters.length) {
                chaptersFile = path.join(tempVideoDir, 'chapters.ffmeta');
                fs.writeFileSync(chaptersFile, ffmetadata(chapters, timeline!.meta.title));
                summary.chapters = chapters.length;
            }
        }
        // Audio: per-step narration, or the legacy whole-script voiceover.
        let audio: string | undefined;
        if (options.narration) {
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
        encodeMp4({ input: webmFile, output: outputFile, audio, chaptersFile, startMs: startOffsetMs, durationMs });

        // Per-step clips cut from the master.
        if (options.clips && driven) {
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
        if (!driven) throw new Error('--guide needs anim.config.json (guide steps come from the timeline)');
        guideDir = path.resolve(options.guideDir || path.join(outputDir, 'guide'));
        const actual = new Map<number, number>();
        for (const r of results) if (Number.isFinite(r.actualMs)) actual.set(r.index, r.actualMs);
        const clipFiles = new Map<number, string>();
        for (const c of summary.clips) { const m = /-step-(\d+)\.(mp4|gif)$/.exec(c); if (m) clipFiles.set(parseInt(m[1], 10), c); }
        const video: VideoInfo | undefined = isGif ? undefined : {
            file: outputFile, durationMs, vtt: summary.vtt, narration: !!narrationClips && narrationClips.length > 0,
            actualMs: actual, narrationClips, clipFiles,
        };
        console.log('Capturing guide frames...');
        const g = await buildGuide(launched.browser, outputDir, timeline!, {
            outDir: guideDir, crop: resolveCrop(options.crop), clips: options.clips, video, viewport: options,
            hideCursor: options.hideCursor, log: m => console.log(m),
        });
        summary.guide = g.json;
        const failed = g.capture.steps.filter(s => s.error);
        if (failed.length) console.error(`warning  ${failed.length} guide step(s) failed during capture; see guide.json "error" fields.`);
    }

    recordEvent(outputDir, {
        command: 'export', duration: durationMs / 1000, output: options.output, device: options.device, theme: options.theme,
        voiceover: options.voiceover, narration: !!options.narration, subtitles: summary.vtt ? path.basename(summary.vtt) : false,
        chapters: summary.chapters, clips: summary.clips.map(c => path.basename(c)), locale: options.locale ?? timeline?.meta.locale,
        driven, guide: guideDir, steps: results.map(r => ({ index: r.index, id: r.id, actualMs: r.actualMs, completedMs: r.completedMs, error: r.error })),
    });
    return summary;
    }
}
