import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, formatTime } from '../engine/schema';
import { assertReachable } from '../browser';
import { ExportOptions, runExport, LiveSession } from './export';

export interface RecordOptions extends Omit<ExportOptions, 'output'> {
    url?: string;
    storageState?: string;
    output?: string;
}

/**
 * `record <dir> --url <url>`: like `export`, but against a live page. The runtime is injected at
 * document start by the browser context, so real navigations (form submits, links, `navigate`
 * steps) are survived: the driver re-boots the runtime with the cursor at its last point and
 * keeps the clock in Node. `waitFor` steps absorb asynchronous rendering.
 */
export async function recordCommand(dir: string, options: RecordOptions): Promise<void> {
    const tempVideoDir = path.join(dir, '.temp-video');
    try {
        const timeline = loadTimeline(dir, { locale: options.locale });
        const url = options.url || timeline.meta.url;
        if (!url) throw new Error('no URL: pass --url <url> or set meta.url in anim.config.json');
        if (options.storageState && !fs.existsSync(options.storageState)) throw new Error(`storage state file not found: ${options.storageState}`);
        await assertReachable(url);
        const session: LiveSession = { url, storageState: options.storageState, command: 'record' };
        const summary = await runExport(dir, { ...options, output: options.output || 'output.mp4' }, tempVideoDir, session);
        const rel = (p: string) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };
        const navs = summary.results.filter(r => r.navigated).length;
        console.log(`\nSuccess! Recorded ${url} to ${rel(summary.output)} (${formatTime(summary.durationMs)}${navs ? `, ${navs} navigation${navs > 1 ? 's' : ''}` : ''})` +
            (summary.vtt ? `, subtitles ${rel(summary.vtt)}` : '') +
            (summary.chapters ? `, ${summary.chapters} chapters` : '') +
            (summary.narration ? `, narration mixed in` : '') +
            (summary.clips.length ? `, ${summary.clips.length} clips` : '') +
            (summary.guide ? `, guide ${rel(path.dirname(summary.guide))}/` : '') + '.');
    } catch (error: any) {
        console.error(`Record failed: ${error && error.message ? error.message : error}`);
        process.exitCode = 1;
    } finally {
        try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
