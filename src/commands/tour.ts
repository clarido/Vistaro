import * as fs from 'fs';
import * as path from 'path';
import { Timeline, loadTimeline, validateTimeline, computeDurationMs, isReel } from '../engine/schema';
import { isLocaleCode } from '../engine/strings';
import { buildTourPage } from '../engine/inject';
import { referencedLocalFiles, relPosix, displayPath, hashGuideDir } from '../catalog';
import { recordEvent } from '../manifest';

/** One scenario in tour.catalog.json: a mockup directory plus how the rail should present it. */
export interface TourScenario {
    slug: string;
    dir: string;
    label?: string;
    blurb?: string;
    group?: string;
    /** A timeline other than <dir>/anim.config.json, so one screen can carry several scenarios. */
    config?: string;
    cursor?: string;
    locale?: string;
    /** Absolute paths resolved by readTourCatalog; the authored values stay for messages. */
    resolvedDir?: string;
    resolvedConfig?: string;
}

export interface TourCatalog {
    outputDir?: string;
    product?: { name?: string; tagline?: string; accent?: string };
    rail?: { title?: string; subtitle?: string };
    groups?: { id: string; label: string }[];
    defaults?: { width?: number; height?: number; cursor?: string; locale?: string };
    scenarios: TourScenario[];
}

const APP_DIR = path.join(__dirname, '..', 'tour', 'app');
const APP_FILES = ['index.html', 'app.css', 'app.js'];

export function readTourCatalog(file: string): { catalog: TourCatalog; dir: string } {
    if (!fs.existsSync(file)) throw new Error(`catalog not found: ${displayPath(file)}`);
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e: any) { throw new Error(`${displayPath(file)} is not valid JSON: ${e.message}`); }
    if (!raw || typeof raw !== 'object') throw new Error(`${displayPath(file)} must be a JSON object`);
    if (!Array.isArray(raw.scenarios) || !raw.scenarios.length) throw new Error(`${displayPath(file)} needs a non-empty "scenarios" array`);

    const catalogDir = path.dirname(path.resolve(file));
    const groups = raw.groups || [];
    const seen = new Set<string>();
    // Every problem is collected and reported together: a catalog with three broken entries should
    // cost one run, not three.
    const problems: string[] = [];

    raw.scenarios.forEach((s: any, i: number) => {
        if (!s || typeof s !== 'object') { problems.push(`scenarios[${i}] must be an object`); return; }
        const where = s.slug ? `scenario "${s.slug}"` : `scenarios[${i}]`;
        if (!s.slug) problems.push(`${where} needs a "slug"`);
        // Lowercase, because a slug is a directory name and a URL fragment: on a case-insensitive
        // filesystem "Export-Word" and "export-word" would pass as distinct and then share one page.
        else if (!/^[a-z0-9][a-z0-9-]*$/.test(s.slug)) problems.push(`${where}: slug must be lowercase letters, digits and dashes (it becomes a directory name and a URL fragment)`);
        else if (seen.has(s.slug)) problems.push(`duplicate scenario slug "${s.slug}"`);
        else seen.add(s.slug);

        if (s.group && !groups.some((g: any) => g.id === s.group)) {
            problems.push(`${where} is in group "${s.group}", which no entry of "groups" declares`);
        }
        if (s.locale !== undefined && !isLocaleCode(s.locale)) problems.push(`${where}: "locale" must be a locale code such as "fr" or "pt-BR"`);

        // Paths in a catalog are relative to the catalog file -- `dir`, and `config` with it.
        if (!s.dir) { problems.push(`${where} needs a "dir"`); return; }
        s.resolvedDir = path.resolve(catalogDir, s.dir);
        if (!fs.existsSync(path.join(s.resolvedDir, 'index.html'))) problems.push(`${where}: no index.html in ${displayPath(s.resolvedDir)}`);
        if (s.config !== undefined) {
            if (typeof s.config !== 'string' || !s.config.trim()) { problems.push(`${where}: "config" must be a path relative to the catalog`); return; }
            s.resolvedConfig = path.resolve(catalogDir, s.config);
            if (!fs.existsSync(s.resolvedConfig)) problems.push(`${where}: timeline not found: ${displayPath(s.resolvedConfig)}`);
        }
    });

    if (problems.length) {
        throw new Error(`${displayPath(file)}:\n  ${problems.join('\n  ')}`);
    }
    return { catalog: raw as TourCatalog, dir: catalogDir };
}

