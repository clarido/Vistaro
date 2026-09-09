import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { isLocaleCode, localizedStringsFiles } from './engine/strings';
import { TimelineKind, TIMELINE_KINDS, DeviceKind, DEVICE_KINDS, resolveConfigPath } from './engine/schema';

/**
 * Files that define a guide's content: index.html, its timeline (`opts.config`, else
 * anim.config.json), that timeline's strings.*.json, and only
 * the local media files index.html actually references (src/href/url()). Generated outputs
 * (animated.html, manifest, preview*.png, exports, guide/) never count.
 */
export function guideSourceFiles(dir: string, opts: { config?: string } = {}): string[] {
    const out = new Set<string>();
    const add = (name: string) => { const full = path.join(dir, name); if (fs.existsSync(full) && fs.statSync(full).isFile()) out.add(full); };
    const addFull = (full: string) => { if (fs.existsSync(full) && fs.statSync(full).isFile()) out.add(full); };
    add('index.html');
    const config = resolveConfigPath(dir, opts.config);
    if (config === path.resolve(dir, 'anim.config.json')) {
        // The historical set, byte for byte: every cached contentHash depends on it not moving.
        add('anim.config.json');
        for (const name of fs.readdirSync(dir)) if (/^strings\.[a-z0-9-]+\.json$/i.test(name)) add(name);
    } else {
        // A scenario hashes its own timeline and its own strings only. Folding in the directory's
        // default config would make an edit to one scenario rebuild every other one.
        addFull(config);
        for (const file of localizedStringsFiles(config)) addFull(file);
    }
    for (const ref of referencedLocalFiles(dir)) add(ref);
    return [...out].sort();
}

/** A src/href/url() reference in an HTML file: as written, and as a decoded path (query/hash stripped). */
export interface HtmlRef { raw: string; file: string }

/**
 * Every relative src="", href="" and url() reference in `html` (http:, data:, protocol-relative
 * and #anchors excluded). A malformed percent sequence keeps the raw text instead of throwing.
 */
