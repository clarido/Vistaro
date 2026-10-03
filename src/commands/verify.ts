import * as fs from 'fs';
import * as path from 'path';
import { runExport, ExportOptions } from './export';
import { filmstripCommand } from '../media/filmstrip';
import { Issue, loadTimeline, validateTimeline, formatIssue, resolveConfigPath, cliConfigPath, formatTime } from '../engine/schema';
import { displayPath } from '../catalog';

/**
 * The standard per-variant flags every browser command accepts, threaded straight into the export
 * pass: `verify` must audit the variant an author actually ships (device, locale, --config
 * scenario, viewport, scale), not always the desktop base-locale default.
 */
export type VerifyOptions = Pick<ExportOptions, 'device' | 'locale' | 'config' | 'width' | 'height' | 'scale' | 'theme'>;

/**
 * One row of verify.json `steps`: the timing facts the recording measured, plus the error when
 * the step failed. `actualMs`/`completedMs` are null when the step failed before interacting or
 * before finishing (the driver reports NaN there, which does not survive JSON).
 */
export interface VerifyStep {
    index: number;
    id: string;
    action: string;
    actualMs: number | null;
    completedMs: number | null;
    error?: string;
}

/** The whole audit, exactly the file contract of `verify`: <dir>/verify.json. */
export interface VerifyReport {
    ok: boolean;
    durationMs: number;
    steps: VerifyStep[];
    chapters: number;
    issues: string[];
}

/**
 * `verify <dir>`: the one command an AI agent runs to build AND audit a demo. A thin composition
 * of two existing passes -- the export pipeline (src/commands/export.ts, reused whole: recording,
 * encode, .vtt, chapters, manifest event) and the filmstrip pass (src/media/filmstrip.ts) -- plus
 * a written audit. No encode logic lives here: when `export` changes, `verify` follows.
 *
 * Writes, into the demo directory: verify.mp4 + verify.vtt (as export names them from the output
 * base), verify.strip.png, verify.json ({ ok, durationMs, steps, chapters, issues }). Exits 1 when
 * any step failed, when the timeline has a validation error, or when an artifact is missing.
 */
export async function verifyCommand(outputDir: string, options: VerifyOptions = {}): Promise<void> {
    const videoPath = path.resolve(outputDir, 'verify.mp4');
    const stripPath = path.resolve(outputDir, 'verify.strip.png');
    const jsonPath = path.resolve(outputDir, 'verify.json');
    const issues: string[] = [];
    let errorCount = 0;
    let warnCount = 0;
    let durationMs = 0;
    let chapters = 0;
    let steps: VerifyStep[] = [];
    try {
        // The timeline's own issues land in verify.json even when they are bad enough to stop the
        // build (runExport would refuse on validation errors and print the same lines itself, which
        // is why the pipeline below is skipped once the static pass has errors: the report is the
        // deliverable, not a duplicated throw).
        const configPath = options.config ? path.resolve(options.config) : resolveConfigPath(outputDir);
        if (!fs.existsSync(configPath)) {
            issues.push(`no anim.config.json in ${displayPath(outputDir)}: nothing to audit per step (run \`init-config\`, or use export directly)`);
            errorCount++;
        } else {
            try {
                const staticIssues: Issue[] = validateTimeline(loadTimeline(outputDir, { locale: options.locale, config: cliConfigPath(options.config) }), {});
                issues.push(...staticIssues.map(formatIssue));
                errorCount += staticIssues.filter(i => i.level === 'error').length;
                warnCount += staticIssues.filter(i => i.level === 'warning').length;
            } catch (e: any) {
                issues.push(e?.message ?? String(e));
                errorCount++;
            }
        }
        if (errorCount > 0) {
            issues.push('static validation failed; the export pass was not run');
        } else {
        // The export pipeline, reused whole: only the output name differs (verify.mp4, so the
        // .vtt lands beside it as verify.vtt, the same <base>.vtt rule export applies).
        const tempVideoDir = path.join(outputDir, '.temp-video');
        try {
            const summary = await runExport(outputDir, { ...options, output: videoPath }, tempVideoDir);
            durationMs = summary.durationMs;
            chapters = summary.chapters;
            steps = summary.results.map(r => ({
                index: r.index,
                id: r.id,
                action: r.action,
                actualMs: Number.isFinite(r.actualMs) ? r.actualMs : null,
                completedMs: Number.isFinite(r.completedMs ?? NaN) ? r.completedMs! : null,
                ...(r.error ? { error: r.error } : {}),
            }));
            for (const s of steps) if (s.error) errorCount++;
        } finally {
            try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        // The filmstrip pass on the freshly encoded video: the artifact-level review that
        // page-side previews cannot give, since the MP4 is a separate encode path.
        if (fs.existsSync(videoPath)) {
            await filmstripCommand(videoPath, { output: stripPath });
        } else {
            issues.push(`${displayPath(videoPath)} was not produced; the filmstrip pass did not run`);
            errorCount++;
        }
        }
    } catch (e: any) {
        issues.push(e?.message ?? String(e));
        errorCount++;
    }
    const ok = errorCount === 0 && fs.existsSync(videoPath) && fs.existsSync(stripPath);
    const report: VerifyReport = { ok, durationMs, steps, chapters, issues };
    let wroteReport = true;
    try {
        fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
    } catch (e: any) {
        // A missing/unwritable directory must not replace the audit with a stack trace: the
        // summary below still says everything the report would have.
        wroteReport = false;
        console.error(`verify: could not write ${displayPath(jsonPath)}: ${e?.message ?? e}`);
    }

    // One-screen summary: the audit an agent reads instead of watching the video.
    const ms = (n: number | null) => (n === null ? '-' : String(n));
    const lines: string[] = [];
    lines.push('');
    lines.push(`Verify ${displayPath(outputDir)}: ${steps.length} step(s), ${formatTime(durationMs)}, ${chapters} chapter(s).`);
    for (const s of steps) {
        lines.push(`  ${String(s.index).padStart(2)}  ${s.action.padEnd(16)} ${s.id.padEnd(14)} actual ${ms(s.actualMs).padStart(6)}ms  completed ${ms(s.completedMs).padStart(6)}ms${s.error ? `  FAILED: ${s.error}` : ''}`);
    }
    lines.push(`  video   ${displayPath(videoPath)}${fs.existsSync(videoPath) ? '' : '  (missing)'}`);
    if (fs.existsSync(stripPath)) lines.push(`  strip   ${displayPath(stripPath)}`);
    lines.push(`  report  ${displayPath(jsonPath)}${wroteReport ? '' : '  (could not be written)'}`);
    for (const issue of issues) lines.push(`  issue   ${issue}`);
    if (ok && wroteReport) {
        lines.push(`OK: every step ran, no errors${warnCount ? ` (${warnCount} warning(s) above and in verify.json)` : ''}.`);
    } else {
        lines.push(`FAILED: ${errorCount} error(s)${steps.length ? `, ${steps.filter(s => s.error).length} failed step(s)` : ''}; details above and in ${displayPath(jsonPath)}.`);
    }
    console.log(lines.join('\n'));
    process.exitCode = ok && wroteReport ? 0 : 1;
}
