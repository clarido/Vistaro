import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { readCatalog, locateLocaleDir, relPosix, writeIndex, readIndex, mergeIndexEntries, hashGuideDir, toolVersion, effectiveSettings, Catalog, CatalogGuide, EffectiveSettings, IndexEntry, IndexJson } from '../catalog';
import { loadTimeline } from '../engine/schema';
import { readManifest, setManifestFields, recordEvent } from '../manifest';
import { keepPreviousFrames, diffGuideFrames } from '../guide/diff';
import { encodeGif } from '../media/ffmpeg';

export interface BuildAllOptions {
    changedOnly?: boolean;
    diff?: boolean;
    diffThreshold?: string | number;
    only?: string;
    locale?: string;
    continueOnError?: boolean;
    /** Print the plan instead of running it: nothing is created, written or recorded. */
    dryRun?: boolean;
    /** Also stream the children's stdout (stderr is always streamed, prefixed with slug/locale). */
    verbose?: boolean;
}

interface StepRun { cmd: string[]; status: number | null; stdout: string; stderr: string; ms: number }

/**
 * What --changed-only compares: the sources of the locale dir, the effective render settings that
 * shape the output (viewport, theme, crop, cursor, narration, extras, record target) and the tool
 * version. Stored as manifest.buildKey[locale] beside contentHash[locale].
 */
export function buildKeyFor(contentHash: string, settings: EffectiveSettings, record: CatalogGuide['record'], tool = toolVersion()): string {
    const facts = {
        contentHash, tool,
        width: settings.width, height: settings.height, theme: settings.theme, crop: settings.crop,
        hideCursor: settings.hideCursor, narration: settings.narration, outputs: [...settings.outputs].sort(),
        record: record ? { url: record.url, ignoreHttpsErrors: !!record.ignoreHttpsErrors, storageState: !!record.storageState } : undefined,
    };
    return 'sha256:' + createHash('sha256').update(JSON.stringify(facts, Object.keys(facts).sort())).digest('hex');
}

/**
 * Run one CLI command as a child process (no shell, so no pipeline can mask an exit status), and
 * return its status and output. Every artifact is asserted on disk afterwards, never inferred.
 * stderr is streamed live with a `slug/locale:` prefix (stdout too with --verbose) so a long
 * export is not a silent wait.
 */
function runCli(args: string[], cwd: string, prefix: string, verbose: boolean): Promise<StepRun> {
    return new Promise((resolve) => {
        const started = Date.now();
        // The tsx loader by absolute path: `--import tsx` would be resolved from `cwd` (the catalog directory).
        const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(__dirname, '..', '..', 'cli.ts'), ...args], { cwd, env: process.env });
        let stdout = '', stderr = '';
        const stream = (to: NodeJS.WriteStream) => {
            let pending = '';
            return (chunk: Buffer | string) => {
                pending += chunk;
                const lines = pending.split('\n');
                pending = lines.pop() || '';
                for (const l of lines) if (l.trim()) to.write(`  ${prefix}: ${l}\n`);
            };
        };
        const outStream = verbose ? stream(process.stdout) : undefined;
        const errStream = stream(process.stderr);
        child.stdout.on('data', d => { stdout += d; outStream?.(d); });
        child.stderr.on('data', d => { stderr += d; errStream(d); });
        child.on('close', (status) => resolve({ cmd: args, status, stdout, stderr, ms: Date.now() - started }));
        child.on('error', (e) => resolve({ cmd: args, status: -1, stdout, stderr: stderr + String(e), ms: Date.now() - started }));
    });
}

function tail(s: string, n = 6): string {
    return s.trim().split('\n').filter(l => l.trim()).slice(-n).join(' | ');
}

