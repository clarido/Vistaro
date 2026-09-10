import * as fs from 'fs';
import * as path from 'path';
import { Timeline, loadTimeline, validateTimeline, computeDurationMs, isReel, DeviceKind, DEVICE_KINDS } from '../engine/schema';
import { resolveViewport } from '../browser';
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
    /** Which form factors to build. Each becomes its own page, because `only`/`mobile`/`desktop`
     *  steps resolve differently and the two pages are genuinely different deliverables. */
    devices?: DeviceKind[];
    /** Absolute paths resolved by readTourCatalog; the authored values stay for messages. */
    resolvedDir?: string;
    resolvedConfig?: string;
}

export interface TourCatalog {
    outputDir?: string;
    product?: { name?: string; tagline?: string; accent?: string };
    rail?: { title?: string; subtitle?: string };
    groups?: { id: string; label: string }[];
    defaults?: {
        /** The desktop canvas. A phone page uses 390x844 unless `mobile` overrides it. */
        width?: number; height?: number;
        mobile?: { width?: number; height?: number };
        cursor?: string; locale?: string; devices?: DeviceKind[];
    };
    scenarios: TourScenario[];
}

const APP_DIR = path.join(__dirname, '..', 'tour', 'app');
const APP_FILES = ['index.html', 'app.css', 'app.js'];
/** Copied only with --embed: without the embed pages it would advertise files that do not exist. */
const EMBED_FILES = ['anim-tour.js'];

/**
 * The parent-side fallback, for a CMS that strips module scripts. It is a small copy of what
 * anim-tour.js does, and it exists for the same reason build.ts:38 writes one for a reel: an
 * IntersectionObserver INSIDE the frame measures against the frame's own viewport, so an embed
 * below the fold reports itself fully visible and plays to nobody. Only the host can see where
 * the frame really is, so only the host can decide when it plays.
 */
