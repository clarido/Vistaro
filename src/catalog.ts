import * as fs from 'fs';
import * as os from 'os';
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

/**
 * Extras beyond the video, which is always produced and always listed: `guide` (guide.json/md/html
 * + step frames, on by default), `gif` (an animated GIF next to the MP4), `clips` (one MP4 per step).
 */
export type CatalogOutput = 'guide' | 'gif' | 'clips';
export const CATALOG_OUTPUTS: readonly CatalogOutput[] = ['guide', 'gif', 'clips'];
export const DEFAULT_OUTPUTS: readonly CatalogOutput[] = ['guide'];

/** Render settings, valid in `defaults` and per guide (the guide wins). */
export interface RenderSettings {
    width?: number;
    height?: number;
    theme?: 'light' | 'dark';
    narration?: boolean;
    /** Guide crops: padding in px around each step's box, or false for full frames only. */
    crop?: number | false;
    hideCursor?: boolean;
    outputs?: CatalogOutput[];
}

export interface CatalogDefaults extends RenderSettings {
    locales?: string[];
}

export interface CatalogGuide extends RenderSettings {
    slug: string;
    /** Source directory (index.html + anim.config.json); relative to the catalog file, absolute after readCatalog. */
    dir: string;
    /** Shown in the index; defaults to the timeline's meta.title. */
    title?: string;
    /** Locale codes to produce, or an explicit map { fr: "path/to/fr-dir" } (paths relative to the catalog file, absolute after readCatalog). Default: defaults.locales, else the base locale only. */
    locales?: string[] | Record<string, string>;
    /** Record against a live page instead of exporting the local mockup. storageState is relative to the catalog file (absolute after readCatalog). */
    record?: { url: string; storageState?: string; ignoreHttpsErrors?: boolean };
}

export interface Catalog {
    /** Where build-all writes: <outputDir>/<slug>/<locale>/ plus index.json and index.md. Relative to the catalog file. */
    outputDir: string;
    defaults?: CatalogDefaults;
    guides: CatalogGuide[];
    /** Absolute path of the catalog file (set by readCatalog). */
    file?: string;
}

const CATALOG_KEYS = new Set(['outputDir', 'defaults', 'guides', '$schema', 'title', 'version']);
const SETTING_KEYS = ['outputs', 'width', 'height', 'theme', 'narration', 'crop', 'hideCursor'];
const DEFAULT_KEYS = new Set(['locales', ...SETTING_KEYS]);
const GUIDE_KEYS = new Set(['slug', 'dir', 'locales', 'record', 'title', ...SETTING_KEYS]);
const OUTPUTS = new Set<string>(CATALOG_OUTPUTS);

export interface EffectiveSettings {
    width?: number; height?: number; theme?: 'light' | 'dark'; crop?: number | false;
    narration: boolean; hideCursor: boolean; outputs: CatalogOutput[];
}

/** Effective settings for a guide: its own values over the catalog defaults. */
export function effectiveSettings(guide: CatalogGuide, defaults: CatalogDefaults = {}): EffectiveSettings {
    const pick = <K extends keyof RenderSettings>(k: K): RenderSettings[K] => (guide[k] !== undefined ? guide[k] : defaults[k]);
    return {
        width: pick('width'), height: pick('height'), theme: pick('theme'), crop: pick('crop'),
        narration: pick('narration') ?? false, hideCursor: pick('hideCursor') ?? false,
        // The legacy "video" entry is implied (readCatalog warns about it) and never an extra.
        outputs: [...new Set(pick('outputs') ?? DEFAULT_OUTPUTS)].filter(o => (o as string) !== 'video'),
    };
}

/** Type-check one settings object (defaults or a guide); `where` prefixes every message. */
function validateSettings(o: any, where: string, errors: string[], warn: (m: string) => void): void {
    const isInt = (v: any) => typeof v === 'number' && Number.isInteger(v) && v > 0;
    if (o.width !== undefined && !isInt(o.width)) errors.push(`${where}: "width" must be a positive integer`);
    if (o.height !== undefined && !isInt(o.height)) errors.push(`${where}: "height" must be a positive integer`);
    if (o.theme !== undefined && o.theme !== 'light' && o.theme !== 'dark') errors.push(`${where}: "theme" must be "light" or "dark"`);
    if (o.narration !== undefined && typeof o.narration !== 'boolean') errors.push(`${where}: "narration" must be true or false`);
    if (o.hideCursor !== undefined && typeof o.hideCursor !== 'boolean') errors.push(`${where}: "hideCursor" must be true or false`);
    if (o.crop !== undefined && o.crop !== false && !(typeof o.crop === 'number' && Number.isFinite(o.crop) && o.crop >= 0)) errors.push(`${where}: "crop" must be a padding in px (>= 0) or false`);
    if (o.outputs !== undefined) {
        if (!Array.isArray(o.outputs)) errors.push(`${where}: "outputs" must be an array (e.g. ["guide", "gif"])`);
        else for (const x of o.outputs) {
            if (x === 'video') warn(`${where}: output "video" is implied (the video is always produced and listed); the extras are ${CATALOG_OUTPUTS.join(', ')}`);
            else if (!OUTPUTS.has(x)) errors.push(`${where}: unknown output "${x}" (${CATALOG_OUTPUTS.join(', ')})`);
        }
    }
}