/** Links (relative to outputDir) for whatever of a guide × locale's outputs exist on disk. */
function linksOnDisk(entry: IndexEntry, outDir: string, videoFile: string): void {
    const rel = (file: string) => `${entry.output}/${relPosix(outDir, file)}`;
    const guideDir = path.join(outDir, 'guide');
    const vtt = videoFile.replace(/\.mp4$/i, '.vtt');
    const gif = videoFile.replace(/\.mp4$/i, '.gif');
    if (fs.existsSync(videoFile)) entry.video = rel(videoFile);
    if (fs.existsSync(vtt)) entry.vtt = rel(vtt);
    if (fs.existsSync(gif)) entry.gif = rel(gif);
    if (fs.existsSync(path.join(guideDir, 'guide.json'))) {
        entry.guide = rel(path.join(guideDir, 'guide.json'));
        if (fs.existsSync(path.join(guideDir, 'guide.md'))) entry.guideMd = rel(path.join(guideDir, 'guide.md'));
        if (fs.existsSync(path.join(guideDir, 'guide.html'))) entry.guideHtml = rel(path.join(guideDir, 'guide.html'));
        if (fs.existsSync(path.join(guideDir, 'assets', 'poster.png'))) entry.poster = rel(path.join(guideDir, 'assets', 'poster.png'));
        try {
            const g = JSON.parse(fs.readFileSync(path.join(guideDir, 'guide.json'), 'utf8'));
            entry.steps = g.steps?.length;
            if (typeof g.video?.durationMs === 'number') entry.durationMs = g.video.durationMs;
        } catch { /* a guide.json that does not parse is caught by the assert below */ }
    }
}

