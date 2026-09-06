import { Step, Timeline } from '../engine/schema';

export interface Chapter {
    index: number;
    id: string;
    startMs: number;
    endMs: number;
    title: string;
}

/** One chapter per titled step: from its (actual) start to the next titled step or the end of the video. */
export function chaptersFor(timeline: Timeline, durationMs: number, startMsOf: (step: Step) => number = s => s.timeMs): Chapter[] {
    const titled = timeline.steps.filter(s => typeof s.title === 'string' && s.title.trim() && Number.isFinite(startMsOf(s)));
    const out: Chapter[] = [];
    for (let i = 0; i < titled.length; i++) {
        const s = titled[i];
        const startMs = Math.max(0, Math.round(startMsOf(s)));
        if (startMs >= durationMs) continue; // past the end of a shortened export
        const endMs = Math.min(Math.round(i + 1 < titled.length ? startMsOf(titled[i + 1]) : durationMs), Math.round(durationMs));
        if (endMs <= startMs) continue;
        out.push({ index: s.index, id: s.id, startMs, endMs, title: s.title!.trim() });
    }
    return out;
}

function escapeMeta(s: string): string {
    return s.replace(/([=;#\\])/g, '\\$1').replace(/\n/g, ' ');
}

/** ffmetadata document with [CHAPTER] blocks (TIMEBASE 1/1000). */
export function ffmetadata(chapters: Chapter[], title?: string): string {
    const lines = [';FFMETADATA1'];
    if (title) lines.push(`title=${escapeMeta(title)}`);
    for (const c of chapters) {
        lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.startMs}`, `END=${c.endMs}`, `title=${escapeMeta(c.title)}`);
    }
    return lines.join('\n') + '\n';
}
