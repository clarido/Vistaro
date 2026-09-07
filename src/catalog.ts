import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { isLocaleCode } from './engine/strings';

/**
 * Files that define a guide's content: index.html, anim.config.json, strings.*.json, and only
 * the local media files index.html actually references (src/href/url()). Generated outputs
 * (animated.html, manifest, preview*.png, exports, guide/) never count.
 */
export function guideSourceFiles(dir: string): string[] {
    const out = new Set<string>();
    const add = (name: string) => { const full = path.join(dir, name); if (fs.existsSync(full) && fs.statSync(full).isFile()) out.add(full); };
    add('index.html');
    add('anim.config.json');
    for (const name of fs.readdirSync(dir)) if (/^strings\.[a-z0-9-]+\.json$/i.test(name)) add(name);
    for (const ref of referencedLocalFiles(dir)) add(ref);
    return [...out].sort();
}

/** Local relative paths referenced from index.html (src="", href="", url()) that resolve inside `dir`. */
export function referencedLocalFiles(dir: string): string[] {
    const indexPath = path.join(dir, 'index.html');
    if (!fs.existsSync(indexPath)) return [];
    const html = fs.readFileSync(indexPath, 'utf8');
    const refs = new Set<string>();
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const raw = (m[1] || m[2] || '').trim();
        if (!raw || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) continue; // http:, data:, protocol-relative, anchors
        const clean = decodeURIComponent(raw.split(/[?#]/)[0]);
        const resolved = path.resolve(dir, clean);
        const rel = path.relative(dir, resolved);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) refs.add(rel.split(path.sep).join('/'));
    }
    return [...refs].sort();
}

/** `sha256:<hex>` over the guide's source files (names + bytes), for staleness checks. */
export function hashGuideDir(dir: string): string {
    const h = createHash('sha256');
    for (const file of guideSourceFiles(dir)) {
        h.update(path.relative(dir, file).split(path.sep).join('/'));
        h.update('\0');
        h.update(fs.readFileSync(file));
        h.update('\0');
    }
    return 'sha256:' + h.digest('hex');
}

/** Where a locale of `dir` lives: `<dir>/locales/<code>/` by default, or the legacy sibling `<dir>/../<code>/`. */
export function localeDirFor(dir: string, code: string, opts: { sibling?: boolean } = {}): string {
    return opts.sibling ? path.resolve(dir, '..', code) : path.resolve(dir, 'locales', code);
}

export interface LocaleDir { locale: string; dir: string; layout: 'locales' | 'sibling' }

/**
 * Every localized directory of `dir`: `locales/<code>/` entries that hold an anim.config.json, plus
 * sibling directories the manifest's `localize` events point at (legacy layout), each still present.
 */
export function localeDirs(dir: string): LocaleDir[] {
    const out = new Map<string, LocaleDir>();
    const localesRoot = path.join(dir, 'locales');
    if (fs.existsSync(localesRoot) && fs.statSync(localesRoot).isDirectory()) {
        for (const name of fs.readdirSync(localesRoot).sort()) {
            const full = path.join(localesRoot, name);
            if (isLocaleCode(name) && fs.existsSync(path.join(full, 'anim.config.json'))) out.set(name, { locale: name, dir: full, layout: 'locales' });
        }
    }
    const manifestPath = path.join(dir, 'anim.manifest.json');
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            for (const ev of manifest.history || []) {
                if (ev.command !== 'localize' || !isLocaleCode(ev.locale) || !ev.targetDir || out.has(ev.locale)) continue;
                const full = path.resolve(dir, ev.targetDir);
                if (full.startsWith(path.resolve(localesRoot) + path.sep)) continue;
                if (fs.existsSync(path.join(full, 'anim.config.json'))) out.set(ev.locale, { locale: ev.locale, dir: full, layout: 'sibling' });
            }
        } catch { /* corrupt manifest: ignore */ }
    }
    return [...out.values()];
}

export function toolVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        return `${pkg.name}@${pkg.version}`;
    } catch {
        return 'screenshot-animator';
    }
}