function tourEmbedSnippet(slug: string, label: string, devices: DeviceKind[], height: number): string {
    const desktop = devices.includes('desktop') ? `embed-${slug}-desktop.html` : `embed-${slug}-${devices[0]}.html`;
    const mobile = devices.includes('mobile') ? `embed-${slug}-mobile.html` : desktop;
    return `<!-- Paste where the tour should appear, and serve the tour directory from the same origin or any https host.
     Prefer <anim-tour> (anim-tour.js) unless your CMS strips module scripts; this is the fallback. -->
<div class="anim-tour-embed" data-desktop="${desktop}" data-mobile="${mobile}" style="max-width: 100%;">
  <iframe class="anim-tour-frame" title="${label.replace(/"/g, '&quot;')}" scrolling="no" allowfullscreen
          style="display: block; width: 100%; height: ${height}px; border: 0;"></iframe>
</div>
<script>
  (function () {
    var boxes = document.querySelectorAll('.anim-tour-embed');
    var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    Array.prototype.forEach.call(boxes, function (box) {
      var frame = box.querySelector('.anim-tour-frame');
      var phone = matchMedia('(max-width: 768px)').matches;
      frame.src = box.getAttribute(phone ? 'data-mobile' : 'data-desktop');
      // The frame reports its own height; the host cannot measure across the boundary.
      addEventListener('message', function (e) {
        var d = e.data;
        if (!d || d.source !== 'anim-tour-embed' || e.source !== frame.contentWindow) return;
        if (d.type === 'size' && d.height > 0) frame.style.height = d.height + 'px';
        if (d.type === 'ready' && play && !reduced) send('play');
      });
      function send(type) { if (frame.contentWindow) frame.contentWindow.postMessage({ source: 'anim-tour-host', type: type }, '*'); }
      var play = false;
      if (!('IntersectionObserver' in window) || reduced) return;
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) { play = entry.isIntersecting; send(play ? 'play' : 'pause'); });
      }, { threshold: 0.4 }).observe(box);
    });
  })();
</script>
`;
}

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

    // defaults.devices reaches the same `?? defaults ??` fallback every scenario uses, so an empty
    // array here breaks every entry at once rather than one.
    const dd = raw.defaults?.devices;
    if (dd !== undefined) {
        if (!Array.isArray(dd) || !dd.length) problems.push(`defaults.devices must be a non-empty array (${DEVICE_KINDS.join(', ')})`);
        else for (const d of dd) if (!DEVICE_KINDS.includes(d)) problems.push(`defaults.devices: unknown device "${d}" (${DEVICE_KINDS.join(', ')})`);
    }

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
        // An empty array is not "use the default": it survives the `?? defaults` fallback, builds
        // zero pages, and leaves an entry in tours.json with no variants -- which the shell then
        // dereferences into a blank canvas. Rejected here so it costs one message, not one debug.
        if (s.devices !== undefined && (!Array.isArray(s.devices) || !s.devices.length)) {
            problems.push(`${where}: "devices" must be a non-empty array (${DEVICE_KINDS.join(', ')})`);
        }
        for (const d of (s.devices || [])) {
            if (!DEVICE_KINDS.includes(d)) problems.push(`${where}: unknown device "${d}" (${DEVICE_KINDS.join(', ')})`);
        }

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
function timelineFor(scenario: TourScenario, catalog: TourCatalog, device: DeviceKind): Timeline {
    return loadTimeline(scenario.resolvedDir!, {
        locale: scenario.locale ?? catalog.defaults?.locale,
        config: scenario.resolvedConfig,
        device,
    });
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export interface TourOptions {
    output?: string;
    force?: boolean;
    /** Also write the per-scenario embed pages, the <anim-tour> element and the snippet fallbacks. */
    embed?: boolean;
    /** targetOrigin the embed pages use when they report to their host. Public content, so '*' by default. */
    embedOrigin?: string;
}

/**
 * Build the whole tour site: one self-playing scenario page per catalog entry, plus the shell that
 * lists them and drives playback. Nothing is captured and nothing is encoded -- a scenario page is
 * the mockup itself with the runtime and the tour scheduler injected, so it stays crisp at any size
 * and weighs what the HTML weighs.
 */
export async function tourCommand(catalogFile: string, options: TourOptions = {}): Promise<void> {
    // An origin postMessage cannot use is worse than no origin at all: it throws inside the embed,
    // the throw is caught, and the page then reports no height and emits no events -- forever, with
    // nothing in any log. "example.com" (no scheme) is the natural way to get this wrong.
    if (options.embedOrigin && options.embedOrigin !== '*') {
        let ok = false;
        try { ok = new URL(options.embedOrigin).origin === options.embedOrigin; } catch { ok = false; }
        if (!ok) throw new Error(`--embed-origin must be an origin such as https://example.com, or * (got ${JSON.stringify(options.embedOrigin)})`);
    }
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
    if (options.embed) for (const f of EMBED_FILES) fs.copyFileSync(path.join(APP_DIR, f), path.join(outDir, f));
    const embedTemplate = options.embed ? fs.readFileSync(path.join(APP_DIR, 'embed.html'), 'utf8') : '';
    const embedFiles = new Set<string>();

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
            const devices = s.devices ?? catalog.defaults?.devices ?? (['desktop'] as DeviceKind[]);
            const pageDir = path.join(outDir, 'scenarios', s.slug);
            fs.mkdirSync(pageDir, { recursive: true });
            // Media is shared by every device page of a scenario, so it is copied once per scenario
            // rather than once per variant.
            const media = copyMedia(srcDir, pageDir, m => console.error(`  ${m}`));
            const written = new Set<string>();
            const variants: Record<string, any> = {};
            let label = s.label;
            let lastTimeline: Timeline | undefined;

            for (const device of devices) {
                // Loaded per device: `only` drops steps and `mobile`/`desktop` merge into them, so one
                // authored file yields two genuinely different timelines.
                const timeline = timelineFor(s, catalog, device);
                lastTimeline = timeline;
                label = label || timeline.meta.title;

                // A reel carries no titles by design, so guide-shaped validation would bury the real
                // problem under one "needs a title" error per step. Say the actual thing instead.
                if (isReel(timeline)) {
                    throw new Error('timeline is kind: "reel": a tour needs titled steps for its captions and step navigation (a reel is a silent clip with none). Use `build --embed` for a reel, or set meta.kind to "guide"');
                }
                // Guide-shaped: the shell shows a title per step in its caption and its ticks, so an
                // untitled visible step is an error here even though it is only a warning elsewhere.
                const issues = validateTimeline(timeline, { guide: true });
                const errors = issues.filter(i => i.level === 'error');
                for (const i of issues) console.error(`  ${i.level === 'error' ? 'error  ' : 'warning'}  ${s.slug} (${device}): ${i.message}`);
                if (errors.length && !options.force) throw new Error(`${errors.length} validation error(s); fix them or pass --force`);

                // width/height in the catalog describe the DESKTOP canvas. Applied to a phone they
                // produced a 1920-wide "mobile" page, which is the bug the device split exists to avoid;
                // mobile takes the standard 390x844 unless the catalog overrides it per device.
                const vp = device === 'mobile'
                    ? resolveViewport({ device, width: catalog.defaults?.mobile?.width, height: catalog.defaults?.mobile?.height })
                    : resolveViewport({ device, width: catalog.defaults?.width, height: catalog.defaults?.height });
                const html = buildTourPage(fs.readFileSync(indexPath, 'utf8'), timeline, {
                    cursor: s.cursor ?? catalog.defaults?.cursor ?? timeline.meta.cursor,
                });
                // The device is in the FILE name, never implied: an unsuffixed pair would have the
                // second build silently overwrite the first, leaving a desktop page in a phone frame.
                const file = `index-${device}.html`;
                fs.writeFileSync(path.join(pageDir, file), html, 'utf8');
                written.add(file);

                const shown = timeline.steps.filter(st => st.guide !== false && st.title);
                variants[device] = {
                    page: `scenarios/${s.slug}/${file}`,
                    viewport: { width: vp.width, height: vp.height },
                    durationMs: computeDurationMs(timeline),
                    stepCount: shown.length,
                    steps: timeline.steps.map((st, i) => ({
                        index: i, id: st.id, action: st.action, title: st.title || '',
                        subtitle: st.subtitle || '', note: st.note || '',
                        hidden: st.guide === false || !st.title,
                    })),
                };
                console.log(`  ${s.slug.padEnd(20)} ${device.padEnd(8)} ${shown.length} steps · ${(computeDurationMs(timeline) / 1000).toFixed(1)}s · ${vp.width}x${vp.height}${media ? ` · ${media} media` : ''}`);
            }

            // A device dropped from the catalog (or an older naming scheme) leaves a page that is
            // still served and still reachable; same reason stale scenario directories are pruned.
            for (const name of fs.readdirSync(pageDir)) {
                if (!/^index(-[a-z]+)?\.html$/.test(name) || written.has(name)) continue;
                fs.rmSync(path.join(pageDir, name), { force: true });
                console.log(`  removed stale page: scenarios/${s.slug}/${name}`);
            }

            if (options.embed) {
                for (const device of devices) {
                    // Same reason the scenario page carries its device: an unsuffixed pair would have
                    // the second build overwrite the first, and the host picks the variant by name.
                    const file = `embed-${s.slug}-${device}.html`;
                    // Function replacements, not strings: `$&`, `` $` ``, `$'` and `$$` are special
                    // in a replacement string, so a label containing one would be mangled.
                    const fill = (v: string) => () => v;
                    fs.writeFileSync(path.join(outDir, file), embedTemplate
                        .replace(/__ROOT__/g, fill(''))
                        .replace(/__SCENARIO__/g, fill(s.slug))
                        .replace(/__DEVICE__/g, fill(device))
                        .replace(/__AUTOPLAY__/g, fill('none'))
                        .replace(/__ORIGIN__/g, fill(escapeHtml(options.embedOrigin || '*')))
                        .replace(/__TITLE__/g, fill(escapeHtml(label || s.slug))), 'utf8');
                    embedFiles.add(file);
                }
                // The snippet is per scenario, not per device: it picks the variant itself, because
                // the embedding page is the only place the visitor's real viewport is known.
                const snippet = `embed-${s.slug}.snippet.html`;
                const tallest = Math.max(...devices.map(d => Math.round(variants[d].viewport.height * 0.55) + 190));
                fs.writeFileSync(path.join(outDir, snippet), tourEmbedSnippet(s.slug, label || s.slug, devices, tallest), 'utf8');
                embedFiles.add(snippet);
                console.log(`  ${''.padEnd(20)} ${'embed'.padEnd(8)} ${devices.map(d => `embed-${s.slug}-${d}.html`).join(' · ')} + ${snippet}`);
            }

            scenarios.push({ slug: s.slug, label: label || s.slug, blurb: s.blurb || '', group: s.group, devices, variants });
            // Same convention as build/guide: the event lands in the source directory, paths relative
            // to it, so `tour` leaves the same kind of trail every other producing command leaves.
            const configRel = s.resolvedConfig ? relPosix(srcDir, s.resolvedConfig) : undefined;
            recordEvent(srcDir, {
                command: 'tour', scenario: s.slug, config: configRel, devices,
                output: relPosix(srcDir, outDir),
                steps: variants[devices[0]]?.stepCount,
                locale: lastTimeline?.locale ?? lastTimeline?.meta.locale,
                contentHash: hashGuideDir(srcDir, { config: s.resolvedConfig }),
            });
        } catch (e: any) {
            failures++;
            console.error(`  error   ${s.slug}: ${e.message}`);
        }
    }

    if (!scenarios.length) throw new Error('no scenario could be built');

    // A scenario dropped from the catalog (or a device dropped from it) leaves an embed page that a
    // customer's site is very likely still framing, so it must not be left silently behind.
    //
    // A scenario that FAILED this run is a different case and must be left alone. It wrote nothing,
    // so it is absent from `embedFiles`, but it is still in the catalog and its scenario page is
    // still on disk (that prune keys on the catalog, above). Deleting only its embed pages would
    // break the customer's site over a validation error the next run may well fix, while leaving
    // the orphaned scenario page behind -- the worst of both. Only a slug the catalog no longer
    // claims is stale, so failed slugs are held here exactly as the scenario prune holds them.
    if (options.embed) {
        const claimed = new Set(catalog.scenarios.map(s => s.slug));
        const built = new Set(scenarios.map(s => s.slug));
        for (const name of fs.readdirSync(outDir)) {
            const m = /^embed-(.+?)(?:-(?:desktop|mobile))?\.(?:snippet\.)?html$/.exec(name);
            if (!m || embedFiles.has(name)) continue;
            // Two ways a leftover is genuinely stale, and one way it is not:
            //   the catalog no longer claims the slug            -> gone for good, remove;
            //   the slug rebuilt fine but did not write this file -> a dropped device, remove;
            //   the slug is claimed but FAILED this run           -> keep.
            if (claimed.has(m[1]) && !built.has(m[1])) continue;
            fs.rmSync(path.join(outDir, name), { force: true });
            console.log(`  removed stale embed page: ${name}`);
        }
    }

    if (!options.embed) {
        const left = fs.readdirSync(outDir).filter(n => /^embed-.+\.(?:snippet\.)?html$/.test(n));
        if (left.length) {
            console.error(`  warning  ${left.length} embed page(s) from an earlier --embed build are still here and may be framed by another site;`);
            console.error(`           they now point at scenario pages this build may have changed. Re-run with --embed, or delete them.`);
        }
    }

    fs.writeFileSync(path.join(outDir, 'tours.json'), JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        product: catalog.product || {},
        rail: catalog.rail || {},
        groups: catalog.groups || [],
        scenarios,
    }, null, 2) + '\n', 'utf8');

    const embedCount = scenarios.reduce((n, s) => n + s.devices.length, 0);
    console.log(`\nWrote ${displayPath(outDir)}: index.html + tours.json + ${scenarios.length} scenario page(s)${options.embed ? ` + ${embedCount} embed page(s) + anim-tour.js` : ''}.`);
    const rel = relPosix(process.cwd(), outDir);
    console.log(`  serve it:  npx http-server ${rel.startsWith('..') ? displayPath(outDir) : rel} -p 8080   (any static host works)`);
    if (options.embed) {
        console.log(`  embed it:  <script type="module" src=".../anim-tour.js"></script>`);
        console.log(`             <anim-tour src="<tour url>/" scenario="${scenarios[0].slug}" autoplay="inview"></anim-tour>`);
    }
    if (failures) { console.error(`\n${failures} scenario(s) failed.`); process.exitCode = 1; }
}