/**
 * A scenario's timeline. Alternate configs go through loadTimeline like every other timeline, so a
 * scenario gets the same locale resolution, strings overlay, device resolution and error messages
 * as the directory's default one.
 */
function timelineFor(scenario: TourScenario, catalog: TourCatalog): Timeline {
    return loadTimeline(scenario.resolvedDir!, {
        locale: scenario.locale ?? catalog.defaults?.locale,
        config: scenario.resolvedConfig,
    });
}

function copyMedia(srcDir: string, outDir: string, log: (m: string) => void): number {
    let n = 0;
    for (const rel of referencedLocalFiles(srcDir)) {
        const from = path.join(srcDir, rel);
        if (!fs.existsSync(from)) { log(`warning  ${displayPath(from)} is referenced by index.html but missing`); continue; }
        const to = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        n++;
    }
    return n;
}

export interface TourOptions { output?: string; force?: boolean }

/**
 * Build the whole tour site: one self-playing scenario page per catalog entry, plus the shell that
 * lists them and drives playback. Nothing is captured and nothing is encoded -- a scenario page is
 * the mockup itself with the runtime and the tour scheduler injected, so it stays crisp at any size
 * and weighs what the HTML weighs.
 */
export async function tourCommand(catalogFile: string, options: TourOptions = {}): Promise<void> {
    const { catalog, dir: catalogDir } = readTourCatalog(catalogFile);
    const outDir = path.resolve(catalogDir, options.output || catalog.outputDir || 'tour-out');

    const home = process.env.HOME || process.env.USERPROFILE;
    if (outDir === path.parse(outDir).root || (home && outDir === path.resolve(home)) || outDir === catalogDir) {
        throw new Error(`refusing to write the tour into ${displayPath(outDir)}; pick a dedicated outputDir`);
    }
    // The shell's own index.html is copied into outDir, so an outDir that overlaps a scenario's
    // directory OVERWRITES the mockup being toured -- and the run then reads the shell back as the
    // screen and reports success. build-all forbids the same overlap for the same reason.
    const inside = (parent: string, child: string) => !path.relative(parent, child).startsWith('..') && !path.isAbsolute(path.relative(parent, child));
    for (const s of catalog.scenarios) {
        const d = s.resolvedDir!;
        if (d === outDir || inside(outDir, d) || inside(d, outDir)) {
            throw new Error(`outputDir ${displayPath(outDir)} overlaps scenario "${s.slug}" (${displayPath(d)}); the shell would overwrite its index.html`);
        }
    }

    const scenariosDir = path.join(outDir, 'scenarios');
    fs.mkdirSync(scenariosDir, { recursive: true });
    for (const f of APP_FILES) fs.copyFileSync(path.join(APP_DIR, f), path.join(outDir, f));

    // A scenario dropped from the catalog would otherwise keep its page here forever, still served
    // and still reachable by its #slug, with nothing in the build output mentioning it.
    const wanted = new Set(catalog.scenarios.map(s => s.slug));
    for (const name of fs.readdirSync(scenariosDir)) {
        const full = path.join(scenariosDir, name);
        if (wanted.has(name) || !fs.statSync(full).isDirectory()) continue;
        fs.rmSync(full, { recursive: true, force: true });
        console.log(`  removed stale scenario page: scenarios/${name}`);
    }

    const scenarios: any[] = [];
    let failures = 0;

    for (const s of catalog.scenarios) {
        const srcDir = s.resolvedDir!;
        const indexPath = path.join(srcDir, 'index.html');
        try {
            const timeline = timelineFor(s, catalog);

            // A reel carries no titles by design, so guide-shaped validation would bury the real
            // problem under one "needs a title" error per step. Say the actual thing instead.
            if (isReel(timeline)) {
                throw new Error('timeline is kind: "reel": a tour needs titled steps for its captions and step navigation (a reel is a silent clip with none). Use `build --embed` for a reel, or set meta.kind to "guide"');
            }
            // Guide-shaped: the shell shows a title per step in its caption and its ticks, so an
            // untitled visible step is an error here even though it is only a warning elsewhere.
            const issues = validateTimeline(timeline, { guide: true });
            const errors = issues.filter(i => i.level === 'error');
            for (const i of issues) console.error(`  ${i.level === 'error' ? 'error  ' : 'warning'}  ${s.slug}: ${i.message}`);
            if (errors.length && !options.force) throw new Error(`${errors.length} validation error(s); fix them or pass --force`);

            const pageDir = path.join(outDir, 'scenarios', s.slug);
            fs.mkdirSync(pageDir, { recursive: true });
            const html = buildTourPage(fs.readFileSync(indexPath, 'utf8'), timeline, {
                cursor: s.cursor ?? catalog.defaults?.cursor ?? timeline.meta.cursor,
            });
            fs.writeFileSync(path.join(pageDir, 'index.html'), html, 'utf8');
            const media = copyMedia(srcDir, pageDir, m => console.error(`  ${m}`));

            const shown = timeline.steps.filter(st => st.guide !== false && st.title);
            scenarios.push({
                slug: s.slug,
                label: s.label || timeline.meta.title || s.slug,
                blurb: s.blurb || '',
                group: s.group,
                page: `scenarios/${s.slug}/index.html`,
                viewport: { width: catalog.defaults?.width ?? 1920, height: catalog.defaults?.height ?? 1080 },
                durationMs: computeDurationMs(timeline),
                stepCount: shown.length,
                steps: timeline.steps.map((st, i) => ({
                    index: i, id: st.id, action: st.action, title: st.title || '',
                    subtitle: st.subtitle || '', note: st.note || '',
                    hidden: st.guide === false || !st.title,
                })),
            });
            // Same convention as build/guide: the event lands in the source directory, paths relative
            // to it, so `tour` leaves the same kind of trail every other producing command leaves.
            const configRel = s.resolvedConfig ? relPosix(srcDir, s.resolvedConfig) : undefined;
            recordEvent(srcDir, {
                command: 'tour', scenario: s.slug, config: configRel,
                output: relPosix(srcDir, outDir), steps: shown.length,
                locale: timeline.locale ?? timeline.meta.locale,
                contentHash: hashGuideDir(srcDir, { config: s.resolvedConfig }),
            });
            console.log(`  ${s.slug.padEnd(24)} ${shown.length} steps · ${(computeDurationMs(timeline) / 1000).toFixed(1)}s${media ? ` · ${media} media` : ''}`);
        } catch (e: any) {
            failures++;
            console.error(`  error   ${s.slug}: ${e.message}`);
        }
    }

    if (!scenarios.length) throw new Error('no scenario could be built');

    fs.writeFileSync(path.join(outDir, 'tours.json'), JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        product: catalog.product || {},
        rail: catalog.rail || {},
        groups: catalog.groups || [],
        scenarios,
    }, null, 2) + '\n', 'utf8');

    console.log(`\nWrote ${displayPath(outDir)}: index.html + tours.json + ${scenarios.length} scenario page(s).`);
    const rel = relPosix(process.cwd(), outDir);
    console.log(`  serve it:  npx http-server ${rel.startsWith('..') ? displayPath(outDir) : rel} -p 8080   (any static host works)`);
    if (failures) { console.error(`\n${failures} scenario(s) failed.`); process.exitCode = 1; }
}
