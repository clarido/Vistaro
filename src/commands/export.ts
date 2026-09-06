import * as path from 'path';
import * as fs from 'fs';
import { recordEvent } from '../manifest';
import { Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, computeDurationMs, formatTime, leadMsFor, DEFAULT_TAIL_MS } from '../engine/schema';
import { runTimeline, ensureRuntime, StepResult } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions } from '../browser';
import { encodeMp4, encodeGif, cutClip, probeDurationMs } from '../media/ffmpeg';
import { synthesizeSteps, synthesizeScript, mixNarration, narrationOverruns, VoiceOptions } from '../media/tts';
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
}

export interface ExportSummary {
    output: string;
    durationMs: number;
    vtt?: string;
    chapters: number;
    narration?: string;
    clips: string[];
    results: StepResult[];
}

const LEGACY_DEFAULT_DURATION_S = 5;

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
            (summary.clips.length ? `, ${summary.clips.length} clips` : '') + '.');
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
    if (!driven && hasRuntime) console.log('Note: no anim.config.json next to animated.html; recording with a blind wait.');
    if (!driven && !hasRuntime) console.log(`Note: ${path.basename(htmlPath)} has no timeline runtime; recording a blind ${formatTime(durationMs)} wait. Run \`build\` for driven exports (auto duration, subtitles, chapters).`);
    if (driven && !hasRuntime) console.log(`Note: ${path.basename(htmlPath)} was not built; injecting the runtime for this export (run \`build\` to persist it).`);

    console.log(`Starting video export. Duration: ${formatTime(durationMs)}. Device: ${options.device || 'desktop'}.`);
    const launched = await launchPage({ ...options, recordVideoDir: tempVideoDir, driven: true });
    const { page } = launched;
    let results: StepResult[] = [];
    let startOffsetMs = 0;
    try {
        const pageCreatedWall = Date.now();
        console.log(`Opening ${fileUrl(htmlPath)} in headless browser...`);
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        if (driven) {
            await ensureRuntime(page, timeline!, {});
            results = await runTimeline(page, timeline!, { mode: 'timed' });
            const t0Wall: number = await page.evaluate(() => { const s = (window as any).__anim.getState(); return s.timeOrigin + s.t0; });
            startOffsetMs = Math.max(0, Math.round(t0Wall - pageCreatedWall));
            if (autoDuration) {
                // Do not trust the static estimate alone: an element's own CSS transition (e.g. a 3s
                // fade) is only known once measured, so hold until the last step really completed + tail.
                const tailMs = typeof timeline!.meta.tailMs === 'number' ? timeline!.meta.tailMs : DEFAULT_TAIL_MS;
                const lastCompleted = Math.max(0, ...results.map(r => Number.isFinite(r.completedMs ?? NaN) ? r.completedMs! : 0));
                if (lastCompleted + tailMs > durationMs) {
                    console.log(`Extending to ${formatTime(lastCompleted + tailMs)}: the last step completed at ${lastCompleted}ms (static estimate was ${formatTime(durationMs)}).`);
                    durationMs = lastCompleted + tailMs;
                }
            }
            const nowMs: number = await page.evaluate(() => (window as any).__anim.now());
            if (nowMs < durationMs) await page.waitForTimeout(durationMs - nowMs);
            for (const r of results) if (r.error) console.error(`warning  step ${r.index} (${r.action}${r.target ? ' ' + r.target : ''}) failed during recording: ${r.error}`);
        } else {
            await page.waitForTimeout(durationMs);
        }
    } finally {
        await launched.close(); // flushes the webm to disk
    }

    const files = fs.readdirSync(tempVideoDir).filter(f => f.endsWith('.webm'));
    if (files.length === 0) throw new Error('video recording failed, no .webm found.');
    const webmFile = path.join(tempVideoDir, files[0]);

    const outputFile = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    const base = outputFile.replace(/\.[^.]+$/, '');
    const summary: ExportSummary = { output: outputFile, durationMs, chapters: 0, clips: [], results };

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
            const cues = subtitleCues(timeline!, actualMs);
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
        const voice: VoiceOptions = {};
        if (options.voice) { voice.openai = options.voice; voice.say = options.voice; }
        if (options.narration) {
            if (!driven) throw new Error('--narration needs anim.config.json (narration text comes from the steps)');
            console.log('Synthesizing narration per step...');
            const clips = await synthesizeSteps(timeline!, actualMs, { dir: outputDir, voice, log: m => console.log(m) });
            if (!clips.length) {
                console.error('warning  --narration: no step has "narration" or "subtitle" text; exporting without audio.');
            } else {
                for (const w of narrationOverruns(clips, durationMs)) console.error(`warning  ${w}`);
                audio = mixNarration(clips, path.join(tempVideoDir, 'narration.m4a'));
                summary.narration = audio;
            }
        } else if (options.voiceover) {
            if (!fs.existsSync(options.voiceover)) throw new Error(`voiceover script not found: ${options.voiceover}`);
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

    recordEvent(outputDir, {
        command: 'export', duration: durationMs / 1000, output: options.output, device: options.device, theme: options.theme,
        voiceover: options.voiceover, narration: !!options.narration, subtitles: summary.vtt ? path.basename(summary.vtt) : false,
        chapters: summary.chapters, clips: summary.clips.map(c => path.basename(c)), locale: options.locale ?? timeline?.meta.locale,
        driven, steps: results.map(r => ({ index: r.index, id: r.id, actualMs: r.actualMs, completedMs: r.completedMs, error: r.error })),
    });
    return summary;
}
