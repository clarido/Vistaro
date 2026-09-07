import * as fs from 'fs';
import * as path from 'path';
import { recordEvent, setManifestFields, readManifest } from '../manifest';
import { loadTimeline, parseTimeline } from '../engine/schema';
import { extractStrings, stringsPath, writeStrings, readStrings, StringMap, isLocaleCode, isAutoStepId, diffStrings } from '../engine/strings';
import { referencedLocalFiles, localeDirFor } from '../catalog';

const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.css', '.js', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3'];

export interface LocalizeOptions {
    outputDir?: string;
    /** Legacy layout: scaffold into a sibling directory named after the locale (`../<locale>`). */
    sibling?: boolean;
    /** Overwrite the target's index.html, anim.config.json and strings.<locale>.json (translations are lost). */
    force?: boolean;
}

/**
 * `localize <source_dir> <locale>`: scaffold `<source_dir>/locales/<locale>/` (or --output-dir, or
 * the legacy sibling `<locale>/` with --sibling) with index.html, anim.config.json and the media
 * index.html references copied as a starting point, regenerate `strings.<baseLocale>.json` in the
 * source from the inline text, and write/merge a pre-filled `strings.<locale>.json` in the target.
 * Re-running is safe: a translator's index.html, anim.config.json and translations are kept
 * (new keys are added) unless --force. The choreography (time, action, target) is never edited.
 */
