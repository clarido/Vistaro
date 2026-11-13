import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ffmpegStatic from 'ffmpeg-static';

/** Thin wrapper around the bundled ffmpeg binary (ffmpeg-static ships no ffprobe). */

export function ffmpegPath(): string {
    if (!ffmpegStatic) throw new Error('ffmpeg-static binary not found (run npm install)');
    return ffmpegStatic as unknown as string;
}

/**
 * How long fetching the ffmpeg binary may take: one download of a few tens of MB. spawnSync blocks
 * the event loop, so this bound cannot be left to the exit watchdog either.
 */
const FFMPEG_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The ffmpeg binary, fetched first if it is missing. ffmpeg-static downloads it from an install
 * script, and npm 12 and pnpm block dependency install scripts by default, so on those an install
 * leaves no binary: export would then record the whole video and only fail at the encode. This
 * runs ffmpeg-static's own installer (the download npm skipped), and when that cannot fetch it
 * either, stops with the one command that does. Call it before recording anything.
 */
export function ensureFfmpeg(o: { bin?: string; installer?: string } = {}): string {
    const bin = o.bin || ffmpegPath();
    if (fs.existsSync(bin)) return bin;
    const installer = o.installer || path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), 'install.js');
    console.log('ffmpeg was not downloaded at install time (npm 12 and pnpm skip install scripts); fetching it now...');
    const r = spawnSync(process.execPath, [installer], { stdio: 'inherit', timeout: FFMPEG_FETCH_TIMEOUT_MS });
    if (fs.existsSync(bin)) return bin;
    const why = r.error ? ` (${r.error.message})` : r.signal ? ` (stopped by ${r.signal})` : '';
    throw new Error(`ffmpeg is missing and could not be downloaded${why}: run this once, then retry: node ${installer}`);
}

export interface RunResult { status: number; stdout: string; stderr: string }

/**
 * How long one ffmpeg invocation may run. This bound cannot be delegated upwards: spawnSync blocks
 * the event loop, so neither the exit watchdog in cli.ts nor any timer in this process can fire
 * while ffmpeg is stuck -- only an outer kill would end it. And getting stuck is reachable from the
 * very failure this bound exists for: when closeWithWatchdog gives up on context.close(), the webm
 * Playwright was finalizing is truncated, and probeDurationMs then asks ffmpeg to decode it whole.
 */
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

