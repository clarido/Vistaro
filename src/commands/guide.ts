import * as fs from 'fs';
import * as path from 'path';
import type { Browser, Page } from 'playwright';
import { Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, leadMsFor } from '../engine/schema';
import { ensureRuntime, StepResult, LiveOptions } from '../engine/driver';
import { launchPage, fileUrl, resolveViewport, ViewportOptions, newDrivenPage, assertReachable, sanitizeUrl } from '../browser';
import { bootOptions } from '../engine/inject';
import { captureGuide, CapturedStep, GuideCapture } from '../guide/capture';
import { writeGuide, GuideJson, GuideStepJson, GuideVideoJson } from '../guide/render';
import { chaptersFor } from '../media/chapters';
import { subtitleCues } from '../media/vtt';
import { cutClip, probeDurationMs } from '../media/ffmpeg';
import { NarrationClip, narrationOf } from '../media/tts';
import { hashGuideDir, toolVersion } from '../catalog';
import { readManifest, recordEvent } from '../manifest';

export interface GuideOptions extends ViewportOptions {
    output?: string;
    /** Padding px (string from the CLI) or false for --no-crop. */
    crop?: string | number | false;
    clips?: string;
    locale?: string;
    force?: boolean;
    hideCursor?: boolean;
    /** Live replay (after a record): override the URL / storage state recorded in the manifest. */
    url?: string;
    storageState?: string;
    ignoreHttpsErrors?: boolean;
}

/** What the guide knows about the master video (from this export, or the manifest's last driven export). */
export interface VideoInfo {
    file: string;
    durationMs: number;
    vtt?: string;
    narration: boolean;
    /** Measured interaction times from the video pass, by step index. */
    actualMs: Map<number, number>;
    /** Per-step narration clips from the video pass (audio files + durations). */
    narrationClips?: NarrationClip[];
    /** Clips already cut next to the video by `export --clips`, by step index. */
    clipFiles?: Map<number, string>;
    /** hashGuideDir at the time of the export (to spot a stale video). */
    contentHash?: string;
    /** Steps whose interaction navigated during the video pass (captured at arrival in the guide). */
    navigated?: Set<number>;
    /** A `record` event: the live URL (sanitized) and the storage state it used. */
    url?: string;
    storageState?: string;
}

const DEFAULT_CROP_PX = 120;

/** Path relative to the working directory when it lives inside it, else absolute. */
function displayPath(p: string): string {
    const r = path.relative(process.cwd(), path.resolve(p));
    return r && !r.startsWith('..') ? r.split(path.sep).join('/') : path.resolve(p);
}

