import { spawnSync } from 'child_process';
import * as fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';

/** Thin wrapper around the bundled ffmpeg binary (ffmpeg-static ships no ffprobe). */

export function ffmpegPath(): string {
    if (!ffmpegStatic) throw new Error('ffmpeg-static binary not found (run npm install)');
    return ffmpegStatic as unknown as string;
}

export interface RunResult { status: number; stdout: string; stderr: string }

/** Run ffmpeg with safe argument passing. Throws with the stderr tail when it fails (unless allowFailure). */
export function run(args: string[], opts: { allowFailure?: boolean } = {}): RunResult {
    const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const result = { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
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
}

/** MP4 encode with the project's quality settings (libx264, crf 18, preset slow, faststart). */
export function encodeMp4(o: EncodeMp4Options): void {
    const args: string[] = ['-y'];
    if (o.startMs && o.startMs > 0) args.push('-ss', (o.startMs / 1000).toFixed(3));
    if (o.durationMs && o.durationMs > 0) args.push('-t', (o.durationMs / 1000).toFixed(3));
    args.push('-i', o.input);
    let inputs = 1;
    let audioIndex = -1;
    let metaIndex = -1;
    if (o.audio) { args.push('-i', o.audio); audioIndex = inputs++; }
    if (o.chaptersFile) { args.push('-i', o.chaptersFile); metaIndex = inputs++; }
    args.push('-map', '0:v:0');
    if (audioIndex >= 0) args.push('-map', `${audioIndex}:a:0`);
    if (metaIndex >= 0) args.push('-map_metadata', String(metaIndex), '-map_chapters', String(metaIndex));
    args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p');
    if (audioIndex >= 0) {
        // Keep the full video length even if the narration is shorter; a longer narration
        // extends the file (the last frame holds), which export warns about beforehand.
        args.push('-c:a', 'aac', '-b:a', '192k');
    }
    args.push('-movflags', '+faststart', o.output);
    run(args);
}

/** High-quality GIF via palettegen/paletteuse at 20fps (verbatim from the original export). */
export function encodeGif(input: string, output: string, o: { startMs?: number; durationMs?: number } = {}): void {
    const args: string[] = ['-y'];
    if (o.startMs && o.startMs > 0) args.push('-ss', (o.startMs / 1000).toFixed(3));
    if (o.durationMs && o.durationMs > 0) args.push('-t', (o.durationMs / 1000).toFixed(3));
    args.push('-i', input, '-vf', 'fps=20,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=sierra2_4a', '-loop', '0', output);
    run(args);
}

/** Cut [startMs, endMs] out of an encoded video into an mp4 or gif clip (re-encoded, frame-accurate). */
export function cutClip(input: string, output: string, startMs: number, endMs: number): void {
    const durationMs = Math.max(100, endMs - startMs);
    if (output.toLowerCase().endsWith('.gif')) {
        encodeGif(input, output, { startMs, durationMs });
        return;
    }
    run(['-y', '-ss', (startMs / 1000).toFixed(3), '-t', (durationMs / 1000).toFixed(3), '-i', input,
        '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output]);
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
