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

// ---------------------------------------------------------------------------------------------
// help.catalog.json: the set of guides `build-all` produces, and the index it writes.
// ---------------------------------------------------------------------------------------------

export type CatalogOutput = 'video' | 'guide' | 'clips';

export interface CatalogDefaults {
    locales?: string[];
    outputs?: CatalogOutput[];
    width?: number;
    height?: number;
    theme?: 'light' | 'dark';
    narration?: boolean;
    crop?: number | false;
    hideCursor?: boolean;
}

export interface CatalogGuide {
    slug: string;
    /** Source directory (index.html + anim.config.json), relative to the catalog file. */
    dir: string;
    /** Locale codes to produce, or an explicit map { fr: "path/to/fr-dir" }. Default: defaults.locales, else the base locale only. */
    locales?: string[] | Record<string, string>;
    outputs?: CatalogOutput[];
    /** Record against a live page instead of exporting the local mockup. */
    record?: { url: string; storageState?: string; ignoreHttpsErrors?: boolean };
    narration?: boolean;
    width?: number;
    height?: number;
    theme?: 'light' | 'dark';
}

export interface Catalog {
    /** Where build-all writes: <outputDir>/<slug>/<locale>/ plus index.json and index.md. Relative to the catalog file. */
    outputDir: string;
    defaults?: CatalogDefaults;
    guides: CatalogGuide[];
    /** Absolute path of the catalog file (set by readCatalog). */
    file?: string;
}

const CATALOG_KEYS = new Set(['outputDir', 'defaults', 'guides', '$schema', 'title']);
const DEFAULT_KEYS = new Set(['locales', 'outputs', 'width', 'height', 'theme', 'narration', 'crop', 'hideCursor']);
const GUIDE_KEYS = new Set(['slug', 'dir', 'locales', 'outputs', 'record', 'narration', 'width', 'height', 'theme', 'title']);
const OUTPUTS = new Set<string>(['video', 'guide', 'clips']);