/** Run ffmpeg with safe argument passing. Throws with the stderr tail when it fails (unless allowFailure). */
export function run(args: string[], opts: { allowFailure?: boolean } = {}): RunResult {
    const r = spawnSync(ensureFfmpeg(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
    const result = { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
    // A timeout populates r.error too, so it must be told apart first: reporting a ten-minute stall
    // as "could not start" would send the reader looking for a missing binary.
    if (r.signal) {
        const why = r.signal === 'SIGTERM' ? ` (it ran longer than ${FFMPEG_TIMEOUT_MS / 1000}s)` : '';
        throw new Error(`ffmpeg was killed by ${r.signal}${why} for: ffmpeg ${args.join(' ')}`);
    }
    if (r.error) throw new Error(`ffmpeg could not start: ${r.error.message}`);
    if (result.status !== 0 && !opts.allowFailure) {
        const tail = result.stderr.trim().split('\n').slice(-6).join('\n');
        throw new Error(`ffmpeg failed (exit ${result.status}) for: ffmpeg ${args.join(' ')}\n${tail}`);
    }
    return result;
}

function parseClock(s: string): number {
    const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
    if (!m) return NaN;
    return Math.round((parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3])) * 1000);
}

/**
 * Media duration in ms. Reads the `Duration:` header from `ffmpeg -i`; when it is N/A
 * (Playwright's streamed webm) decodes the file to `-f null` and reads the last `time=`.
 */
export function probeDurationMs(file: string): number {
    if (!fs.existsSync(file)) throw new Error(`probeDurationMs: ${file} not found`);
    const head = run(['-i', file], { allowFailure: true }).stderr;
    const m = /Duration:\s*([\d:.]+)/.exec(head);
    if (m) {
        const ms = parseClock(m[1]);
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    const decoded = run(['-i', file, '-f', 'null', '-'], { allowFailure: true }).stderr;
    const times = decoded.match(/time=\s*([\d:.]+)/g) || [];
    if (!times.length) return NaN;
    return parseClock(times[times.length - 1]);
}

export interface EncodeMp4Options {
    input: string;
    output: string;
    /** Optional audio track (mp3/aiff/m4a); encoded to AAC 192k. */
    audio?: string;
    /** ffmetadata file with [CHAPTER] blocks. */
    chaptersFile?: string;
    /** Trim the start of the input (ms), e.g. the blank frames before the timeline started. */
    startMs?: number;
    /** Output length (ms). */
    durationMs?: number;
    /** Emit `-an`: no audio stream at all (a reel is silent by definition). */
    muted?: boolean;
    /** x264 quality knobs; the defaults are the project's long-standing values. */
    crf?: number;
    preset?: string;
}

/** Trim flags shared by every encoder, so a format never drifts from the frame-accurate cut. */
function trimArgs(o: { startMs?: number; durationMs?: number }): string[] {
    const args: string[] = [];
    if (o.startMs && o.startMs > 0) args.push('-ss', (o.startMs / 1000).toFixed(3));
    if (o.durationMs && o.durationMs > 0) args.push('-t', (o.durationMs / 1000).toFixed(3));
    return args;
}

/** MP4 encode with the project's quality settings (libx264, crf 18, preset slow, faststart). */
export function encodeMp4(o: EncodeMp4Options): void {
    const args: string[] = ['-y', ...trimArgs(o)];
    args.push('-i', o.input);
    let inputs = 1;
    let audioIndex = -1;
    let metaIndex = -1;
    if (o.audio) { args.push('-i', o.audio); audioIndex = inputs++; }
    if (o.chaptersFile) { args.push('-i', o.chaptersFile); metaIndex = inputs++; }
    args.push('-map', '0:v:0');
    if (audioIndex >= 0) args.push('-map', `${audioIndex}:a:0`);
    if (metaIndex >= 0) args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
    args.push('-c:v', 'libx264', '-preset', o.preset ?? 'slow', '-crf', String(o.crf ?? 18), '-pix_fmt', 'yuv420p');
    if (o.muted) args.push('-an');
    if (audioIndex >= 0) {
        // Keep the full video length even if the narration is shorter; a longer narration
        // extends the file (the last frame holds), which export warns about beforehand.
        args.push('-c:a', 'aac', '-b:a', '192k');
    }
    args.push('-movflags', '+faststart', o.output);
    run(args);
}

export interface AudioMixOptions {
    /** Length of the video the mix goes under (ms): the bed is looped/trimmed to it, the mix padded to it. */
    durationMs: number;
    /** Narration already placed on its own track (mixNarration's output). */
    narration?: string;
    /** Moments (ms) of the clicks; each gets one click sound. */
    clicksAtMs?: number[];
    /** A click sound file; a short tick is synthesized when absent. */
    clickFile?: string;
    /** Music bed file, looped to the length and faded out over the last 1.5 s. */
    music?: string;
    musicDb?: number;
    /** Dip the bed under the narration (sidechain compression keyed by the narration). */
    duck?: boolean;
    /** Integrated loudness target (LUFS) for the mix; skipped when the mix is clicks alone. */
    loudnessLufs?: number;
}

/** The synthesized click: a 2.4 kHz tick with a fast exponential decay, 60 ms. */
const CLICK_SOURCE = "aevalsrc=exprs='0.5*sin(2*PI*2400*t)*exp(-t*160)|0.5*sin(2*PI*2400*t)*exp(-t*160)':s=48000:d=0.06";

/**
 * One AAC track from narration, clicks and a music bed, in a single ffmpeg pass: clicks delayed to
 * their moments, the bed looped, set to its gain, faded out and (optionally) ducked under the
 * narration, everything mixed, padded to the video's length and loudness-normalised (EBU R128,
 * true peak -1.5 dBTP). Clicks alone are not normalised: integrated loudness gates out the silence,
 * so a few ticks would be pushed to programme loudness and come out startlingly loud.
 */
export function mixAudio(o: AudioMixOptions, outFile: string): string {
    const args: string[] = ['-y'];
    const filters: string[] = [];
    const mixInputs: string[] = [];
    const dur = (o.durationMs / 1000).toFixed(3);
    let n = 0;
    let narr = -1, bed = -1, click = -1;
    if (o.narration) { args.push('-i', o.narration); narr = n++; }
    if (o.music) { args.push('-stream_loop', '-1', '-i', o.music); bed = n++; }
    const clicks = (o.clicksAtMs ?? []).filter(ms => Number.isFinite(ms) && ms >= 0 && ms < o.durationMs);
    if (clicks.length) {
        if (o.clickFile) args.push('-i', o.clickFile);
        else args.push('-f', 'lavfi', '-i', CLICK_SOURCE);
        click = n++;
    }
    if (narr < 0 && bed < 0 && click < 0) throw new Error('mixAudio: nothing to mix');
    const fmt = 'aformat=sample_rates=48000:channel_layouts=stereo';
    let narrLabel = '';
    if (narr >= 0) {
        const duckIt = bed >= 0 && o.duck !== false;
        filters.push(`[${narr}:a]${fmt}${duckIt ? ',asplit=2[narr][key]' : '[narr]'}`);
        narrLabel = '[narr]';
        mixInputs.push(narrLabel);
    }
    if (bed >= 0) {
        const fadeStart = Math.max(0, o.durationMs / 1000 - 1.5).toFixed(3);
        filters.push(`[${bed}:a]${fmt},atrim=0:${dur},volume=${o.musicDb ?? -18}dB,afade=t=out:st=${fadeStart}:d=1.5[bedraw]`);
        if (narr >= 0 && o.duck !== false) {
            filters.push('[bedraw][key]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=400[bed]');
        } else {
            filters.push('[bedraw]anull[bed]');
        }
        mixInputs.push('[bed]');
    }
    if (click >= 0) {
        const outs = clicks.map((_, i) => `[c${i}]`).join('');
        filters.push(`[${click}:a]${fmt},volume=-6dB,asplit=${clicks.length}${outs}`);
        clicks.forEach((ms, i) => filters.push(`[c${i}]adelay=${Math.round(ms)}|${Math.round(ms)}[cd${i}]`));
        if (clicks.length > 1) filters.push(`${clicks.map((_, i) => `[cd${i}]`).join('')}amix=inputs=${clicks.length}:normalize=0:dropout_transition=0[clicks]`);
        else filters.push('[cd0]anull[clicks]');
        mixInputs.push('[clicks]');
    }
    const mixed = mixInputs.length > 1 ? `${mixInputs.join('')}amix=inputs=${mixInputs.length}:normalize=0:dropout_transition=0,` : mixInputs[0];
    filters.push(`${mixed}apad=whole_dur=${dur},atrim=0:${dur},${fmt}[out]`);
    const normalise = narr >= 0 || bed >= 0;
    if (!normalise) {
        args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-t', dur, outFile);
        run(args);
        return outFile;
    }
    // Two-pass loudness: render the mix losslessly, measure it, then apply the measured values as a
    // linear gain (single-pass loudnorm is dynamic and lands about 1 LU off on a short clip).
    const raw = outFile.replace(/\.[^./\\]+$/, '') + '.premix.wav';
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', '-t', dur, raw);
    run(args);
    try {
        const target = `I=${o.loudnessLufs ?? -16}:TP=-1.5:LRA=11`;
        const probe = run(['-hide_banner', '-nostats', '-i', raw, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'], { allowFailure: true }).stderr;
        const json = /\{[\s\S]*"input_i"[\s\S]*?\}/.exec(probe);
        let af = `loudnorm=${target}`;
        if (json) {
            const m = JSON.parse(json[0]);
            if (Number.isFinite(parseFloat(m.input_i)) && parseFloat(m.input_i) > -70) {
                af = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
            }
        }
        run(['-y', '-i', raw, '-af', `${af},${fmt}`, '-c:a', 'aac', '-b:a', '192k', '-t', dur, outFile]);
    } finally {
        fs.rmSync(raw, { force: true });
    }
    return outFile;
}

/** Integrated loudness (LUFS) of a file's audio, measured with the EBU R128 scanner. NaN without audio. */
export function measureLoudness(file: string): number {
    const r = run(['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128', '-f', 'null', '-'], { allowFailure: true }).stderr;
    // The LAST summary: ffmpeg 6.0 (ffmpeg-static) reconfigures the graph on an AAC input and
    // prints a first summary for the discarded instance, which saw no audio and reads -70 LUFS.
    const all = [...r.matchAll(/Summary:[\s\S]*?I:\s*(-?[\d.]+) LUFS/g)];
    return all.length ? parseFloat(all[all.length - 1][1]) : NaN;
}

/** Number of audio streams in a media file. */
export function audioStreamCount(file: string): number {
    const head = run(['-hide_banner', '-i', file], { allowFailure: true }).stderr;
    return (head.match(/Stream #\d+:\d+[^:]*: Audio:/g) || []).length;
}

export interface EncodeGifOptions {
    startMs?: number;
    durationMs?: number;
    /** Scale to this width, height auto (kept even). Omit to keep the source size. */
    width?: number;
    /**
     * Cap the LONGER edge at this many pixels, whichever edge that is, height/width auto (kept even).
     * A budget expressed as a width silently quadruples for a portrait clip: 720 wide is 292k pixels
     * at 16:9 but 1.12M at 9:19.5, so a phone GIF came out ~3.7x heavier than the desktop one it was
     * meant to undercut. Takes precedence over `width`.
     */
    longEdge?: number;
    /** Frames per second; the default is the original 20. */
    fps?: number;
}

/** High-quality GIF via palettegen/paletteuse (20fps and full size unless told otherwise). */
export function encodeGif(input: string, output: string, o: EncodeGifOptions = {}): void {
    const args: string[] = ['-y', ...trimArgs(o)];
    // `if(gt(iw,ih),...)` picks the orientation inside ffmpeg, so no dimension probe is needed.
    const scale = o.longEdge && o.longEdge > 0
        ? `scale='if(gt(iw,ih),${Math.round(o.longEdge)},-2)':'if(gt(iw,ih),-2,${Math.round(o.longEdge)})':flags=lanczos,`
        : o.width && o.width > 0 ? `scale=${Math.round(o.width)}:-2:flags=lanczos,` : '';
    const filter = `${scale}fps=${o.fps && o.fps > 0 ? o.fps : 20},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=sierra2_4a`;
    args.push('-i', input, '-vf', filter, '-loop', '0', output);
    run(args);
}

/**
 * VP9 WebM, silent: the second delivery format for a reel, so a page can serve whichever the
 * browser prefers. `-b:v 0` puts libvpx in constant-quality mode, where `-crf` alone sets the rate.
 */
export function encodeWebm(input: string, output: string, o: { startMs?: number; durationMs?: number; crf?: number } = {}): void {
    const args: string[] = ['-y', ...trimArgs(o)];
    args.push('-i', input,
        '-c:v', 'libvpx-vp9', '-crf', String(o.crf ?? 32), '-b:v', '0',
        '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
        '-pix_fmt', 'yuv420p', '-an', output);
    run(args);
}

/**
 * One PNG frame, for a poster shown before the clip plays. `atMs` is relative to the already-trimmed
 * video, so the caller passes the first step's time: a reel's very first frame is the mockup before
 * anything has animated in, which makes a poor cover image.
 */
export function extractPoster(input: string, output: string, atMs = 0): void {
    const args: string[] = ['-y'];
    if (atMs > 0) args.push('-ss', (atMs / 1000).toFixed(3));
    args.push('-i', input, '-frames:v', '1', output);
    run(args);
}

/** Cut [startMs, endMs] out of an encoded video into an mp4 or gif clip (re-encoded, frame-accurate). */
export function cutClip(input: string, output: string, startMs: number, endMs: number): void {
    const durationMs = Math.max(100, endMs - startMs);
    if (output.toLowerCase().endsWith('.gif')) {
        encodeGif(input, output, { startMs, durationMs });
        return;
    }
    // -map_chapters -1: a clip must not inherit the master's chapter list.
    run(['-y', '-ss', (startMs / 1000).toFixed(3), '-t', (durationMs / 1000).toFixed(3), '-i', input,
        '-map', '0:v:0', '-map', '0:a?', '-map_chapters', '-1', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output]);
}

/**
 * "332x720, 2.4 MB" for a finished asset. Nothing in the pipeline surfaced output weight, so a
 * portrait GIF shipping at 10MB could only be found by running `du` — the commands now say it.
 */
export function describeAsset(file: string): string {
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { return 'unknown size'; }
    const mb = bytes / (1024 * 1024);
    const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
    const stderr = run(['-i', file], { allowFailure: true }).stderr;
    const dims = /,\s(\d{2,5}x\d{2,5})[\s,]/.exec(stderr);
    // A silent drop is the worse failure: the line still reads like a normal one, so a reader
    // cannot tell "no dimensions parsed" from "this asset has none". Say which half is missing.
    return dims ? `${dims[1]}, ${size}` : `dimensions unknown, ${size}`;
}

/** Chapters as ffmpeg lists them (`Chapter #0:N: start S, end E` + title), for verification. */
export function listChapters(file: string): { startMs: number; endMs: number; title: string }[] {
    const stderr = run(['-i', file], { allowFailure: true }).stderr;
    const out: { startMs: number; endMs: number; title: string }[] = [];
    const re = /Chapter #\d+:\d+: start ([\d.]+), end ([\d.]+)\s*\n(?:.*\n)?\s*title\s*:\s*(.*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr))) {
        out.push({ startMs: Math.round(parseFloat(m[1]) * 1000), endMs: Math.round(parseFloat(m[2]) * 1000), title: m[3].trim() });
    }
    return out;
}
