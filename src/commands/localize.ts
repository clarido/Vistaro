import * as fs from 'fs';
import * as path from 'path';
import { recordEvent, setManifestFields } from '../manifest';

const MEDIA_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

export function localizeCommand(sourceDir: string, locale: string, options: { outputDir?: string }) {
    const srcIndex = path.resolve(sourceDir, 'index.html');
    if (!fs.existsSync(srcIndex)) {
        console.error(`Error: ${srcIndex} not found. Point <source_dir> at a directory containing index.html.`);
        process.exit(1);
    }

    const targetDir = options.outputDir
        ? path.resolve(options.outputDir)
        : path.resolve(sourceDir, '..', locale);

    if (path.resolve(targetDir) === path.resolve(sourceDir)) {
        console.error(`Error: target directory (${targetDir}) is the same as the source directory.`);
        process.exit(1);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    // Copy the UI markup and timeline as a translation starting point. The element IDs/classes
    // and the timeline's time/action/target choreography stay identical across locales --
    // only the visible text (index.html) and subtitle strings (anim.config.json) should change.
    fs.copyFileSync(srcIndex, path.join(targetDir, 'index.html'));

    const srcConfig = path.resolve(sourceDir, 'anim.config.json');
    if (fs.existsSync(srcConfig)) {
        fs.copyFileSync(srcConfig, path.join(targetDir, 'anim.config.json'));
    }

    let mediaCopied = 0;
    for (const file of fs.readdirSync(sourceDir)) {
        if (MEDIA_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
            fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
            mediaCopied++;
        }
    }

    const baseLocale = path.basename(sourceDir);
    setManifestFields(targetDir, { locale, baseLocale });
    recordEvent(sourceDir, { command: 'localize', locale, targetDir });
    recordEvent(targetDir, { command: 'localize', sourceDir, locale });

    console.log(`\nScaffolded locale "${locale}" at ${targetDir} (copied index.html${fs.existsSync(srcConfig) ? ', anim.config.json' : ''}${mediaCopied ? `, ${mediaCopied} media file(s)` : ''}).`);
    console.log(`\nNext steps:`);
    console.log(`  1. Edit ${path.join(targetDir, 'index.html')} -- translate visible text, keep element IDs/classes unchanged.`);
    if (fs.existsSync(path.join(targetDir, 'anim.config.json'))) {
        console.log(`  2. Edit ${path.join(targetDir, 'anim.config.json')} -- translate "subtitle" strings, keep "time"/"action"/"target" unchanged.`);
    }
    console.log(`  3. Write ${path.join(targetDir, 'animated.html')} (or run \`animate\`), then export:`);
    console.log(`     npx tsx cli.ts export ${targetDir} --duration <seconds> --output demo-${locale}.mp4 --locale ${locale}`);
}
