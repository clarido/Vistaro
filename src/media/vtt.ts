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
    // &amp; LAST: decoded first it would turn &amp;lt; into &lt; and then into a literal <,
    // double-decoding text the author escaped to show as-is (and cue markup in the player).
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
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

/**
 * A plain-text transcript beside the .vtt, for accessibility and search: the title, then per step
 * in order its timestamp, its guide title (the chapter heading) and what is said or shown -- the
 * narration when the step has one, else its subtitle. Steps with neither title nor words are left
 * out. Timestamps use the measured interaction moments, like the cues.
 */
export function buildTranscript(timeline: Timeline, startMsOf: (step: Step) => number = s => s.timeMs, durationMs?: number): string {
    const lines: string[] = [];
    if (timeline.meta?.title) lines.push(String(timeline.meta.title), '');
    const clock = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    for (const s of timeline.steps) {
        const at = startMsOf(s);
        if (!Number.isFinite(at) || (durationMs !== undefined && at >= durationMs)) continue;
        const title = typeof s.title === 'string' && s.title.trim() && s.guide !== false ? s.title.trim() : '';
        const words = typeof s.narration === 'string' && s.narration.trim() ? s.narration : (typeof s.subtitle === 'string' ? s.subtitle : '');
        const text = words ? plainText(words) : '';
        if (!title && !text) continue;
        lines.push(`[${clock(at)}]${title ? ' ' + title : ''}`);
        if (text) lines.push(text);
        lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
}
