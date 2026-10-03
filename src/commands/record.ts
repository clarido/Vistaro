import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, cliConfigPath } from '../engine/schema';
import { assertReachable, sanitizeUrl } from '../browser';
import { ExportOptions, runExport, LiveSession, reportOutcome } from './export';
import { displayPath } from '../catalog';

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
        const timeline = loadTimeline(dir, { locale: options.locale, config: cliConfigPath(options.config) });
        const url = options.url || timeline.meta.url;
        if (!url) throw new Error('no URL: pass --url <url> or set meta.url in anim.config.json');
        if (options.storageState && !fs.existsSync(options.storageState)) throw new Error(`storage state file not found: ${options.storageState}`);
        await assertReachable(url, { ignoreHttpsErrors: options.ignoreHttpsErrors });
        const session: LiveSession = { url, storageState: options.storageState, command: 'record', timeline };
        const summary = await runExport(dir, { ...options, output: options.output || 'output.mp4' }, tempVideoDir, session);
        const navs = summary.results.filter(r => r.navigated).length;
        // The outcome line runs first even when --learn captured nothing: it carries the failed-step
        // summary (and exit 1) that would otherwise be swallowed by the early return.
        reportOutcome(`Recorded ${sanitizeUrl(url)} to`, summary, navs ? `, ${navs} navigation${navs > 1 ? 's' : ''}` : '');
        if (summary.learn && summary.learn.steps === 0) {
            // The recording succeeded but taught nothing: the requested artifact does not exist.
            // Reported after the outcome line, and exit 1 (the video itself is still on disk).
            console.error(`--learn: nothing was captured: the recording ran no successful click/type/press/navigate step, so there is no interaction to learn; no draft timeline was written.`);
            process.exitCode = 1;
            return;
        }
        if (summary.learn?.output) {
            console.log(`--learn: ${summary.learn.steps} interaction(s) -> ${displayPath(summary.learn.output)} (+ ${displayPath(summary.learn.notes!)}); a draft with no titles -- add them (and meta.title) before building a guide from it.`);
        }
    } catch (error: any) {
        console.error(`Record failed: ${error && error.message ? error.message : error}`);
        process.exitCode = 1;
    } finally {
        try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}