export function resolveCrop(crop: GuideOptions['crop']): number | false {
    if (crop === false) return false;
    if (crop === undefined || crop === '' || crop === true as any) return DEFAULT_CROP_PX;
    const n = typeof crop === 'number' ? crop : parseFloat(String(crop));
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --crop "${crop}" (padding in px, or --no-crop)`);
    return n;
}

/** Reuse the manifest's most recent driven export as the guide's video when its file still exists. */
export function videoFromManifest(dir: string): VideoInfo | undefined {
    const manifest = readManifest(dir);
    for (let i = manifest.history.length - 1; i >= 0; i--) {
        const ev = manifest.history[i];
        if ((ev.command !== 'export' && ev.command !== 'record') || !ev.driven || !ev.output) continue;
        // `output` is recorded relative to the guide directory; older entries were relative to the cwd.
        let file = path.resolve(dir, ev.output);
        if (!fs.existsSync(file)) file = path.resolve(ev.output);
        if (!fs.existsSync(file) || !/\.mp4$/i.test(file)) continue;
        const actualMs = new Map<number, number>();
        const navigated = new Set<number>();
        for (const s of ev.steps || []) {
            if (Number.isFinite(s.actualMs)) actualMs.set(s.index, s.actualMs);
            if (s.navigated) navigated.add(s.index);
        }
        const storageState = ev.storageState ? path.resolve(dir, ev.storageState) : undefined;
        const vttFile = ev.subtitles ? path.join(path.dirname(file), ev.subtitles) : undefined;
        const clipFiles = new Map<number, string>();
        for (const c of ev.clips || []) {
            const m = /-step-(\d+)\.(mp4|gif)$/.exec(c);
            const p = path.join(path.dirname(file), c);
            if (m && fs.existsSync(p)) clipFiles.set(parseInt(m[1], 10), p);
        }
        return {
            file, durationMs: Math.round((ev.duration || 0) * 1000), vtt: vttFile && fs.existsSync(vttFile) ? vttFile : undefined,
            narration: !!ev.narration, actualMs, clipFiles, contentHash: ev.contentHash, navigated,
            url: ev.command === 'record' ? ev.url : undefined, storageState: storageState && fs.existsSync(storageState) ? storageState : undefined,
        };
    }
    return undefined;
}

/** Run the guide capture on a fresh page (no video, no drift) and write guide.json/.md/.html. */
export async function buildGuide(browser: Browser, dir: string, timeline: Timeline, opts: {
    outDir: string; crop: number | false; clips?: string; video?: VideoInfo; viewport: ViewportOptions & { deviceScaleFactor?: number };
    hideCursor?: boolean; locale?: string; log?: (m: string) => void; warn?: (m: string) => void;
    /** Live page (record): how to open it, the auth state, and the driver's live options. */
    session?: { open: (page: Page) => Promise<void>; storageState?: string; live: LiveOptions; ignoreHttpsErrors?: boolean };
    /** Steps that navigated in the video pass: captured at the arrival, before the click. */
    navigated?: Set<number>;
}): Promise<{ json: string; md: string; html: string; capture: GuideCapture }> {
    const { width, height } = resolveViewport(opts.viewport);
    const assetsDir = path.join(opts.outDir, 'assets');
    const rel = (p: string) => path.relative(opts.outDir, p).split(path.sep).join('/');

    const driven = await newDrivenPage(browser, { ...opts.viewport, deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 2, storageState: opts.session?.storageState, runtime: !!opts.session, ignoreHttpsErrors: opts.session?.ignoreHttpsErrors });
    let capture: GuideCapture;
    try {
        if (opts.session) await opts.session.open(driven.page);
        else await driven.page.goto(fileUrl(path.join(dir, 'index.html')), { waitUntil: 'load' });
        await ensureRuntime(driven.page, timeline, { drift: false });
        capture = await captureGuide(driven.page, timeline, { assetsDir, crop: opts.crop, viewport: { width, height }, hideCursor: opts.hideCursor, poster: !!opts.video, live: opts.session?.live, navigated: opts.navigated ?? opts.video?.navigated, log: opts.log });
    } finally {
        await driven.close();
    }

    const video = opts.video;
    const actualOf = (s: Step) => video?.actualMs.get(s.index) ?? s.timeMs;
    const contentHash = hashGuideDir(dir);
    if (video?.contentHash && video.contentHash !== contentHash) {
        (opts.warn ?? console.error)(`warning  the linked video was exported from different sources (content hash ${video.contentHash.slice(0, 19)}… vs ${contentHash.slice(0, 19)}… now); re-run \`export\` to refresh it.`);
    }

    // Per-step clips: reuse the export's clips when present, else cut them from the master now.
    const clipByIndex = new Map<number, string>();
    if (opts.clips) {
        if (!video) {
            (opts.warn ?? console.error)('warning  --clips needs a video: run `export` first (or use `export --guide --clips`).');
        } else {
            const ext = opts.clips === 'gif' ? 'gif' : 'mp4';
            const steps = timeline.steps;
            for (const c of capture.steps) {
                const existing = video.clipFiles?.get(c.index);
                if (existing && existing.toLowerCase().endsWith('.' + ext)) { clipByIndex.set(c.index, existing); continue; }
                const i = c.index - 1;
                const s = steps[i];
                const start = Math.max(0, actualOf(s) - leadMsFor(s, steps[i - 1]));
                if (start >= video.durationMs) continue;
                const end = i + 1 < steps.length ? Math.max(start + 500, actualOf(steps[i + 1]) - leadMsFor(steps[i + 1], s)) : video.durationMs;
                const out = path.join(assetsDir, `step-${String(c.index).padStart(2, '0')}.${ext}`);
                cutClip(video.file, out, start, Math.min(end, video.durationMs));
                clipByIndex.set(c.index, out);
            }
        }
    }

    // Per-step narration audio: copy the export's clips into assets/.
    const audioByIndex = new Map<number, { file: string; durationMs: number }>();
    if (video?.narrationClips) {
        for (const clip of video.narrationClips) {
            const out = path.join(assetsDir, `step-${String(clip.index).padStart(2, '0')}${path.extname(clip.file)}`);
            fs.copyFileSync(clip.file, out);
            audioByIndex.set(clip.index, { file: out, durationMs: clip.durationMs });
        }
    }

    const manifest = readManifest(dir);
    // The locale loadTimeline resolved (--locale > manifest.locale > meta.locale).
    const locale = timeline.locale || opts.locale || 'en';
    const toStep = (c: CapturedStep): GuideStepJson => {
        const s: GuideStepJson = {
            index: c.index, number: c.number, id: c.id, action: c.action, target: c.target,
            scheduledMs: c.scheduledMs, actualMs: video?.actualMs.get(c.index) ?? c.scheduledMs, capturedAt: c.capturedAt,
            title: c.title, subtitle: c.subtitle, narration: narrationOf(timeline.steps[c.index - 1]), note: c.note,
            image: c.image ? rel(c.image) : undefined, crop: c.crop ? rel(c.crop) : undefined, rect: c.rect ?? null, targetRect: c.targetRect, callout: c.callout ?? null,
        };
        const clip = clipByIndex.get(c.index);
        if (clip) s.clip = rel(clip);
        const audio = audioByIndex.get(c.index);
        if (audio) { s.audio = rel(audio.file); s.audioDurationMs = audio.durationMs; }
        if (c.error) s.error = c.error;
        return s;
    };
    const videoJson: GuideVideoJson | null = video ? {
        file: rel(video.file), durationMs: video.durationMs, poster: capture.poster ? rel(capture.poster) : undefined,
        subtitles: video.vtt ? rel(video.vtt) : undefined, narration: video.narration,
        chapters: chaptersFor(timeline, video.durationMs, actualOf).map(c => ({ startMs: c.startMs, endMs: c.endMs, title: c.title })),
        // Inlined so guide.html shows subtitles from file:// too (Chromium applies CORS to <track> there).
        cues: subtitleCues(timeline, actualOf, video.durationMs).map(c => ({ startMs: c.startMs, endMs: c.endMs, text: c.text })),
    } : null;
    const guide: GuideJson = {
        version: 1,
        slug: timeline.meta.slug || path.basename(path.resolve(dir)),
        title: timeline.meta.title || path.basename(path.resolve(dir)),
        app: timeline.meta.app,
        locale,
        baseLocale: timeline.baseLocale || locale,
        generatedAt: new Date().toISOString(),
        source: { dir: path.basename(path.resolve(dir)), contentHash, tool: toolVersion() },
        viewport: { width, height, deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 2, theme: opts.viewport.theme === 'dark' ? 'dark' : 'light' },
        video: videoJson,
        steps: capture.steps.map(toStep),
    };
    const written = writeGuide(opts.outDir, guide);
    return { ...written, capture };
}