/**
 * `build-all [catalog]`: for every guide × locale in help.catalog.json run
 * check → build → export|record (--guide and the other extras per outputs) into
 * <outputDir>/<slug>/<locale>/, merge the results into index.json + index.md, exit 1 on any failure.
 * --changed-only skips guides whose build key (sources + settings + tool) matches the manifest;
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
    const defaults = catalog.defaults || {};

    // The full guide × locale set of the catalog (before --only/--locale): the index keeps exactly these.
    const planned: { guide: CatalogGuide; locale: string; baseLocale: string; title?: string }[] = [];
    for (const guide of catalog.guides) {
        const baseTimeline = (() => { try { return loadTimeline(guide.dir); } catch { return undefined; } })();
        const baseLocale = baseTimeline?.baseLocale || baseTimeline?.locale || 'en';
        const listed: string[] = Array.isArray(guide.locales) ? guide.locales : guide.locales ? Object.keys(guide.locales) : (defaults.locales || [baseLocale]);
        for (const locale of new Set(listed)) planned.push({ guide, locale, baseLocale, title: guide.title || baseTimeline?.meta.title });
    }
    const selected = planned.filter(p => (!options.only || p.guide.slug === options.only) && (!options.locale || p.locale === options.locale));
    if (!selected.length) {
        const why = [options.only ? `--only ${options.only}` : '', options.locale ? `--locale ${options.locale}` : ''].filter(Boolean).join(' ');
        console.error(`Error: ${why || 'the catalog'} matches no guide × locale (guides: ${catalog.guides.map(g => g.slug).join(', ')}; locales: ${[...new Set(planned.map(p => p.locale))].join(', ')})`);
        process.exitCode = 1;
        return;
    }

    const entries: IndexEntry[] = [];
    let failed = 0;
    let stop = false;
    for (const { guide, locale, baseLocale, title } of selected) {
        if (stop) break;
        const settings = effectiveSettings(guide, defaults);
        const outputs = settings.outputs;
        const entry: IndexEntry = {
            slug: guide.slug, locale, title,
            dir: relPosix(catalogDir, guide.dir),
            output: `${guide.slug}/${locale}`, status: 'failed',
        };
        entries.push(entry);
        const started = Date.now();
        const located = locateLocaleDir(guide, locale, baseLocale);
        if (!located.dir) {
            const explicit = guide.locales && !Array.isArray(guide.locales) && guide.locales[locale];
            entry.error = explicit ? located.error : `${located.error} (run \`localize ${entry.dir} ${locale}\`)`;
            failed++;
            console.error(`✗ ${guide.slug}/${locale}: ${entry.error}`);
            if (!options.continueOnError) stop = true;
            continue;
        }
        const srcDir = located.dir;
        const outDir = path.join(catalog.outputDir, guide.slug, locale);
        const guideDir = path.join(outDir, 'guide');
        const previousDir = path.join(guideDir, '.previous');
        const videoFile = path.join(outDir, `${guide.slug}-${locale}.mp4`);
        const gifFile = videoFile.replace(/\.mp4$/, '.gif');

        // The plan is computed before anything touches the disk, so a dry run can print it and stop.
        const viewport: string[] = [];
        if (settings.width) viewport.push('--width', String(settings.width));
        if (settings.height) viewport.push('--height', String(settings.height));
        if (settings.theme) viewport.push('--theme', settings.theme);
        // Record guides have no local page: check validates the live timeline (no probe), build is skipped.
        const plan: string[][] = [
            ['check', srcDir, '--locale', locale, ...(guide.record ? ['--live'] : viewport)],
            ...(guide.record ? [] : [['build', srcDir, '--locale', locale]]),
        ];
        const produce: string[] = guide.record
            ? ['record', srcDir, '--url', guide.record.url, ...(guide.record.storageState ? ['--storage-state', guide.record.storageState] : []), ...(guide.record.ignoreHttpsErrors ? ['--ignore-https-errors'] : [])]
            : ['export', srcDir];
        produce.push('-o', videoFile, '--locale', locale, ...viewport);
        if (outputs.includes('guide')) {
            produce.push('--guide', '--guide-dir', guideDir);
            if (settings.crop === false) produce.push('--no-crop'); else if (typeof settings.crop === 'number') produce.push('--crop', String(settings.crop));
            if (settings.hideCursor) produce.push('--hide-cursor');
        }
        if (outputs.includes('clips')) produce.push('--clips', 'mp4');
        if (settings.narration) produce.push('--narration');
        plan.push(produce);
        if (outputs.includes('gif')) plan.push(['gif', videoFile, gifFile]);
        if (options.diff && !outputs.includes('guide')) console.error(`warning  ${guide.slug}/${locale}: --diff compares guide frames, but "guide" is not among this guide's outputs; nothing to compare`);

        // What --changed-only compares.
        const contentHash = hashGuideDir(srcDir);
        const buildKey = buildKeyFor(contentHash, settings, guide.record);
        entry.contentHash = contentHash;
        entry.buildKey = buildKey;
        const manifest = readManifest(srcDir);
        const recordedKey = manifest.buildKey && typeof manifest.buildKey === 'object' ? manifest.buildKey[locale] : undefined;
        const recordedHash = manifest.contentHash && typeof manifest.contentHash === 'object' ? manifest.contentHash[locale] : undefined;
        let unchanged: string | undefined;
        if (options.changedOnly) {
            if (recordedKey === buildKey && fs.existsSync(videoFile)) unchanged = `unchanged (${contentHash.slice(0, 19)}…)`;
            else if (recordedKey && recordedHash === contentHash) console.log(`~ ${guide.slug}/${locale}: sources unchanged but the render settings or tool changed, rebuilding`);
        }

        if (options.dryRun) {
            // Print only: no output tree, no index, no manifest entry.
            entry.status = 'skipped';
            if (unchanged) { console.log(`${guide.slug}/${locale}: ${unchanged}, would be skipped`); continue; }
            console.log(`${guide.slug}/${locale}:\n  ${plan.map(p => (p[0] === 'gif' ? `ffmpeg ${path.relative(catalogDir, p[1])} -> ${path.relative(catalogDir, p[2])}` : 'anim-cli ' + p.join(' '))).join('\n  ')}`);
            continue;
        }
        if (unchanged) {
            entry.status = 'skipped';
            linksOnDisk(entry, outDir, videoFile);
            // The last build of this locale tells when it was built and whether --diff found it stale.
            const last = manifest.history.slice().reverse().find(h => h.command === 'build-all' && h.locale === locale);
            if (last) { entry.builtAt = last.builtAt || last.timestamp; if (typeof last.stale === 'boolean') entry.stale = last.stale; }
            console.log(`= ${guide.slug}/${locale}: ${unchanged}, skipped`);
            continue;
        }
        fs.mkdirSync(outDir, { recursive: true });
        if (options.diff) keepPreviousFrames(path.join(guideDir, 'assets'), previousDir);

        let error: string | undefined;
        for (const args of plan) {
            console.log(`→ ${guide.slug}/${locale}: ${args[0]}`);
            if (args[0] === 'gif') {
                // The GIF is cut from the encoded MP4 in-process: no second recording.
                try { encodeGif(args[1], args[2]); } catch (e: any) { error = `gif: ${e.message || e}`; break; }
                continue;
            }
            const run = await runCli(args, catalogDir, `${guide.slug}/${locale}`, !!options.verbose);
            if (run.status !== 0) { error = `${args[0]} exited ${run.status}: ${tail(run.stderr) || tail(run.stdout)}`; break; }
        }
        // Write-then-assert: the artifacts must exist, whatever the exit status said.
        if (!error && !fs.existsSync(videoFile)) error = `${produce[0]} reported success but ${path.relative(catalogDir, videoFile)} is missing`;
        if (!error && outputs.includes('guide') && !fs.existsSync(path.join(guideDir, 'guide.json'))) error = `guide.json missing in ${path.relative(catalogDir, guideDir)}`;
        if (!error && outputs.includes('gif') && !fs.existsSync(gifFile)) error = `${path.relative(catalogDir, gifFile)} is missing`;
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
        entry.builtAt = new Date().toISOString();
        linksOnDisk(entry, outDir, videoFile);
        if (outputs.includes('guide') && options.diff) {
            const d = diffGuideFrames(path.join(guideDir, 'assets'), previousDir);
            if (d.compared) {
                entry.diff = { maxFraction: d.maxFraction, threshold, steps: d.steps };
                entry.stale = d.maxFraction > threshold;
                if (entry.stale) console.error(`warning  ${guide.slug}/${locale}: frames changed (max ${(d.maxFraction * 100).toFixed(2)}% of pixels > ${(threshold * 100).toFixed(2)}%); previous frames and step-NN.diff.png kept in ${path.relative(catalogDir, previousDir)}`);
            }
        }
        if (entry.durationMs === undefined) {
            const ev = readManifest(srcDir).history.slice().reverse().find(h => (h.command === 'export' || h.command === 'record') && typeof h.duration === 'number');
            if (ev) entry.durationMs = Math.round(ev.duration * 1000);
        }
        // Remember what was built for --changed-only (per locale: the sources' hash and the full build key).
        const merge = (field: string) => ({ ...(manifest[field] && typeof manifest[field] === 'object' ? manifest[field] : {}) });
        setManifestFields(srcDir, { contentHash: { ...merge('contentHash'), [locale]: contentHash }, buildKey: { ...merge('buildKey'), [locale]: buildKey } });
        recordEvent(srcDir, { command: 'build-all', catalog: relPosix(srcDir, catalog.file!), locale, output: relPosix(srcDir, outDir), contentHash, buildKey, stale: entry.stale, builtAt: entry.builtAt });
        console.log(`✓ ${guide.slug}/${locale}${entry.stale ? ' (stale: frames changed)' : ''} in ${((entry.ms || 0) / 1000).toFixed(1)}s`);
    }

    if (options.dryRun) {
        const would = entries.filter(e => e.status === 'skipped').length;
        console.log(`\nDry run: ${would} guide × locale listed, ${failed} failed to resolve. Nothing was written (no output tree, index or manifest entry).`);
        if (failed) process.exitCode = 1;
        return;
    }
    // Merge into the previous index so --only/--locale/stop-at-first-failure never publish a partial one.
    const previous = readIndex(catalog.outputDir);
    const index: IndexJson = {
        version: 1, generatedAt: new Date().toISOString(), tool: toolVersion(),
        catalog: relPosix(catalog.outputDir, catalog.file!),
        guides: mergeIndexEntries(previous?.guides, entries, planned.map(p => ({ slug: p.guide.slug, locale: p.locale }))),
    };
    const written = writeIndex(catalog.outputDir, index);
    const ok = entries.filter(e => e.status === 'ok').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;
    const stale = entries.filter(e => e.stale).length;
    const untouched = index.guides.length - entries.length;
    console.log(`\n${ok} built, ${skipped} skipped, ${failed} failed${stale ? `, ${stale} stale` : ''}${untouched > 0 ? `; ${untouched} index entr${untouched === 1 ? 'y' : 'ies'} kept from the previous run` : ''}. Index: ${path.relative(process.cwd(), written.json) || written.json}`);
    if (failed) process.exitCode = 1;
}
