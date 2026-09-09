import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { Step, Timeline } from '../engine/schema';
import { probeDurationMs, run } from './ffmpeg';

/**
 * Text-to-speech: OpenAI `tts-1` when OPENAI_API_KEY is set, otherwise macOS `say`.
 * Per-step clips are cached under <dir>/.cache/tts/<sha1(engine+voice+text)>.<ext>.
 */

export interface VoiceOptions {
    /** OpenAI voice name (alloy, echo, fable, onyx, nova, shimmer). */
    openai?: string;
    /** macOS `say` voice name (e.g. Samantha). */
    say?: string;
}

export interface NarrationClip {
    index: number;
    id: string;
    text: string;
    /** When the clip starts in the video (ms). */
    startMs: number;
    file: string;
    durationMs: number;
}

export function ttsEngine(): 'openai' | 'say' {
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.platform === 'darwin') return 'say';
    throw new Error('narration needs OPENAI_API_KEY (any platform) or macOS `say`');
}

/** Effective narration text of a step: `narration`, falling back to `subtitle`. */
export function narrationOf(step: Step): string | undefined {
    if (typeof step.narration === 'string' && step.narration.trim()) return step.narration.trim();
    if (typeof step.subtitle === 'string' && step.subtitle.trim()) return step.subtitle.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return undefined;
}

async function openaiSpeech(text: string, voice: string, outFile: string): Promise<void> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'tts-1', input: text, voice }),
    });
    if (!response.ok) throw new Error(`OpenAI TTS error ${response.status}: ${await response.text()}`);
    fs.writeFileSync(outFile, Buffer.from(await response.arrayBuffer()));
}

/** One step's narration is seconds of speech; a minute means `say` is wedged, not slow. Bounded for
 *  the same reason as ffmpeg: execFileSync blocks the event loop, so no watchdog here can end it. */
const SAY_TIMEOUT_MS = 60000;

function saySpeech(text: string, voice: string | undefined, outFile: string): void {
    const args = voice ? ['-v', voice] : [];
    // Text goes through stdin so a narration starting with "-" is never parsed as an option.
    execFileSync('say', [...args, '-o', outFile], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: SAY_TIMEOUT_MS });
}

/**
 * Synthesize `text` into `outFile` (extension decides nothing; the engine picks mp3 or aiff and
 * returns the real path). Falls back from OpenAI to `say` on API errors, as the original export did.
 */
export async function synthesize(text: string, voice: VoiceOptions, outBase: string): Promise<string> {
    const engine = ttsEngine();
    if (engine === 'openai') {
        const file = outBase + '.mp3';
        try {
            await openaiSpeech(text, voice.openai || 'alloy', file);
            return file;
        } catch (e: any) {
            if (process.platform !== 'darwin') throw e;
            console.error(`${e.message}\nFalling back to native macOS 'say'...`);
        }
    }
    const file = outBase + '.aiff';
    saySpeech(text, voice.say, file);
    return file;
}

/** Whole-script voiceover (legacy `--voiceover <file>` path). Returns the audio file. */
export async function synthesizeScript(scriptPath: string, voice: VoiceOptions, tempDir: string): Promise<string> {
    const text = fs.readFileSync(path.resolve(scriptPath), 'utf8');
    return synthesize(text, voice, path.join(tempDir, 'voiceover'));
}

export function cacheKey(engine: string, voice: VoiceOptions, text: string): string {
    const v = engine === 'openai' ? (voice.openai || 'alloy') : (voice.say || 'default');
    return createHash('sha1').update(`${engine}\n${v}\n${text}`).digest('hex');
}

/**
 * One clip per narrated step, cached by (engine, voice, text) so re-exports and other
 * locales (different text) only synthesize what changed.
 */
export async function synthesizeSteps(
    timeline: Timeline,
    startMsOf: (step: Step) => number,
    opts: { dir: string; voice?: VoiceOptions; log?: (m: string) => void },
): Promise<NarrationClip[]> {
    const engine = ttsEngine();
    const voice = { ...(timeline.meta.voice || {}), ...(opts.voice || {}) };
    const cacheDir = path.join(opts.dir, '.cache', 'tts');
    fs.mkdirSync(cacheDir, { recursive: true });
    const clips: NarrationClip[] = [];
    for (const step of timeline.steps) {
        const text = narrationOf(step);
        if (!text) continue;
        const base = path.join(cacheDir, cacheKey(engine, voice, text));
        let file = [base + '.mp3', base + '.aiff'].find(f => fs.existsSync(f));
        if (!file) {
            opts.log?.(`  tts step ${step.index}: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
            file = await synthesize(text, voice, base);
        }
        const durationMs = probeDurationMs(file);
        clips.push({ index: step.index, id: step.id, text, startMs: startMsOf(step), file, durationMs });
    }
    return clips;
}

/** Warnings for clips that run into the next narrated step, with exact milliseconds. */
export function narrationOverruns(clips: NarrationClip[], totalMs: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const end = c.startMs + c.durationMs;
        const next = clips[i + 1];
        if (next && end > next.startMs) {
            out.push(`narration for step ${c.index} (${c.durationMs}ms) overruns step ${next.index} at ${next.startMs}ms by ${end - next.startMs}ms`);
        } else if (!next && end > totalMs) {
            out.push(`narration for step ${c.index} (${c.durationMs}ms) runs ${end - totalMs}ms past the end of the video (raise meta.tailMs or --tail)`);
        }
    }
    return out;
}

/** Place every clip at its start time on one track (adelay + amix) and write an AAC .m4a. */
export function mixNarration(clips: NarrationClip[], outFile: string): string {
    if (!clips.length) throw new Error('mixNarration: no clips');
    const args: string[] = ['-y'];
    for (const c of clips) args.push('-i', c.file);
    const delayed = clips.map((c, i) => `[${i}]adelay=${Math.round(c.startMs)}|${Math.round(c.startMs)}[a${i}]`);
    const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[out]`;
    args.push('-filter_complex', `${delayed.join(';')};${mix}`, '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', outFile);
    run(args);
    return outFile;
}
