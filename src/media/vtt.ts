import { Step, Timeline, SUBTITLE_HOLD_MS, SUBTITLE_MIN_MS } from '../engine/schema';

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
 * Subtitle cues using the same rule as the in-page subtitles (until the next subtitle,
 * else +4s, never under 1s), anchored on the given start times (actual interaction times
 * during export; scheduled times otherwise).
 */
export function subtitleCues(timeline: Timeline, startMsOf: (step: Step) => number = s => s.timeMs): Cue[] {
    const subs = timeline.steps.filter(s => s.subtitle && Number.isFinite(startMsOf(s)));
    return subs.map((s, i) => {
        const startMs = startMsOf(s);
        const nextMs = i + 1 < subs.length ? startMsOf(subs[i + 1]) : startMs + SUBTITLE_HOLD_MS;
        const endMs = startMs + Math.max(SUBTITLE_MIN_MS, nextMs - startMs);
        return { index: s.index, id: s.id, startMs, endMs, text: plainText(String(s.subtitle)) };
    });
}

export function buildVtt(cues: Cue[]): string {
    const lines = ['WEBVTT', ''];
    for (const c of cues) {
        lines.push(String(c.id), `${vttTime(c.startMs)} --> ${vttTime(c.endMs)}`, c.text, '');
    }
    return lines.join('\n');
}