/** Why an outputDir is refused: the root, the home dir, the catalog dir, or overlapping a guide dir. */
export function outputDirProblem(outputDir: string, catalogDir: string, guideDirs: string[]): string | undefined {
    const out = path.resolve(outputDir);
    const within = (a: string, b: string) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
    if (out === path.parse(out).root) return `"outputDir" must not be the filesystem root`;
    if (out === path.resolve(os.homedir())) return `"outputDir" must not be the home directory`;
    if (out === path.resolve(catalogDir)) return `"outputDir" must not be the catalog directory itself (build-all writes index.json and one directory per guide there)`;
    for (const g of guideDirs) {
        const dir = path.resolve(g);
        if (within(out, dir)) return `"outputDir" (${out}) is inside guide directory ${dir}; build-all would write outputs into a guide's sources`;
        if (within(dir, out)) return `"outputDir" (${out}) contains guide directory ${dir}; build-all output must not overlap the guide sources`;
    }
    return undefined;
}

/** Read and validate help.catalog.json. Throws with every problem listed. */
export function readCatalog(file: string, warn: (m: string) => void = () => {}): Catalog {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) throw new Error(`catalog not found: ${abs}`);
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e: any) { throw new Error(`${abs}: invalid JSON (${e.message})`); }
    const errors: string[] = [];
    const name = path.basename(abs);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${abs}: expected an object with "outputDir" and "guides"`);
    for (const k of Object.keys(raw)) if (!CATALOG_KEYS.has(k)) warn(`${name}: unknown key "${k}" ignored`);
    if (typeof raw.outputDir !== 'string' || !raw.outputDir.trim()) errors.push('"outputDir" must be a non-empty string');
    if (raw.defaults !== undefined) {
        if (!raw.defaults || typeof raw.defaults !== 'object' || Array.isArray(raw.defaults)) errors.push('"defaults" must be an object');
        else {
            for (const k of Object.keys(raw.defaults)) if (!DEFAULT_KEYS.has(k)) warn(`${name}: unknown defaults key "${k}" ignored`);
            if (raw.defaults.locales !== undefined && !Array.isArray(raw.defaults.locales)) errors.push('defaults.locales must be an array of locale codes');
            for (const code of Array.isArray(raw.defaults.locales) ? raw.defaults.locales : []) if (!isLocaleCode(code)) errors.push(`defaults.locales: "${code}" is not a locale code`);
            validateSettings(raw.defaults, 'defaults', errors, m => warn(`${name}: ${m}`));
        }
    }
    if (!Array.isArray(raw.guides) || raw.guides.length === 0) errors.push('"guides" must be a non-empty array');
    const base = path.dirname(abs);
    const slugs = new Set<string>();
    const guides: CatalogGuide[] = [];
    for (const [i, g] of (Array.isArray(raw.guides) ? raw.guides : []).entries()) {
        const where = `guides[${i}]`;
        if (!g || typeof g !== 'object') { errors.push(`${where} must be an object`); continue; }
        for (const k of Object.keys(g)) if (!GUIDE_KEYS.has(k)) warn(`${name}: ${where}: unknown key "${k}" ignored`);
        if (typeof g.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(g.slug)) errors.push(`${where}: "slug" must be a lowercase-kebab identifier`);
        else if (slugs.has(g.slug)) errors.push(`${where}: duplicate slug "${g.slug}"`);
        else slugs.add(g.slug);
        if (g.title !== undefined && typeof g.title !== 'string') errors.push(`${where}: "title" must be a string`);
        if (typeof g.dir !== 'string' || !g.dir) errors.push(`${where}: "dir" is required`);
        else {
            const dir = path.resolve(base, g.dir);
            if (!fs.existsSync(path.join(dir, 'anim.config.json'))) errors.push(`${where} (${g.slug}): ${dir} has no anim.config.json`);
            if (!g.record && !fs.existsSync(path.join(dir, 'index.html'))) errors.push(`${where} (${g.slug}): ${dir} has no index.html (and no "record" url)`);
        }
        let locales = g.locales;
        if (locales !== undefined && !Array.isArray(locales) && (typeof locales !== 'object' || locales === null)) errors.push(`${where}: "locales" must be an array of codes or a { code: path } map`);
        for (const code of Array.isArray(locales) ? locales : Object.keys(locales || {})) if (!isLocaleCode(code)) errors.push(`${where}: "${code}" is not a locale code`);
        if (locales && !Array.isArray(locales) && typeof locales === 'object') {
            // Explicit map paths are relative to the catalog file, like "dir".
            const resolved: Record<string, string> = {};
            for (const [code, p] of Object.entries(locales)) {
                if (typeof p !== 'string' || !p) { errors.push(`${where}: locales.${code} must be a path`); continue; }
                resolved[code] = path.resolve(base, p);
            }
            locales = resolved;
        }
        validateSettings(g, where, errors, m => warn(`${name}: ${m}`));
        let record = g.record;
        if (record !== undefined) {
            if (!record || typeof record !== 'object' || typeof record.url !== 'string' || !record.url) errors.push(`${where}: "record" needs a "url"`);
            else {
                if (record.ignoreHttpsErrors !== undefined && typeof record.ignoreHttpsErrors !== 'boolean') errors.push(`${where}: record.ignoreHttpsErrors must be true or false`);
                if (record.storageState !== undefined) {
                    if (typeof record.storageState !== 'string' || !record.storageState) errors.push(`${where}: record.storageState must be a path`);
                    else {
                        const ss = path.resolve(base, record.storageState);
                        if (!fs.existsSync(ss)) errors.push(`${where} (${g.slug}): record.storageState ${ss} does not exist (save one with \`npx playwright codegen --save-storage\`)`);
                        record = { ...record, storageState: ss };
                    }
                }
            }
        }
        guides.push({ ...g, dir: typeof g.dir === 'string' ? path.resolve(base, g.dir) : g.dir, locales, record });
    }
    if (typeof raw.outputDir === 'string' && raw.outputDir.trim()) {
        const problem = outputDirProblem(path.resolve(base, raw.outputDir), base, guides.map(g => g.dir).filter(d => typeof d === 'string'));
        if (problem) errors.push(problem);
    }
    if (errors.length) throw new Error(`${abs}:\n  - ${errors.join('\n  - ')}`);
    return { outputDir: path.resolve(base, raw.outputDir), defaults: raw.defaults, guides, file: abs };
}

