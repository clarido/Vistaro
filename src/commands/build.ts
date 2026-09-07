import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, validateTimeline, formatIssue, hasErrors, computeDurationMs, formatTime } from '../engine/schema';
import { buildAnimatedHtml } from '../engine/inject';
import { recordEvent } from '../manifest';

export interface BuildOptions {
    cursor?: string;
    loop?: boolean;
    locale?: string;
    force?: boolean;
    /** Write somewhere other than <dir>/animated.html. */
    output?: string;
}

/**
 * `build <dir>`: index.html + anim.config.json -> animated.html, no LLM involved.
 * Validation errors abort with exit code 1 unless --force.
 */
export function buildCommand(dir: string, options: BuildOptions = {}): void {
    const htmlPath = path.resolve(dir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        console.error(`Error: ${htmlPath} not found. Write the UI markup to index.html first.`);
        process.exit(1);
    }

    let timeline;
    try {
        timeline = loadTimeline(dir, { locale: options.locale });
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    const issues = validateTimeline(timeline);
    for (const issue of issues) console.error(formatIssue(issue));
    if (hasErrors(issues)) {
        const n = issues.filter(i => i.level === 'error').length;
        if (!options.force) {
            console.error(`\nBuild aborted: ${n} error(s) in ${path.resolve(dir, 'anim.config.json')} (use --force to build anyway).`);
            process.exit(1);
        }
        console.error(`\n--force: building despite ${n} error(s); those steps will be skipped at playback.`);
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const out = buildAnimatedHtml(html, timeline, { cursor: options.cursor, loop: !!options.loop });
    const outPath = options.output ? path.resolve(options.output) : path.join(dir, 'animated.html');
    fs.writeFileSync(outPath, out, 'utf8');

    const cursor = options.cursor ?? timeline.meta.cursor ?? 'mac';
    recordEvent(dir, { command: 'build', cursor, loop: !!options.loop, locale: timeline.locale ?? options.locale ?? timeline.meta.locale, force: !!options.force, output: path.relative(path.resolve(dir), outPath).split(path.sep).join('/') });

    const durationMs = computeDurationMs(timeline);
    console.log(`Built ${outPath} (${timeline.steps.length} steps, ${formatTime(durationMs)} total, cursor: ${cursor}${options.loop ? ', loop' : ''}).`);
    console.log(`Next: npx tsx cli.ts preview ${dir}   # contact sheet of every step`);
    console.log(`      npx tsx cli.ts export ${dir} -o demo.mp4 --guide   # length from the timeline (${formatTime(durationMs)})`);
}