export function localizeCommand(sourceDir: string, locale: string, options: LocalizeOptions = {}) {
    const srcIndex = path.resolve(sourceDir, 'index.html');
    if (!fs.existsSync(srcIndex)) {
        console.error(`Error: ${srcIndex} not found. Point <source_dir> at a directory containing index.html.`);
        process.exit(1);
    }
    if (!isLocaleCode(locale)) {
        console.error(`Error: "${locale}" does not look like a locale code (e.g. fr, es, pt-BR).`);
        process.exit(1);
    }

    const targetDir = options.outputDir ? path.resolve(options.outputDir) : localeDirFor(sourceDir, locale, { sibling: options.sibling });
    if (path.resolve(targetDir) === path.resolve(sourceDir)) {
        console.error(`Error: target directory (${targetDir}) is the same as the source directory.`);
        process.exit(1);
    }
    fs.mkdirSync(targetDir, { recursive: true });

    const rel = (p: string) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };
    const kept: string[] = [];
    const copied: string[] = [];
    const copyUnlessPresent = (from: string, name: string) => {
        const to = path.join(targetDir, name);
        if (fs.existsSync(to) && !options.force) { kept.push(name); return; }
        fs.copyFileSync(from, to);
        copied.push(name);
    };

    // Copy the UI markup and timeline as a translation starting point (never over a translator's edits).
    copyUnlessPresent(srcIndex, 'index.html');

    const srcConfig = path.resolve(sourceDir, 'anim.config.json');
    const srcManifest = readManifest(sourceDir);
    // A source that is itself a locale (fr -> fr-CA): its strings are seeded from its localized view and
    // no strings.<base>.json is written into it.
    const sourceIsLocale = isLocaleCode(srcManifest.locale) && isLocaleCode(srcManifest.baseLocale) && srcManifest.locale !== srcManifest.baseLocale;
    let baseStrings: StringMap | undefined;
    let seedStrings: StringMap | undefined;
    let baseLocale = 'en';
    let sourceStringsFile: string | undefined;
    if (fs.existsSync(srcConfig)) {
        copyUnlessPresent(srcConfig, 'anim.config.json');
        // Keys always come from the inline text (the authored source).
        const inline = parseTimeline(JSON.parse(fs.readFileSync(srcConfig, 'utf8')));
        baseLocale = (isLocaleCode(srcManifest.baseLocale) ? srcManifest.baseLocale : undefined)
            || inline.meta.locale
            || (isLocaleCode(srcManifest.locale) ? srcManifest.locale : undefined)
            || 'en';
        baseStrings = extractStrings(inline);
        // Values are seeded from the source's localized view (fr for fr -> fr-CA; the inline text otherwise).
        try { seedStrings = extractStrings(loadTimeline(sourceDir)); } catch { seedStrings = baseStrings; }
        const autoIds = [...new Set(Object.keys(baseStrings).map(k => /^steps\.(.+)\.[a-z]+$/.exec(k)?.[1]).filter((id): id is string => !!id && isAutoStepId(id)))];
        if (autoIds.length) console.error(`warning  ${autoIds.length} localized step(s) use auto-generated ids (${autoIds.slice(0, 4).join(', ')}${autoIds.length > 4 ? ', …' : ''}); give them explicit "id"s before translating, otherwise inserting a step re-attaches their translations`);
        if (!sourceIsLocale) {
            // strings.<base>.json is derived from the inline text: regenerate it every run and say what moved.
            sourceStringsFile = stringsPath(sourceDir, baseLocale);
            const previous = fs.existsSync(sourceStringsFile) ? readStrings(sourceStringsFile) : undefined;
            writeStrings(sourceStringsFile, baseStrings);
            if (previous) {
                const d = diffStrings(previous, baseStrings);
                const moved = [...d.added.map(k => `+ ${k}`), ...d.removed.map(k => `- ${k}`), ...d.changed.map(k => `~ ${k}`)];
                if (moved.length) console.log(`Base strings changed since the last run (revisit these in every locale):\n  ${moved.join('\n  ')}`);
            }
        }
    }

    // Only the media index.html references (same rule as the content hash): generated files never travel.
    let mediaCopied = 0;
    for (const relPath of referencedLocalFiles(sourceDir)) {
        const from = path.join(sourceDir, relPath);
        if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
        if (!MEDIA_EXTENSIONS.includes(path.extname(relPath).toLowerCase())) continue;
        const to = path.join(targetDir, relPath);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        mediaCopied++;
    }
    // References that escape the source directory break one level deeper under locales/.
    for (const outside of referencedOutside(sourceDir)) {
        console.error(`warning  index.html references ${outside}, outside the source directory; it will not resolve from ${rel(targetDir)} (move the asset next to index.html, or use --sibling)`);
    }

    // Pre-filled strings file for the new locale: every inline key, seeded with the source's text.
    let targetStringsFile: string | undefined;
    if (baseStrings) {
        targetStringsFile = stringsPath(targetDir, locale);
        const seed: StringMap = {};
        for (const k of Object.keys(baseStrings)) seed[k] = seedStrings?.[k] ?? baseStrings[k];
        if (fs.existsSync(targetStringsFile) && !options.force) {
            const existing = readStrings(targetStringsFile);
            writeStrings(targetStringsFile, { ...seed, ...existing });
            kept.push(path.basename(targetStringsFile) + ' (merged)');
        } else {
            writeStrings(targetStringsFile, seed);
        }
    }

    setManifestFields(targetDir, { locale, baseLocale });
    if (!isLocaleCode(srcManifest.locale)) setManifestFields(sourceDir, { locale: sourceIsLocale ? srcManifest.locale : baseLocale, baseLocale });
    recordEvent(sourceDir, { command: 'localize', locale, targetDir: path.relative(path.resolve(sourceDir), targetDir).split(path.sep).join('/') });
    recordEvent(targetDir, { command: 'localize', sourceDir: path.relative(targetDir, path.resolve(sourceDir)).split(path.sep).join('/'), locale, baseLocale });

    console.log(`\nScaffolded locale "${locale}" at ${rel(targetDir)}: copied ${copied.join(', ') || 'nothing new'}${mediaCopied ? `, ${mediaCopied} media file(s)` : ''}${targetStringsFile ? `; ${Object.keys(baseStrings!).length} strings` : ''}.`);
    for (const k of kept) console.log(`Kept existing ${k} (use --force to overwrite).`);
    if (sourceStringsFile) console.log(`Base strings (${baseLocale}): ${rel(sourceStringsFile)} (regenerated from anim.config.json).`);
    console.log(`\nNext steps:`);
    if (targetStringsFile) console.log(`  1. Translate the values in ${rel(targetStringsFile)} (titles, subtitles, narration, notes, translatable typed text). Keys and anim.config.json stay as they are.`);
    console.log(`  ${targetStringsFile ? 2 : 1}. Edit ${rel(path.join(targetDir, 'index.html'))} -- translate the visible text, keep element IDs/classes unchanged.`);
    console.log(`  ${targetStringsFile ? 3 : 2}. Check, build and export the locale (strings apply automatically through the manifest's locale):`);
    console.log(`     npx tsx cli.ts check ${rel(targetDir)}`);
    console.log(`     npx tsx cli.ts build ${rel(targetDir)}`);
    console.log(`     npx tsx cli.ts export ${rel(targetDir)} --output demo-${locale}.mp4 --narration --guide`);
    console.log(`  Re-run \`localize\` after adding steps: new keys are added, your edits are kept.`);
    // Sanity: the target loads with the strings applied.
    try { loadTimeline(targetDir); } catch (e: any) { console.error(`warning  ${e.message}`); }
}

/** src/href/url() references in index.html that resolve above the source directory. */
function referencedOutside(dir: string): string[] {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const out = new Set<string>();
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const raw = (m[1] || m[2] || '').trim();
        if (!raw || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) continue;
        const relPath = path.relative(path.resolve(dir), path.resolve(dir, decodeURIComponent(raw.split(/[?#]/)[0])));
        if (relPath.startsWith('..') || path.isAbsolute(relPath)) out.add(raw);
    }
    return [...out];
}