/** `guide <dir>`: capture pass only, reusing the last exported video from the manifest when present. */
export async function guideCommand(dir: string, options: GuideOptions = {}): Promise<void> {
    try {
        const timeline = loadTimeline(dir, { locale: options.locale });
        const issues = validateTimeline(timeline);
        for (const issue of issues) console.error(formatIssue(issue));
        if (hasErrors(issues) && !options.force) throw new Error('fix the validation errors above or pass --force');
        const crop = resolveCrop(options.crop);
        const outDir = path.resolve(options.output || path.join(dir, 'guide'));
        const video = videoFromManifest(dir);
        if (video) console.log(`Using video ${displayPath(video.file)} from the last export (${(video.durationMs / 1000).toFixed(1)}s).`);
        else console.log('No exported video found in the manifest; the guide will have screenshots only (run `export` first for video, chapters and clips).');

        // After a `record`, the guide replays against the live page (same URL and storage state).
        let session: { open: (page: Page) => Promise<void>; storageState?: string; live: LiveOptions; ignoreHttpsErrors?: boolean } | undefined;
        if (video?.url) {
            const url = options.url || video.url;
            await assertReachable(url, { ignoreHttpsErrors: options.ignoreHttpsErrors });
            const storageState = options.storageState || video.storageState;
            console.log(`Replaying against ${sanitizeUrl(url)}${storageState ? ` with storage state ${displayPath(storageState)}` : ''}.`);
            session = {
                open: async (p) => { await p.goto(url, { waitUntil: 'load', timeout: 30000 }); await p.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); },
                storageState, live: { boot: bootOptions(timeline, { drift: timeline.meta.drift === true }, false) }, ignoreHttpsErrors: options.ignoreHttpsErrors,
            };
        }
        const launched = await launchPage({ ...options, driven: true });
        let result;
        try {
            await launched.page.close();
            result = await buildGuide(launched.browser, dir, timeline, { outDir, crop, clips: options.clips, video, viewport: options, hideCursor: options.hideCursor, locale: options.locale, log: m => console.log(m), warn: m => console.error(m), session });
        } finally {
            await launched.close();
        }
        const failed = result.capture.steps.filter(s => s.error);
        const relToDir = (p: string) => path.relative(path.resolve(dir), p).split(path.sep).join('/');
        recordEvent(dir, { command: 'guide', output: relToDir(outDir), crop, clips: options.clips, locale: timeline.locale ?? options.locale ?? timeline.meta.locale, steps: result.capture.steps.length, video: video ? relToDir(video.file) : null, url: session ? sanitizeUrl(options.url || video!.url!) : undefined, contentHash: hashGuideDir(dir) });
        console.log(`\nWrote ${displayPath(result.json)}, guide.md, guide.html (${result.capture.steps.length} steps${video ? ', video linked' : ''}).`);
        if (failed.length) {
            console.error(`${options.force ? 'warning  (--force)' : 'FAILED:'} ${failed.length} step(s) failed during capture; see guide.json "error" fields.`);
            if (!options.force) process.exitCode = 1;
        }
    } catch (e: any) {
        console.error(`Guide failed: ${e && e.message ? e.message : e}`);
        process.exitCode = 1;
    }
}