export function htmlLocalRefs(html: string): HtmlRef[] {
    const out: HtmlRef[] = [];
    const seen = new Set<string>();
    const re = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const raw = (m[1] || m[2] || '').trim();
        if (!raw || seen.has(raw) || /^(?:[a-z]+:|\/\/|#)/i.test(raw)) continue;
        seen.add(raw);
        out.push({ raw, file: safeDecode(raw.split(/[?#]/)[0]) });
    }
    return out;
}

/** Forward slashes whatever the platform separator is: every path we serialize goes through this. */
export function toPosix(p: string): string {
    return p.split(path.sep).join('/');
}

/** A serialized path: `to` relative to `from`, with forward slashes. */
export function relPosix(from: string, to: string): string {
    return toPosix(path.relative(path.resolve(from), path.resolve(to)));
}

/** A path for a human to read: relative to the working directory when it is inside it, else absolute. */
export function displayPath(p: string): string {
    const r = path.relative(process.cwd(), p);
    return r && !r.startsWith('..') ? r : p;
}

/** decodeURIComponent that falls back to the input on a malformed sequence (a literal "%" in a file name). */
export function safeDecode(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
}

/** Local relative paths referenced from index.html (src="", href="", url()) that resolve inside `dir`. */
export function referencedLocalFiles(dir: string): string[] {
    const indexPath = path.join(dir, 'index.html');
    if (!fs.existsSync(indexPath)) return [];
    const refs = new Set<string>();
    for (const ref of htmlLocalRefs(fs.readFileSync(indexPath, 'utf8'))) {
        const rel = path.relative(dir, path.resolve(dir, ref.file));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) refs.add(toPosix(rel));
    }
    return [...refs].sort();
}

/** `sha256:<hex>` over the guide's source files (names + bytes), for staleness checks. */
export function hashGuideDir(dir: string, opts: { config?: string } = {}): string {
    const h = createHash('sha256');
    for (const file of guideSourceFiles(dir, opts)) {
        h.update(relPosix(dir, file));
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

// ---------------------------------------------------------------------------------------------
// help.catalog.json: the set of guides `build-all` produces, and the index it writes.
// ---------------------------------------------------------------------------------------------

/**
 * Extras beyond the video, which is always produced and always listed: `guide` (guide.json/md/html
 * + step frames, on by default), `gif` (an animated GIF next to the MP4), `clips` (one MP4 per step).
 */
export type CatalogOutput = 'guide' | 'gif' | 'clips' | 'webm' | 'poster' | 'embed';
export const CATALOG_OUTPUTS: readonly CatalogOutput[] = ['guide', 'gif', 'clips', 'webm', 'poster', 'embed'];
export const DEFAULT_OUTPUTS: readonly CatalogOutput[] = ['guide'];
/** A reel has no guide; it ships the formats a page embeds. The MP4 is always produced either way. */
export const DEFAULT_REEL_OUTPUTS: readonly CatalogOutput[] = ['webm', 'poster', 'gif'];

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
    /** Render device: resolves `only`/`mobile`/`desktop` steps and picks the viewport. */
    device?: DeviceKind;
    /** Pixel density: multiplies the viewport and zooms the page back (see ViewportOptions.scale). */
    scale?: number;
}

export interface CatalogDefaults extends RenderSettings {
    locales?: string[];
}

export interface CatalogGuide extends RenderSettings {
    slug: string;
    /** Output profile; a reel skips the guide and ships embeddable formats. Default `guide`. */
    kind?: TimelineKind;
    /** Reels only: build one row per device, e.g. ["desktop", "mobile"]. */
    devices?: DeviceKind[];
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
const SETTING_KEYS = ['outputs', 'width', 'height', 'theme', 'narration', 'crop', 'hideCursor', 'device', 'scale'];
const DEFAULT_KEYS = new Set(['locales', ...SETTING_KEYS]);
const GUIDE_KEYS = new Set(['slug', 'dir', 'locales', 'record', 'title', 'kind', 'devices', ...SETTING_KEYS]);
const OUTPUTS = new Set<string>(CATALOG_OUTPUTS);

export interface EffectiveSettings {
    width?: number; height?: number; theme?: 'light' | 'dark'; crop?: number | false;
    narration: boolean; hideCursor: boolean; outputs: CatalogOutput[];
    device?: DeviceKind; scale?: number;
    /** The profile this entry builds under; drives the default outputs and the guide/no-guide split. */
    kind: TimelineKind;
}

/** Effective settings for a guide: its own values over the catalog defaults. */
export function effectiveSettings(guide: CatalogGuide, defaults: CatalogDefaults = {}): EffectiveSettings {
    const pick = <K extends keyof RenderSettings>(k: K): RenderSettings[K] => (guide[k] !== undefined ? guide[k] : defaults[k]);
    const kind: TimelineKind = guide.kind === 'reel' ? 'reel' : 'guide';
    return {
        width: pick('width'), height: pick('height'), theme: pick('theme'), crop: pick('crop'),
        narration: pick('narration') ?? false, hideCursor: pick('hideCursor') ?? false,
        device: pick('device'), scale: pick('scale'), kind,
        // The legacy "video" entry is implied (readCatalog warns about it) and never an extra.
        outputs: [...new Set(pick('outputs') ?? (kind === 'reel' ? DEFAULT_REEL_OUTPUTS : DEFAULT_OUTPUTS))].filter(o => (o as string) !== 'video'),
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
    if (o.device !== undefined && !DEVICE_KINDS.includes(o.device)) errors.push(`${where}: "device" must be ${DEVICE_KINDS.map(d => `"${d}"`).join(' or ')}`);
    if (o.scale !== undefined && !(typeof o.scale === 'number' && Number.isFinite(o.scale) && o.scale > 0)) errors.push(`${where}: "scale" must be a positive number (e.g. 2)`);
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
    else if (/^~($|[/\\])/.test(raw.outputDir.trim())) {
        // A shell expands this; JSON does not, so it would quietly create a directory named "~".
        errors.push(`"outputDir" ${JSON.stringify(raw.outputDir)} starts with a literal "~": JSON has no shell expansion, so this would create a directory called "~" in the catalog directory. Write the path out.`);
    }
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
        if (g.kind !== undefined && !TIMELINE_KINDS.includes(g.kind)) errors.push(`${where}: "kind" must be ${TIMELINE_KINDS.map(k => `"${k}"`).join(' or ')}`);
        if (g.devices !== undefined) {
            if (!Array.isArray(g.devices) || !g.devices.length) errors.push(`${where}: "devices" must be a non-empty array of ${DEVICE_KINDS.join('/')}`);
            else for (const d of g.devices) if (!DEVICE_KINDS.includes(d)) errors.push(`${where}: unknown device ${JSON.stringify(d)} (${DEVICE_KINDS.join(', ')})`);
        }
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
 * directory itself. Returns the reason on a miss: an explicit path without anim.config.json is its
 * own error, anything else is the hint to run `localize`.
 */
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
    /** Output profile of this entry; absent means the historical guide. */
    kind?: TimelineKind;
    /** Render device, on entries built per device (reels). */
    device?: DeviceKind;
    /**
     * How the clip was rendered, so a reader can reproduce it: the encoded frame size, the pixel
     * density it was recorded at, and the colour scheme. `width`/`height` are the resolved frame,
     * which for a scaled reel is the layout box times `scale` (390x844 at scale 2 encodes 780x1688).
     */
    width?: number;
    height?: number;
    scale?: number;
    theme?: 'light' | 'dark';
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
    webm?: string;
    poster?: string;
    /** embed.html, when the entry asked for the `embed` output. */
    embed?: string;
    guide?: string;
    guideMd?: string;
    guideHtml?: string;
    durationMs?: number;
    steps?: number;
    error?: string;
    ms?: number;
}

/**
 * NOTE ON THE ARRAY NAME: reels live in `guides` alongside help guides. That reads slightly wrong,
 * and it is deliberate -- `guides` is the published contract of index.json v1, and renaming it would
 * break every consumer, while adding fields does not. `kind` distinguishes the two, and the version
 * stays 1 for the same reason.
 */
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
export function mergeIndexEntries(previous: IndexEntry[] | undefined, current: IndexEntry[], keep: { slug: string; locale: string; device?: DeviceKind }[]): IndexEntry[] {
    // The device is part of the identity: a reel built for desktop and mobile is two rows, not one.
    const key = (e: { slug: string; locale: string; device?: DeviceKind }) => `${e.slug} ${e.locale} ${e.device || ''}`;
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
    // Device column: blank for a guide rather than "desktop", because a guide has no device
    // dimension at all -- writing one would assert a fact the entry does not record, and the table
    // already leaves guide/video/notes blank when they do not apply. Without it a reel's two rows
    // render identically and read as an accidental duplicate.
    const rows = index.guides.map(g => `| ${g.slug} | ${g.locale} | ${g.device || ''} | ${g.status}${g.stale ? ' (stale)' : ''} | ${g.guide ? `[guide](${g.guide})` : ''} | ${g.video ? `[video](${g.video})` : ''} | ${g.durationMs ? (g.durationMs / 1000).toFixed(1) + 's' : ''} | ${g.error ? g.error.replace(/\|/g, '\\|') : ''} |`);
    fs.writeFileSync(md, [
        `# Help guides`, '',
        `Generated ${index.generatedAt} by ${index.tool} from \`${index.catalog}\`.`, '',
        `| Guide | Locale | Device | Status | Guide | Video | Length | Notes |`,
        `|---|---|---|---|---|---|---|---|`,
        ...rows, '',
    ].join('\n'));
    return { json, md };
}

/** The package manifest, read once: the CLI's --version and toolVersion() agree by construction. */
export function toolPackage(): { name: string; version: string } {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        if (typeof pkg?.version === 'string') return { name: pkg.name || 'screenshot-animator', version: pkg.version };
    } catch { /* not readable from here (bundled?): fall through */ }
    return { name: 'screenshot-animator', version: '0.0.0' };
}

/** `name@version`, stamped into guide.json and index.json. */
export function toolVersion(): string {
    const pkg = toolPackage();
    return `${pkg.name}@${pkg.version}`;
}