/** Read and validate help.catalog.json. Throws with every problem listed. */
export function readCatalog(file: string, warn: (m: string) => void = () => {}): Catalog {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`catalog not found: ${abs}`);
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e: any) { throw new Error(`${abs}: invalid JSON (${e.message})`); }
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${abs}: expected an object with "outputDir" and "guides"`);
    for (const k of Object.keys(raw)) if (!CATALOG_KEYS.has(k)) warn(`${path.basename(abs)}: unknown key "${k}" ignored`);
    if (typeof raw.outputDir !== 'string' || !raw.outputDir.trim()) errors.push('"outputDir" must be a non-empty string');
    if (raw.defaults !== undefined) {
        if (!raw.defaults || typeof raw.defaults !== 'object') errors.push('"defaults" must be an object');
        else for (const k of Object.keys(raw.defaults)) if (!DEFAULT_KEYS.has(k)) warn(`${path.basename(abs)}: unknown defaults key "${k}" ignored`);
    }
    if (!Array.isArray(raw.guides) || raw.guides.length === 0) errors.push('"guides" must be a non-empty array');
    const base = path.dirname(abs);
    const slugs = new Set<string>();
    const guides: CatalogGuide[] = [];
    for (const [i, g] of (Array.isArray(raw.guides) ? raw.guides : []).entries()) {
        const where = `guides[${i}]`;
        if (!g || typeof g !== 'object') { errors.push(`${where} must be an object`); continue; }
        for (const k of Object.keys(g)) if (!GUIDE_KEYS.has(k)) warn(`${path.basename(abs)}: ${where}: unknown key "${k}" ignored`);
        if (typeof g.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(g.slug)) errors.push(`${where}: "slug" must be a lowercase-kebab identifier`);
        else if (slugs.has(g.slug)) errors.push(`${where}: duplicate slug "${g.slug}"`);
        else slugs.add(g.slug);
        if (typeof g.dir !== 'string' || !g.dir) errors.push(`${where}: "dir" is required`);
        else {
            const dir = path.resolve(base, g.dir);
            if (!fs.existsSync(path.join(dir, 'anim.config.json'))) errors.push(`${where} (${g.slug}): ${dir} has no anim.config.json`);
            if (!g.record && !fs.existsSync(path.join(dir, 'index.html'))) errors.push(`${where} (${g.slug}): ${dir} has no index.html (and no "record" url)`);
        }
        if (g.locales !== undefined && !Array.isArray(g.locales) && (typeof g.locales !== 'object' || g.locales === null)) errors.push(`${where}: "locales" must be an array of codes or a { code: path } map`);
        for (const code of Array.isArray(g.locales) ? g.locales : Object.keys(g.locales || {})) if (!isLocaleCode(code)) errors.push(`${where}: "${code}" is not a locale code`);
        for (const o of g.outputs || []) if (!OUTPUTS.has(o)) errors.push(`${where}: unknown output "${o}" (video, guide, clips)`);
        if (g.record !== undefined && (typeof g.record !== 'object' || typeof g.record.url !== 'string')) errors.push(`${where}: "record" needs a "url"`);
        guides.push({ ...g, dir: typeof g.dir === 'string' ? path.resolve(base, g.dir) : g.dir });
    }
    for (const code of raw.defaults?.locales || []) if (!isLocaleCode(code)) errors.push(`defaults.locales: "${code}" is not a locale code`);
    for (const o of raw.defaults?.outputs || []) if (!OUTPUTS.has(o)) errors.push(`defaults.outputs: unknown output "${o}"`);
    if (errors.length) throw new Error(`${abs}:\n  - ${errors.join('\n  - ')}`);
    return { outputDir: path.resolve(base, raw.outputDir), defaults: raw.defaults, guides, file: abs };
}

/**
 * Directory holding `locale` for a guide: an explicit map entry, else `<dir>/locales/<code>/`, else the
 * legacy sibling `<dir>/../<code>/`; the base locale is the guide directory itself.
 */
export function resolveLocaleDir(guide: CatalogGuide, locale: string, baseLocale: string): string | undefined {
    if (locale === baseLocale) return guide.dir;
    if (guide.locales && !Array.isArray(guide.locales) && guide.locales[locale]) {
        const p = path.resolve(path.dirname(guide.dir), guide.locales[locale]);
        return fs.existsSync(path.join(p, 'anim.config.json')) ? p : undefined;
    }
    for (const candidate of [localeDirFor(guide.dir, locale), localeDirFor(guide.dir, locale, { sibling: true })]) {
        if (fs.existsSync(path.join(candidate, 'anim.config.json'))) return candidate;
    }
    return undefined;
}

export interface IndexEntry {
    slug: string;
    locale: string;
    title?: string;
    /** Source directory relative to the catalog. */
    dir: string;
    /** Output directory relative to outputDir. */
    output: string;
    contentHash?: string;
    status: 'ok' | 'failed' | 'skipped';
    /** Set with --diff when the new frames differ from the previous run beyond the threshold. */
    stale?: boolean;
    diff?: { maxFraction: number; threshold: number; steps: Record<string, number> };
    video?: string;
    guide?: string;
    durationMs?: number;
    steps?: number;
    error?: string;
    ms?: number;
}

export interface IndexJson {
    version: 1;
    generatedAt: string;
    tool: string;
    catalog: string;
    guides: IndexEntry[];
}

/** index.json (contract) + index.md (human table) at the root of outputDir. */
export function writeIndex(outputDir: string, index: IndexJson): { json: string; md: string } {
    fs.mkdirSync(outputDir, { recursive: true });
    const json = path.join(outputDir, 'index.json');
    const md = path.join(outputDir, 'index.md');
    fs.writeFileSync(json, JSON.stringify(index, null, 2) + '\n');
    const rows = index.guides.map(g => `| ${g.slug} | ${g.locale} | ${g.status}${g.stale ? ' (stale)' : ''} | ${g.guide ? `[guide](${g.guide})` : ''} | ${g.video ? `[video](${g.video})` : ''} | ${g.durationMs ? (g.durationMs / 1000).toFixed(1) + 's' : ''} | ${g.error ? g.error.replace(/\|/g, '\\|') : ''} |`);
    fs.writeFileSync(md, [
        `# Help guides`, '',
        `Generated ${index.generatedAt} by ${index.tool} from \`${index.catalog}\`.`, '',
        `| Guide | Locale | Status | Guide | Video | Length | Notes |`,
        `|---|---|---|---|---|---|---|`,
        ...rows, '',
    ].join('\n'));
    return { json, md };
}

export function toolVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        return `${pkg.name}@${pkg.version}`;
    } catch {
        return 'screenshot-animator';
    }
}
