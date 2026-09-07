import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { readCatalog, resolveLocaleDir, writeIndex, hashGuideDir, toolVersion, Catalog, CatalogGuide, IndexEntry, IndexJson, CatalogOutput } from '../catalog';
import { loadTimeline } from '../engine/schema';
import { readManifest, setManifestFields, recordEvent } from '../manifest';
import { keepPreviousFrames, diffGuideFrames } from '../guide/diff';

export interface BuildAllOptions {
    changedOnly?: boolean;
    diff?: boolean;
    diffThreshold?: string | number;
    only?: string;
    locale?: string;
    continueOnError?: boolean;
    /** Print the commands instead of running them. */
    dryRun?: boolean;
}

interface StepRun { cmd: string[]; status: number | null; stdout: string; stderr: string; ms: number }

/**
 * Run one CLI command as a child process (no shell, so no pipeline can mask an exit status), and
 * return its status and output. Every artifact is asserted on disk afterwards, never inferred.
 */
function runCli(args: string[], cwd: string): Promise<StepRun> {
    return new Promise((resolve) => {
        const started = Date.now();
        // The tsx loader by absolute path: `--import tsx` would be resolved from `cwd` (the catalog directory).
        const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(__dirname, '..', '..', 'cli.ts'), ...args], { cwd, env: process.env });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (status) => resolve({ cmd: args, status, stdout, stderr, ms: Date.now() - started }));
        child.on('error', (e) => resolve({ cmd: args, status: -1, stdout, stderr: stderr + String(e), ms: Date.now() - started }));
    });
}

function tail(s: string, n = 6): string {
    return s.trim().split('\n').filter(l => l.trim()).slice(-n).join(' | ');
}

/**
 * `build-all [catalog]`: for every guide × locale in help.catalog.json run
 * check → build → export|record (--guide, and clips/narration per outputs) into
 * <outputDir>/<slug>/<locale>/, write index.json + index.md, exit 1 on any failure.
 * --changed-only skips guides whose sources hash to what the manifest recorded for that locale;
 * --diff keeps the previous step frames and marks a guide stale when a frame changed beyond the threshold.
 */
