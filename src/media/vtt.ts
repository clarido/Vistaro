import { Step, Timeline, subtitleWindows } from '../engine/schema';

export interface Cue {
    index: number;
    id: string;
    startMs: number;
    endMs: number;
    text: string;
}

export function vttTime(ms: number): string {
    const t = Math.max(0, Math.round(ms));
    const h = Math.floor(t / 3600000);
    const m = Math.floor((t % 3600000) / 60000);
    const s = Math.floor((t % 60000) / 1000);
    const f = t % 1000;
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f, 3)}`;
}

function plainText(html: string): string {
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

/**
 * Subtitle cues: the in-page subtitle windows (schema.subtitleWindows) anchored on the given start
 * times (actual interaction times during export), clamped to `durationMs`, with HTML stripped.
 */
export function subtitleCues(timeline: Timeline, startMsOf: (step: Step) => number = s => s.timeMs, durationMs?: number): Cue[] {
    return subtitleWindows(timeline, startMsOf, durationMs).map(w => ({ ...w, text: plainText(w.text) }));
}

export function buildVtt(cues: Cue[]): string {
    const lines = ['WEBVTT', ''];
    for (const c of cues) {
        lines.push(String(c.id), `${vttTime(c.startMs)} --> ${vttTime(c.endMs)}`, c.text, '');
    }
    return lines.join('\n');
}