export interface LocaleResolution { dir?: string; error?: string }

/**
 * Directory holding `locale` for a guide: an explicit map entry (absolute after readCatalog), else
 * `<dir>/locales/<code>/`, else the legacy sibling `<dir>/../<code>/`; the base locale is the guide
 * directory itself. An explicit path without anim.config.json is its own error; otherwise the hint is to run localize.
 */
export function resolveLocaleDir(guide: CatalogGuide, locale: string, baseLocale: string): string | undefined {
    return locateLocaleDir(guide, locale, baseLocale).dir;
}

export function locateLocaleDir(guide: CatalogGuide, locale: string, baseLocale: string): LocaleResolution {
    if (locale === baseLocale) return { dir: guide.dir };
    if (guide.locales && !Array.isArray(guide.locales) && guide.locales[locale]) {
        const p = path.resolve(guide.locales[locale]);
        if (fs.existsSync(path.join(p, 'anim.config.json'))) return { dir: p };
        return { error: `locales.${locale} points at ${p}, which has no anim.config.json` };
    }
    for (const candidate of [localeDirFor(guide.dir, locale), localeDirFor(guide.dir, locale, { sibling: true })]) {
        if (fs.existsSync(path.join(candidate, 'anim.config.json'))) return { dir: candidate };
    }
    return { error: `no directory for locale "${locale}"` };
}

export interface IndexEntry {
    slug: string;
    locale: string;
    title?: string;
    /** Source directory relative to the catalog. */
    dir: string;
    /** Output directory relative to outputDir. */
    output: string;
    /** sha256 of the guide's sources (index.html, anim.config.json, strings, referenced media). */
    contentHash?: string;
    /** What --changed-only compares: contentHash + effective render settings + tool version. */
    buildKey?: string;
    status: 'ok' | 'failed' | 'skipped';
    /** When this entry's outputs were last built (ISO); carried over on skipped entries. */
    builtAt?: string;
    /** Set with --diff when the new frames differ from the previous run beyond the threshold (carried over on skipped entries). */
    stale?: boolean;
    diff?: { maxFraction: number; threshold: number; steps: Record<string, number> };
    /** Paths relative to outputDir. */
    video?: string;
    vtt?: string;
    gif?: string;
    poster?: string;
    guide?: string;
    guideMd?: string;
    guideHtml?: string;
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

/** The previous index.json in outputDir, if it parses; its entries survive a partial run. */
export function readIndex(outputDir: string): IndexJson | undefined {
    const file = path.join(outputDir, 'index.json');
    if (!fs.existsSync(file)) return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.guides)) return parsed as IndexJson;
    } catch { /* unreadable: rebuilt from this run */ }
    return undefined;
}

/**
 * Merge this run's entries into the previous index by (slug, locale): entries this run did not
 * touch stay as they were; entries no longer in the catalog (`keep`) are dropped; order follows the catalog.
 */
export function mergeIndexEntries(previous: IndexEntry[] | undefined, current: IndexEntry[], keep: { slug: string; locale: string }[]): IndexEntry[] {
    const key = (e: { slug: string; locale: string }) => `${e.slug} ${e.locale}`;
    const byKey = new Map<string, IndexEntry>();
    for (const e of previous || []) byKey.set(key(e), e);
    for (const e of current) byKey.set(key(e), e);
    return keep.map(k => byKey.get(key(k))).filter((e): e is IndexEntry => !!e);
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