export async function buildAllCommand(catalogFile: string | undefined, options: BuildAllOptions = {}): Promise<void> {
    const file = catalogFile || 'help.catalog.json';
    let catalog: Catalog;
    try {
        catalog = readCatalog(file, m => console.error(`warning  ${m}`));
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
        return;
    }
    const threshold = options.diffThreshold !== undefined ? parseFloat(String(options.diffThreshold)) : 0.02;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        console.error(`Error: --diff-threshold must be a fraction between 0 and 1 (got ${options.diffThreshold})`);
        process.exitCode = 1;
        return;
    }
    const catalogDir = path.dirname(catalog.file!);
    const entries: IndexEntry[] = [];
    let failed = 0;
    let stop = false;

    for (const guide of catalog.guides) {
        if (stop) break;
        if (options.only && guide.slug !== options.only) continue;
        const defaults = catalog.defaults || {};
        const outputs: CatalogOutput[] = guide.outputs || defaults.outputs || ['video', 'guide'];
        const baseTimeline = (() => { try { return loadTimeline(guide.dir); } catch { return undefined; } })();
        const baseLocale = baseTimeline?.baseLocale || baseTimeline?.locale || 'en';
        // Locales to produce: the guide's list (or map keys), else the catalog defaults, else the base locale only.
        const listed: string[] = Array.isArray(guide.locales) ? guide.locales : guide.locales ? Object.keys(guide.locales) : (defaults.locales || [baseLocale]);
        const locales = [...new Set(listed)].filter(l => !options.locale || l === options.locale);
        for (const locale of locales) {
            if (stop) break;
            const entry: IndexEntry = {
                slug: guide.slug, locale, title: (guide as any).title || baseTimeline?.meta.title,
                dir: path.relative(catalogDir, guide.dir).split(path.sep).join('/'),
                output: `${guide.slug}/${locale}`, status: 'failed',
            };
            entries.push(entry);
            const started = Date.now();
            const srcDir = resolveLocaleDir(guide, locale, baseLocale);
            if (!srcDir) {
                entry.error = `no directory for locale "${locale}" (run \`localize ${entry.dir} ${locale}\`)`;
                failed++;
                console.error(`✗ ${guide.slug}/${locale}: ${entry.error}`);
                if (!options.continueOnError) stop = true;
                continue;
            }
            const outDir = path.join(catalog.outputDir, guide.slug, locale);
            const contentHash = hashGuideDir(srcDir);
            entry.contentHash = contentHash;
            const manifest = readManifest(srcDir);
            const recorded = manifest.contentHash && typeof manifest.contentHash === 'object' ? manifest.contentHash[locale] : undefined;
            if (options.changedOnly && recorded === contentHash && fs.existsSync(path.join(outDir, 'guide', 'guide.json'))) {
                entry.status = 'skipped';
                entry.guide = `${guide.slug}/${locale}/guide/guide.json`;
                const prev = JSON.parse(fs.readFileSync(path.join(outDir, 'guide', 'guide.json'), 'utf8'));
                if (prev.video?.file) entry.video = path.join(guide.slug, locale, 'guide', prev.video.file).split(path.sep).join('/');
                entry.durationMs = prev.video?.durationMs;
                entry.steps = prev.steps?.length;
                console.log(`= ${guide.slug}/${locale}: unchanged (${contentHash.slice(0, 19)}…), skipped`);
                continue;
            }
            fs.mkdirSync(outDir, { recursive: true });
            const guideDir = path.join(outDir, 'guide');
            const previousDir = path.join(guideDir, '.previous');
            if (options.diff) keepPreviousFrames(path.join(guideDir, 'assets'), previousDir);

            const videoFile = path.join(outDir, `${guide.slug}-${locale}.mp4`);
            const viewport: string[] = [];
            const width = guide.width ?? defaults.width; const height = guide.height ?? defaults.height; const theme = guide.theme ?? defaults.theme;
            if (width) viewport.push('--width', String(width));
            if (height) viewport.push('--height', String(height));
            if (theme) viewport.push('--theme', theme);
            const narration = guide.narration ?? defaults.narration ?? false;
            const plan: string[][] = [
                ['check', srcDir, '--locale', locale, ...viewport],
                ...(guide.record ? [] : [['build', srcDir, '--locale', locale]]),
            ];
            const produce: string[] = guide.record
                ? ['record', srcDir, '--url', guide.record.url, ...(guide.record.storageState ? ['--storage-state', path.resolve(catalogDir, guide.record.storageState)] : []), ...(guide.record.ignoreHttpsErrors ? ['--ignore-https-errors'] : [])]
                : ['export', srcDir];
            produce.push('-o', videoFile, '--locale', locale, ...viewport);
            if (outputs.includes('guide')) {
                produce.push('--guide', '--guide-dir', guideDir);
                if (defaults.crop === false) produce.push('--no-crop'); else if (typeof defaults.crop === 'number') produce.push('--crop', String(defaults.crop));
                if (defaults.hideCursor) produce.push('--hide-cursor');
            }
            if (outputs.includes('clips')) produce.push('--clips', 'mp4');
            if (narration) produce.push('--narration');
            plan.push(produce);

            if (options.dryRun) {
                console.log(`${guide.slug}/${locale}:\n  ${plan.map(p => 'anim-cli ' + p.join(' ')).join('\n  ')}`);
                entry.status = 'skipped';
                continue;
            }

            let error: string | undefined;
            for (const args of plan) {
                console.log(`→ ${guide.slug}/${locale}: ${args[0]}`);
                const run = await runCli(args, catalogDir);
                if (run.status !== 0) { error = `${args[0]} exited ${run.status}: ${tail(run.stderr) || tail(run.stdout)}`; break; }
            }
            // Write-then-assert: the artifacts must exist, whatever the exit status said.
            if (!error && !fs.existsSync(videoFile)) error = `${produce[0]} reported success but ${path.relative(catalogDir, videoFile)} is missing`;
            if (!error && outputs.includes('guide') && !fs.existsSync(path.join(guideDir, 'guide.json'))) error = `guide.json missing in ${path.relative(catalogDir, guideDir)}`;
            entry.ms = Date.now() - started;
            if (error) {
                entry.status = 'failed';
                entry.error = error;
                failed++;
                console.error(`✗ ${guide.slug}/${locale}: ${error}`);
                if (!options.continueOnError) stop = true;
                continue;
            }
            entry.status = 'ok';
            if (outputs.includes('video')) entry.video = `${guide.slug}/${locale}/${path.basename(videoFile)}`;
            if (outputs.includes('guide')) {
                entry.guide = `${guide.slug}/${locale}/guide/guide.json`;
                const g = JSON.parse(fs.readFileSync(path.join(guideDir, 'guide.json'), 'utf8'));
                entry.steps = g.steps?.length;
                entry.durationMs = g.video?.durationMs;
                if (options.diff) {
                    const d = diffGuideFrames(path.join(guideDir, 'assets'), previousDir);
                    if (d.compared) {
                        entry.diff = { maxFraction: d.maxFraction, threshold, steps: d.steps };
                        entry.stale = d.maxFraction > threshold;
                        if (entry.stale) console.error(`warning  ${guide.slug}/${locale}: frames changed (max ${(d.maxFraction * 100).toFixed(2)}% of pixels > ${(threshold * 100).toFixed(2)}%); previous frames and step-NN.diff.png kept in ${path.relative(catalogDir, previousDir)}`);
                    }
                }
            }
            if (!entry.durationMs) { try { entry.durationMs = readManifest(srcDir).history.slice().reverse().find(h => h.command === 'export' || h.command === 'record')?.duration * 1000; } catch { /* ignore */ } }
            // Remember what was built for --changed-only (per locale, keyed by the locale dir's own hash).
            const hashes = { ...(manifest.contentHash && typeof manifest.contentHash === 'object' ? manifest.contentHash : {}), [locale]: contentHash };
            setManifestFields(srcDir, { contentHash: hashes });
            recordEvent(srcDir, { command: 'build-all', catalog: path.relative(srcDir, catalog.file!).split(path.sep).join('/'), locale, output: path.relative(srcDir, outDir).split(path.sep).join('/'), contentHash, stale: entry.stale });
            console.log(`✓ ${guide.slug}/${locale}${entry.stale ? ' (stale: frames changed)' : ''} in ${((entry.ms || 0) / 1000).toFixed(1)}s`);
        }
    }

    const index: IndexJson = { version: 1, generatedAt: new Date().toISOString(), tool: toolVersion(), catalog: path.relative(catalog.outputDir, catalog.file!).split(path.sep).join('/'), guides: entries };
    const written = writeIndex(catalog.outputDir, index);
    const ok = entries.filter(e => e.status === 'ok').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;
    const stale = entries.filter(e => e.stale).length;
    console.log(`\n${ok} built, ${skipped} skipped, ${failed} failed${stale ? `, ${stale} stale` : ''}. Index: ${path.relative(process.cwd(), written.json) || written.json}`);
    if (failed) process.exitCode = 1;
}
