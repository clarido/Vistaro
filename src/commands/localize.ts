import * as fs from 'fs';
import * as path from 'path';
import { recordEvent, setManifestFields, readManifest } from '../manifest';
import { loadTimeline, parseTimeline } from '../engine/schema';
import { extractStrings, stringsPath, writeStrings, readStrings, StringMap } from '../engine/strings';
import { referencedLocalFiles } from '../catalog';

const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

export interface LocalizeOptions {
    outputDir?: string;
    /** Legacy layout: scaffold into a sibling directory named after the locale (`../<locale>`). */
    sibling?: boolean;
    /** Overwrite an existing strings.<locale>.json in the target. */
    force?: boolean;
}

/**
 * `localize <source_dir> <locale>`: scaffold `<source_dir>/locales/<locale>/` (or --output-dir, or
 * the legacy sibling `<locale>/` with --sibling) with index.html, anim.config.json and top-level
 * media copied as a starting point, write `strings.<baseLocale>.json` in the source (if absent)
 * and a pre-filled `strings.<locale>.json` in the target. The timeline's choreography (time,
 * action, target) is never edited: translated text comes from the strings file and from the
 * visible text in the copied index.html.
 */
export function localizeCommand(sourceDir: string, locale: string, options: LocalizeOptions = {}) {
    const srcIndex = path.resolve(sourceDir, 'index.html');
    if (!fs.existsSync(srcIndex)) {
        console.error(`Error: ${srcIndex} not found. Point <source_dir> at a directory containing index.html.`);
        process.exit(1);
    }
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
        console.error(`Error: "${locale}" does not look like a locale code (e.g. fr, es, pt-BR).`);
        process.exit(1);
    }

    const targetDir = options.outputDir
        ? path.resolve(options.outputDir)
        : options.sibling
            ? path.resolve(sourceDir, '..', locale)
            : path.resolve(sourceDir, 'locales', locale);

    if (path.resolve(targetDir) === path.resolve(sourceDir)) {
        console.error(`Error: target directory (${targetDir}) is the same as the source directory.`);
        process.exit(1);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    // Copy the UI markup and timeline as a translation starting point. The element IDs/classes
    // and the timeline's time/action/target choreography stay identical across locales --
    // only the visible text (index.html) and the strings file should change.
    fs.copyFileSync(srcIndex, path.join(targetDir, 'index.html'));

    const srcConfig = path.resolve(sourceDir, 'anim.config.json');
    let baseStrings: StringMap | undefined;
    let baseLocale = 'en';
    let sourceStringsFile: string | undefined;
    if (fs.existsSync(srcConfig)) {
        fs.copyFileSync(srcConfig, path.join(targetDir, 'anim.config.json'));
        // Base strings come from the inline text (not from an already-localized view of the source).
        const raw = JSON.parse(fs.readFileSync(srcConfig, 'utf8'));
        const base = parseTimeline(raw);
        const manifest = readManifest(sourceDir);
        baseLocale = manifest.baseLocale || base.meta.locale || manifest.locale || 'en';
        baseStrings = extractStrings(base);
        sourceStringsFile = stringsPath(sourceDir, baseLocale);
        if (!fs.existsSync(sourceStringsFile)) writeStrings(sourceStringsFile, baseStrings);
        else {
            // Keep the source file authoritative but make sure new steps are listed.
            const existing = readStrings(sourceStringsFile);
            const merged = { ...baseStrings, ...existing };
            if (Object.keys(merged).length !== Object.keys(existing).length) writeStrings(sourceStringsFile, merged);
            baseStrings = merged;
        }
    }

    // Only the media index.html references (same rule as the content hash): generated files such as
    // preview*.png, exports or guide assets never travel, and locales/ is never scanned.
    let mediaCopied = 0;
    for (const rel of referencedLocalFiles(sourceDir)) {
        const from = path.join(sourceDir, rel);
        if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
        if (!MEDIA_EXTENSIONS.includes(path.extname(rel).toLowerCase()) && !/\.(css|js|woff2?|ttf|otf|mp4|webm|mp3)$/i.test(rel)) continue;
        const to = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        mediaCopied++;
    }

    // Pre-filled strings file for the new locale: every key with the base text, ready to translate.
    let targetStringsFile: string | undefined;
    if (baseStrings) {
        targetStringsFile = stringsPath(targetDir, locale);
        if (fs.existsSync(targetStringsFile) && !options.force) {
            const existing = readStrings(targetStringsFile);
            const merged = { ...baseStrings, ...existing };
            writeStrings(targetStringsFile, merged);
        } else {
            writeStrings(targetStringsFile, baseStrings);
        }
    }

    setManifestFields(targetDir, { locale, baseLocale });
    if (!readManifest(sourceDir).locale) setManifestFields(sourceDir, { locale: baseLocale, baseLocale });
    recordEvent(sourceDir, { command: 'localize', locale, targetDir: path.relative(path.resolve(sourceDir), targetDir).split(path.sep).join('/') });
    recordEvent(targetDir, { command: 'localize', sourceDir: path.relative(targetDir, path.resolve(sourceDir)).split(path.sep).join('/'), locale, baseLocale });

    const rel = (p: string) => { const r = path.relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };
    console.log(`\nScaffolded locale "${locale}" at ${rel(targetDir)} (copied index.html${fs.existsSync(srcConfig) ? ', anim.config.json' : ''}${mediaCopied ? `, ${mediaCopied} media file(s)` : ''}${targetStringsFile ? `, ${Object.keys(baseStrings!).length} strings` : ''}).`);
    if (sourceStringsFile) console.log(`Base strings (${baseLocale}): ${rel(sourceStringsFile)}`);
    console.log(`\nNext steps:`);
    if (targetStringsFile) console.log(`  1. Translate the values in ${rel(targetStringsFile)} (titles, subtitles, narration, notes, translatable typed text). Keys and anim.config.json stay as they are.`);
    console.log(`  ${targetStringsFile ? 2 : 1}. Edit ${rel(path.join(targetDir, 'index.html'))} -- translate the visible text, keep element IDs/classes unchanged.`);
    console.log(`  ${targetStringsFile ? 3 : 2}. Check, build and export the locale (strings apply automatically through the manifest's locale):`);
    console.log(`     npx tsx cli.ts check ${rel(targetDir)}`);
    console.log(`     npx tsx cli.ts build ${rel(targetDir)}`);
    console.log(`     npx tsx cli.ts export ${rel(targetDir)} --output demo-${locale}.mp4 --narration --guide`);
    // Sanity: the target loads with the strings applied.
    try { loadTimeline(targetDir); } catch (e: any) { console.error(`warning  ${e.message}`); }
}
