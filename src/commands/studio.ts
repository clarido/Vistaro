import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseTimeline, validateTimeline, formatIssue, loadTimeline, hasErrors, Issue, resolveConfigPath, Timeline, applyDevice, subtitleWindows, computeDurationMs, intrinsicDurationMs } from '../engine/schema';
import { buildTourPage } from '../engine/inject';
import { localizedStringsFiles, readStrings, writeStrings, stringsPathFor } from '../engine/strings';
import { CONFIG_SCAFFOLD, REEL_SCAFFOLD } from './init-config';
import { browserCheck } from './check';
import { runExport } from './export';
import { displayPath } from '../catalog';

/**
 * `studio <dir>`: the local web editor over the timeline -- a view over anim.config.json, never a
 * second source of truth. Serves, on 127.0.0.1:
 *
 *   GET  /               the editor page (src/studio/app/*, served from disk)
 *   GET  /preview        the mockup as a tour-style page (runtime + tour bridge + studio bridge),
 *                        driven seekably by the editor over postMessage
 *   GET  /api/timeline   the RAW timeline JSON (unknown fields intact) + whether it exists
 *   PUT  /api/timeline   validate -> 422 with issues, or write the file (+ strings-key renames)
 *   GET  /api/scaffolds  the guide/reel scaffolds (same ones `init-config` writes)
 *   POST /api/check      run the check passes in-process (serial) and return the Issue[]
 *   POST /api/export     run the export pipeline in-process (serial) into <dir>/studio.* artifacts
 *
 * Design notes. check/export run IN-PROCESS -- browserCheck and runExport are the exported seams
 * the `verify` command already composes -- so no CLI child is spawned from src/ (which would join
 * an allowlist gated on JF's explicit go) and the browser jobs serialize naturally behind one
 * mutex (one browser-driven job at a time, the repo law). The timeline API hands the editor the
 * raw JSON and validates on a deep copy: the file's unknown fields (the schema is open) must
 * survive a studio round-trip byte for byte. The action's promise never resolves -- a listening
 * server keeps the process alive, and cli.ts's exitWhenDrained watchdog only arms after the
 * command settles, so nothing else is needed to keep the server up.
 */

/** ------------------------------------------------------------------ project scanner
 * The index of everything editable: screens (index.html + anim.config.json), the scenario
 * timelines beside them, and anything a catalog names. This is what the picker shows, what
 * `demos` prints, and what the editor's scenario switcher lists. */
export interface ScannedProject {
    /** Stable id (hash of dir+config) -- the ONLY thing requests may name a project by. */
    id: string;
    /** Repo-relative directory (display + the demos command's --dir). */
    dir: string;
    /** Absolute config path (the server's own key; never sent to the page). */
    configFile: string;
    /** Config basename when this is a scenario timeline (else 'anim.config.json'). */
    configName: string;
    title: string;
    kind: 'guide' | 'reel';
    /** The dir feeds a tour catalog scenario (badge in the picker). */
    tour: boolean;
    locales: string[];
    devices: string[];
    steps: number;
    lastTouched: string | null;
}

// test/docs/saas carry fixtures and prose, not demos; website/ IS walked (the pair rule keeps
// its marketing-site root out while website/src/reel -- the hero clip -- is a real project).
const SCAN_SKIP = new Set(['node_modules', '.git', '.zcode', 'test', 'docs', 'saas']);
const isOutputDir = (name: string) => name.endsWith('-out');

export function scanProjects(root: string): ScannedProject[] {
    const projects: ScannedProject[] = [];
    const tourDirs = new Set<string>();
    const catalogConfigs = new Set<string>(); // absolute config paths named by a catalog
    const readJson = (file: string): any | null => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    };

    for (const catalogName of ['help.catalog.json', 'tour.catalog.json']) {
        const catalog = readJson(path.join(root, catalogName));
        if (!catalog || typeof catalog !== 'object') continue;
        const entries = [...(Array.isArray(catalog.guides) ? catalog.guides : []), ...(Array.isArray(catalog.scenarios) ? catalog.scenarios : [])];
        for (const entry of entries) {
            if (!entry || typeof entry.dir !== 'string') continue;
            const dirAbs = path.resolve(root, entry.dir);
            if (catalogName.startsWith('tour.')) tourDirs.add(path.relative(root, dirAbs));
            if (typeof entry.config === 'string') catalogConfigs.add(path.resolve(root, entry.config));
        }
    }

    let dirsVisited = 0;
    const walk = (rel: string, depth: number): void => {
        if (depth > 4 || dirsVisited > 2000) return;
        dirsVisited++;
        const abs = path.join(root, rel);
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (SCAN_SKIP.has(entry.name) || entry.name === 'locales' || isOutputDir(entry.name) || entry.name.startsWith('.')) continue;
            walk(rel ? path.join(rel, entry.name) : entry.name, depth + 1);
        }
        // A screen: both files at this level (the pair rule filters every output dir).
        const hasScreen = entries.some(e => e.name === 'index.html' && e.isFile());
        const hasDefaultConfig = entries.some(e => e.name === 'anim.config.json' && e.isFile());
        if (!hasScreen || !hasDefaultConfig) return;

        const configs: string[] = [path.join(abs, 'anim.config.json')];
        // Scenario timelines: the scenarios/ convention + anything a catalog names in this dir.
        const scenariosDir = path.join(abs, 'scenarios');
        try {
            for (const f of fs.readdirSync(scenariosDir)) {
                if (/\.strings\./.test(f) || !f.endsWith('.json')) continue;
                configs.push(path.join(scenariosDir, f));
            }
        } catch { /* no scenarios/ */ }
        for (const cfg of catalogConfigs) {
            if (path.dirname(cfg) === abs && !configs.includes(cfg)) configs.push(cfg);
        }

        for (const configFile of configs) {
            const raw = readJson(configFile);
            const meta = (raw && typeof raw === 'object' && raw.meta && typeof raw.meta === 'object') ? raw.meta : {};
            const steps = Array.isArray(raw?.steps) ? raw.steps.length : 0;
            // Locale flags: strings files beside THIS config + localize directories.
            const locales = new Set<string>();
            try {
                for (const f of fs.readdirSync(path.dirname(configFile))) {
                    const m = /^(?:[\w-]+\.)?strings\.([\w-]+)\.json$/.exec(f);
                    if (m) locales.add(m[1]);
                }
            } catch { /* ignore */ }
            const baseName = path.basename(configFile);
            try {
                for (const f of fs.readdirSync(path.dirname(configFile))) {
                    const m = new RegExp('^' + baseName.replace(/\./g, '\\.') + '\\.strings\\.([\\w-]+)\\.json$').exec(f);
                    if (m) locales.add(m[1]);
                }
            } catch { /* ignore */ }
            try {
                for (const d of fs.readdirSync(path.join(abs, 'locales'), { withFileTypes: true })) {
                    if (d.isDirectory()) locales.add(d.name);
                }
            } catch { /* no locales/ */ }
            locales.delete(String(meta.locale ?? 'en'));
            // Devices: any only/mobile/desktop key in the steps.
            const devices = new Set<string>();
            for (const st of (Array.isArray(raw?.steps) ? raw.steps : [])) {
                if (st && typeof st === 'object') {
                    if (st.only === 'mobile' || st.only === 'desktop') devices.add(st.only);
                    if (st.mobile) devices.add('mobile');
                    if (st.desktop) devices.add('desktop');
                }
            }
            // Recency: the manifest's newest history timestamp, else the config's mtime.
            let lastTouched: string | null = null;
            const manifest = readJson(path.join(abs, 'anim.manifest.json'));
            if (manifest && Array.isArray(manifest.history)) {
                for (const ev of manifest.history) {
                    if (ev && typeof ev.timestamp === 'string' && (!lastTouched || ev.timestamp > lastTouched)) lastTouched = ev.timestamp;
                }
            }
            if (!lastTouched) {
                try { lastTouched = fs.statSync(configFile).mtime.toISOString(); } catch { /* keep null */ }
            }
            projects.push({
                id: crypto.createHash('sha256').update(path.resolve(configFile)).digest('hex').slice(0, 10),
                dir: path.relative(root, abs),
                configFile,
                configName: baseName,
                title: String(meta.title ?? path.basename(abs)),
                kind: meta.kind === 'reel' ? 'reel' : 'guide',
                tour: tourDirs.has(path.relative(root, abs)),
                locales: [...locales].sort(),
                devices: [...devices].sort(),
                steps,
                lastTouched,
            });
        }
    };

    walk('', 0);
    projects.sort((a, b) => (b.lastTouched ?? '').localeCompare(a.lastTouched ?? ''));
    return projects;
}

export interface StudioOptions {
    port?: string;
    config?: string;
    /** Initial preview device (desktop | mobile); also sizes the preview viewport. */
    device?: string;
    /** The preview iframe's authored viewport (the recording size the mockup is written for). */
    width?: string;
    height?: string;
    /** Boot as the `vistaro` front door: announce + open /hub (the ask, the manual, the doors). */
    hub?: boolean;
}

const APP_DIR = path.resolve(__dirname, '../studio/app');
const BODY_LIMIT = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};

class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(data + '\n');
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        req.on('data', (c: Buffer) => {
            if (done) return;
            total += c.length;
            if (total > BODY_LIMIT) {
                done = true;
                reject(new HttpError(413, 'request body too large'));
                req.resume();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
        req.on('error', (e) => { if (!done) reject(e); });
    });
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        return parsed;
    } catch {
        throw new HttpError(400, 'request body must be a JSON object');
    }
}

/** Serve a file from the editor's app directory; the path is fixed by the router, never user input. */
function serveAppFile(res: http.ServerResponse, name: string): void {
    const file = path.join(APP_DIR, name);
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    let data: Buffer;
    try {
        data = fs.readFileSync(file);
    } catch {
        json(res, 404, { error: `missing editor asset: ${name}` });
        return;
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
}

/** One browser-driven job at a time (the repo law): check and export queue behind this mutex. */
class OneAtATime {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(job: () => Promise<T>): Promise<T> {
        const result = this.tail.then(job, job);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

function readRawTimeline(configPath: string): { exists: boolean; raw: Record<string, unknown> | null; rawText?: string; mtimeMs?: number } {
    if (!fs.existsSync(configPath)) return { exists: false, raw: null };
    const text = fs.readFileSync(configPath, 'utf8');
    const mtimeMs = fs.statSync(configPath).mtimeMs;
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { exists: true, raw: { meta: {}, steps: [] }, mtimeMs };
        }
        return { exists: true, raw: parsed as Record<string, unknown>, mtimeMs };
    } catch (e: any) {
        // A broken file is exactly when the editor is most useful: the parse error plus the file's
        // own text travel to the editor, which offers a whole-file raw view to fix it in.
        return { exists: true, raw: { meta: {}, steps: [], __parseError: e?.message ?? String(e) }, rawText: text, mtimeMs };
    }
}

/** For each device, the authored step indices that survive resolution, in play order -- the
 *  editor seeks through this map and never re-implements applyDevice's rules. */
function deviceMap(raw: Record<string, unknown> | null): Record<string, { positions: number[]; total: number } | null> {
    const out: Record<string, { positions: number[]; total: number } | null> = {};
    for (const device of ['desktop', 'mobile'] as const) {
        // null (not an empty resolution) when there is nothing to resolve or it will not parse:
        // the editor falls back to the authored list instead of flagging every step "not played".
        if (!raw) { out[device] = null; continue; }
        try {
            const resolved = applyDevice(parseTimeline(JSON.parse(JSON.stringify(raw))), device);
            out[device] = { positions: resolved.steps.map(st => st.index), total: resolved.steps.length };
        } catch {
            out[device] = null;
        }
    }
    return out;
}

/** What the editor's timeline ruler draws, per device -- derived from the SAME schema helpers the
 *  export path runs, so the studio never re-implements duration or subtitle-window math. Steps
 *  keep their authored 1-based index; a step an `only:` dropped carries `dropped: true` with its
 *  authored time (rendered dimmed, not seekable) and no duration. `timeMs` is null for a time the
 *  parser rejects (validation already reports it). null per device when the timeline will not
 *  parse, like deviceMap. */
interface ComputedStep {
    authoredIndex: number;
    id: string;
    action: string;
    timeMs: number | null;
    intrinsicMs: number;
    dropped?: boolean;
}
function computedFor(raw: Record<string, unknown> | null): Record<string, { durationMs: number; steps: ComputedStep[]; subtitles: { index: number; startMs: number; endMs: number }[] } | null> {
    const out: Record<string, { durationMs: number; steps: ComputedStep[]; subtitles: { index: number; startMs: number; endMs: number }[] } | null> = {};
    for (const device of ['desktop', 'mobile'] as const) {
        if (!raw) { out[device] = null; continue; }
        try {
            const authored = parseTimeline(JSON.parse(JSON.stringify(raw)));
            const resolved = applyDevice(parseTimeline(JSON.parse(JSON.stringify(raw))), device);
            const byIndex = new Map(resolved.steps.map(s => [s.index, s]));
            const steps: ComputedStep[] = authored.steps.map((s) => {
                const live = byIndex.get(s.index);
                if (!live) {
                    return { authoredIndex: s.index, id: s.id, action: s.action, timeMs: Number.isFinite(s.timeMs) ? s.timeMs : null, intrinsicMs: 0, dropped: true };
                }
                return { authoredIndex: s.index, id: live.id, action: live.action, timeMs: Number.isFinite(live.timeMs) ? live.timeMs : null, intrinsicMs: intrinsicDurationMs(live) };
            });
            out[device] = {
                durationMs: computeDurationMs(resolved),
                steps,
                subtitles: subtitleWindows(resolved).map(w => ({ index: w.index, startMs: w.startMs, endMs: w.endMs })),
            };
        } catch {
            out[device] = null;
        }
    }
    return out;
}

/** Locale codes this demo owns, across BOTH conventions: a strings.<locale>.json beside the
 *  config (the scenario-config style) and a locales/<locale>/ directory (the `localize` flow,
 *  which carries a translated screen too). */
function availableLocales(absDir: string, configFile: string): string[] {
    const codes: string[] = [];
    for (const file of localizedStringsFiles(configFile)) {
        const m = /(?:^|\.)strings\.([\w-]+)\.json$/.exec(path.basename(file));
        if (m) codes.push(m[1]);
    }
    const localesRoot = path.join(absDir, 'locales');
    try {
        for (const entry of fs.readdirSync(localesRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && /^[\w-]{2,16}$/.test(entry.name)) codes.push(entry.name);
        }
    } catch { /* no locales/ directory */ }
    return [...new Set(codes)].sort();
}

/** The directory a `localize`-scaffolded locale lives in, when it is THIS config's locale home:
 *  localize copies the default anim.config.json (never scenario configs, localize.ts:61-74), so a
 *  stem config must fall through to the beside-config strings file even when a locales/ dir exists. */
function localeDir(absDir: string, configFile: string, locale: string): string | null {
    const dir = path.join(absDir, 'locales', locale);
    return fs.existsSync(path.join(dir, path.basename(configFile))) ? dir : null;
}

/** Where a locale's strings file is: the localize directory's own copy when it exists (its
 *  screen is translated too), else the beside-config file (the scenario convention). */
function stringsFileFor(absDir: string, configFile: string, locale: string): string {
    const inDir = localeDir(absDir, configFile, locale);
    if (inDir) return stringsPathFor(path.join(inDir, path.basename(configFile)), locale);
    return stringsPathFor(configFile, locale);
}

/** Static validation on a deep copy: the caller's raw object is never touched by the parser. */
function staticIssues(raw: Record<string, unknown>): Issue[] {
    try {
        return validateTimeline(parseTimeline(JSON.parse(JSON.stringify(raw))), {});
    } catch (e: any) {
        return [{ level: 'error', message: e?.message ?? String(e) }];
    }
}

/** Every strings file this config's translations live in: beside the config (any locale, any
 *  stem) AND inside each localize-scaffolded locales/<locale>/ directory. */
function allStringsFiles(absDir: string, configFile: string): string[] {
    const files = [...localizedStringsFiles(configFile)];
    for (const locale of availableLocales(absDir, configFile)) {
        const dir = localeDir(absDir, configFile, locale);
        if (!dir) continue;
        const file = stringsPathFor(path.join(dir, path.basename(configFile)), locale);
        if (!files.includes(file)) files.push(file);
    }
    return files;
}

/** `steps.<old>.*` -> `steps.<new>.*` in every strings file this config's translations live in. */
function applyRenames(absDir: string, configFile: string, renames: { from: string; to: string }[]): string[] {
    const touched: string[] = [];
    if (!renames.length) return touched;
    const prefix = (id: string) => `steps.${id}.`;
    for (const file of allStringsFiles(absDir, configFile)) {
        let map;
        try { map = readStrings(file); } catch { continue; }
        let changed = false;
        for (const { from, to } of renames) {
            if (from === to || !from || !to) continue;
            for (const key of Object.keys(map)) {
                if (key.startsWith(prefix(from))) {
                    map[prefix(to) + key.slice(prefix(from).length)] = map[key];
                    delete map[key];
                    changed = true;
                }
            }
        }
        if (changed) {
            writeStrings(file, map);
            touched.push(path.relative(path.dirname(configFile), file) || path.basename(file));
        }
    }
    return touched;
}

/** Keys in the strings files that no longer name a step or meta.title -- reported, never dropped. */
function orphanKeys(absDir: string, configFile: string, raw: Record<string, unknown>): string[] {
    const steps = Array.isArray(raw.steps) ? raw.steps : [];
    const ids = new Set<string>(steps.map((s: any) => String(s?.id ?? '')).filter(Boolean));
    const orphans: string[] = [];
    for (const file of allStringsFiles(absDir, configFile)) {
        let map;
        try { map = readStrings(file); } catch { continue; }
        for (const key of Object.keys(map)) {
            if (key === 'meta.title') continue;
            const m = /^steps\.([^.]+)\./.exec(key);
            if (m && !ids.has(m[1])) {
                orphans.push(`translation key "${key}" in ${path.basename(file)} matches no step id (renamed or deleted: "${m[1]}") -- translations attach to ids, not positions`);
            }
        }
    }
    return orphans;
}

/** ------------------------------------------------------------------ mockup patcher
 * Layout mode edits the screen: inline-style patches on the Nth occurrence of a tag in
 * index.html. Style-attribute-only by design (diffable in git), and guarded twice: the live
 * DOM's tag count must still match the file's (structure drift refuses rather than patches the
 * wrong element), and the same mtime check as timeline saves protects concurrent editors. */
interface MockupPatch {
    tag: string;
    index: number;
    domCount: number;
    patch: Record<string, string>;
}

/** Mask HTML comments and <script> bodies with same-length spaces: indices into the mask are
 *  indices into the original, so searches skip tags that only exist inside prose or JS strings
 *  (a balanced-but-wrong count is exactly the drift the structure guard exists to catch). */
function maskMarkup(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
        .replace(/<script\b[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length));
}

/** The Nth `<tag ...>` open tag's [start, end-after-'>'] span, quote-tolerant. -1 when absent. */
function nthOpenTag(html: string, tag: string, index: number): [number, number] | null {
    const needle = '<' + tag;
    let from = 0;
    let seen = -1;
    for (;;) {
        const start = html.indexOf(needle, from);
        if (start === -1) return null;
        const after = html.charAt(start + needle.length);
        if (after === '' || /\s/.test(after) || after === '>') {
            seen++;
            if (seen === index) {
                // Walk to the tag's '>', skipping quoted attribute values.
                let quote = '';
                for (let i = start; i < html.length; i++) {
                    const c = html.charAt(i);
                    if (quote) { if (c === quote) quote = ''; continue; }
                    if (c === '"' || c === "'") { quote = c; continue; }
                    if (c === '>') return [start, i + 1];
                }
                return null;
            }
        }
        from = start + needle.length;
    }
}

function countOpenTags(html: string, tag: string): number {
    const needle = '<' + tag;
    let count = 0;
    let from = 0;
    for (;;) {
        const start = html.indexOf(needle, from);
        if (start === -1) return count;
        const after = html.charAt(start + needle.length);
        if (after === '' || /\s/.test(after) || after === '>') count++;
        from = start + needle.length;
    }
}

function patchMockup(html: string, patches: MockupPatch[]): { html: string; applied: number; refused?: string } {
    let out = html;
    let applied = 0;
    for (const p of patches) {
        if (!/^\w[\w-]*$/.test(p.tag ?? '') || typeof p.index !== 'number' || p.index < 0) {
            return { html, applied, refused: `bad patch key (${p.tag} #${p.index})` };
        }
        // The values are written into style="..." in the user's source file: a quote breaks out
        // of the attribute (script injection into every later export), and < / & corrupt the
        // markup. Geometry values never need them; anything that has them is refused.
        for (const [key, value] of Object.entries(p.patch ?? {})) {
            if (!/^[a-zA-Z-][\w-]*$/.test(key) || /["<>&]/.test(String(value))) {
                return { html, applied, refused: `refused style patch "${key}: ${value}" -- property names must be plain CSS identifiers and values must not contain quotes, < or &` };
            }
        }
        const fileCount = countOpenTags(maskMarkup(out), p.tag);
        if (fileCount !== p.domCount) {
            return {
                html, applied,
                refused: `index.html has ${fileCount} <${p.tag}> but the page shows ${p.domCount} -- the file and the page have drifted (a script built DOM, or the file was edited); edit that element by hand`,
            };
        }
        const span = nthOpenTag(maskMarkup(out), p.tag, p.index);
        if (!span) return { html, applied, refused: `cannot find <${p.tag}> #${p.index} in index.html` };
        const openTag = out.slice(span[0], span[1]);
        const patched = insertStyleAttr(openTag, p.patch);
        out = out.slice(0, span[0]) + patched + out.slice(span[1]);
        applied++;
    }
    return { html: out, applied };
}

/** style-attribute insert/merge that keeps the open tag's other attributes byte-identical. */
function insertStyleAttr(openTag: string, patch: Record<string, string>): string {
    const entries: [string, string][] = [];
    const styleMatch = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(openTag);
    if (styleMatch) {
        const body = styleMatch[2] ?? styleMatch[3] ?? '';
        for (const decl of body.split(';')) {
            const colon = decl.indexOf(':');
            if (colon === -1) continue;
            entries.push([decl.slice(0, colon).trim(), decl.slice(colon + 1).trim()]);
        }
    }
    for (const key of Object.keys(patch)) {
        const existing = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
        if (existing) existing[1] = patch[key];
        else entries.push([key, patch[key]]);
    }
    const serialized = entries.map(([k, v]) => `${k}: ${v}`).join('; ') + ';';
    if (styleMatch) {
        return openTag.slice(0, styleMatch.index) + ` style="${serialized}"` + openTag.slice(styleMatch.index + styleMatch[0].length);
    }
    // No style attribute yet: insert one immediately after the tag name.
    const nameEnd = openTag.search(/\s|>/);
    const at = nameEnd === -1 ? openTag.length : nameEnd;
    return openTag.slice(0, at) + ` style="${serialized}"` + openTag.slice(at);
}

/** The workspace the studio indexes at boot: the package directory when a scan of it finds at
 *  least one screen (in the repo the package dir IS the workspace), else the caller's working
 *  directory. An installed CLI's package dir ships no screens, so a bare `vistaro` that indexed
 *  it would find nothing and /api/open would resolve "relative to this workspace" inside the
 *  global package -- the cwd is what that hint promises. Pure: the caller passes both roots.
 *  In-repo runs are unchanged, because the package dir scans to its demos and wins. */
export function pickWorkspaceRoot(packageDir: string, cwd: string): string {
    return scanProjects(packageDir).length > 0 ? packageDir : cwd;
}

export async function studioCommand(dir: string | undefined, options: StudioOptions = {}): Promise<void> {
    const root = pickWorkspaceRoot(path.resolve(__dirname, '../..'), process.cwd());
    // The registry is the sandbox: requests name projects by id, ids exist only for scanned (or
    // explicitly opened) dirs+configs, and no path from a request ever reaches the filesystem
    // (the one exception, POST /api/open, only ever REGISTERS a validated directory).
    type Registered = ScannedProject & { dirAbs: string };
    const registry = new Map<string, Registered>();
    // Trees beyond the workspace root: the boot directory when `studio /outside/path` opened
    // one, plus everything POST /api/open adds. Scanned per request and merged by id.
    const outsideRoots = new Set<string>();
    const register = (dirAbs: string, configFile: string): Registered => {
        const raw = (() => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; } })();
        const meta = (raw && typeof raw === 'object' && raw.meta && typeof raw.meta === 'object') ? raw.meta : {};
        // Outside the workspace the relative dir is a "../../.."-style string; report the
        // absolute path there, the same dir the /api/projects merge stamps for outside roots.
        const rel = path.relative(root, dirAbs);
        const entry: Registered = {
            id: crypto.createHash('sha256').update(path.resolve(configFile)).digest('hex').slice(0, 10),
            dir: rel.startsWith('..') ? dirAbs : rel,
            dirAbs,
            configFile,
            configName: path.basename(configFile),
            title: String(meta.title ?? path.basename(dirAbs)),
            kind: meta.kind === 'reel' ? 'reel' : 'guide',
            tour: false,
            locales: [],
            devices: [],
            steps: Array.isArray(raw?.steps) ? raw.steps.length : 0,
            lastTouched: null,
        };
        registry.set(entry.id, entry);
        return entry;
    };
    for (const scanned of scanProjects(root)) {
        registry.set(scanned.id, { ...scanned, dirAbs: path.resolve(root, scanned.dir) });
    }

    let defaultProjectId: string | null = null;
    if (dir !== undefined) {
        const absDir = path.resolve(dir);
        if (!fs.existsSync(absDir)) throw new Error(`directory not found: ${displayPath(absDir)}`);
        const indexHtmlPath = path.join(absDir, 'index.html');
        if (!fs.existsSync(indexHtmlPath)) {
            throw new Error(`no index.html in ${displayPath(absDir)}: the studio edits a screen + its timeline, so the mockup comes first`);
        }
        // A --config value is cwd-relative like every other CLI path option. A MISSING default
        // config is not an error: the editor opens into the concept picker and scaffolds one
        // (the blank-demo flow); only an explicitly named --config that does not exist refuses.
        const configFile = options.config ? path.resolve(options.config) : resolveConfigPath(absDir);
        if (options.config && !fs.existsSync(configFile)) throw new Error(`timeline not found: ${displayPath(configFile)}`);
        defaultProjectId = register(absDir, configFile).id;
        if (path.relative(root, absDir).startsWith('..')) outsideRoots.add(absDir);
    }
    const previewWidth = Math.max(320, Math.min(3840, Math.round(Number(options.width ?? 1280)) || 1280));
    const previewHeight = Math.max(240, Math.min(2160, Math.round(Number(options.height ?? 720)) || 720));
    const runner = new OneAtATime();

    const server = http.createServer((req, res) => {
        route(req, res).catch((e) => {
            if (e instanceof HttpError) json(res, e.status, { error: e.message });
            else json(res, 500, { error: e?.message ?? String(e) });
        });
    });

    /** "Open a local web editor" now means it: when stdout is a terminal (a person typed
     *  `vistaro`), open the browser at the front door. Under pipes -- the test suite, build-all
     *  style wrappers -- the printed URLs above are the interface, and no window pops. */
    function openBrowser(url: string): void {
        if (!process.stdout.isTTY) return;
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        try {
            const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
            child.on('error', () => undefined); // the URL is printed above either way
            child.unref();
        } catch { /* same: the printed URL is the fallback */ }
    }

    /** {device, locale} off a JSON body, validated to the shapes the CLI accepts. */
    function variantOf(body: any): { device?: 'desktop' | 'mobile'; locale?: string } {
        const device = body?.device === 'mobile' ? 'mobile' : body?.device === 'desktop' ? 'desktop' : undefined;
        const locale = typeof body?.locale === 'string' && /^[\w-]{2,16}$/.test(body.locale) ? body.locale : undefined;
        return { ...(device ? { device } : {}), ...(locale ? { locale } : {}) };
    }

    async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // The server binds 127.0.0.1, but that alone does not stop a drive-by website (a
        // CORS-simple text/plain POST needs no preflight) or DNS rebinding (any Host header).
        // Both gates are cheap and local-only by design: the studio is a single-user tool.
        const host = String(req.headers.host ?? '');
        const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
        if (!hostOk) { json(res, 403, { error: 'the studio only accepts requests addressed to 127.0.0.1 or localhost' }); return; }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const segments = url.pathname.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
        const mutating = (req.method === 'PUT' || req.method === 'POST');
        if (segments[0] === 'api' && mutating && !String(req.headers['content-type'] ?? '').includes('application/json')) {
            json(res, 415, { error: 'API bodies must be application/json' });
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD' && segments[0] !== 'api') {
            json(res, 405, { error: 'method not allowed' });
            return;
        }

        // --- pages and assets (fixed names, no user input reaches the filesystem) ---
        if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) {
            // The front door: without ?project= this is the picker; with one, the editor.
            serveAppFile(res, url.searchParams.get('project') ? 'index.html' : 'picker.html');
            return;
        }
        if (segments.length === 1 && segments[0] === 'hub') {
            // The landing page a bare `vistaro` opens: the ask for the user's agent, the doors
            // into the picker and the editor. Same server, one more fixed-name page.
            serveAppFile(res, 'hub.html');
            return;
        }
        if (segments.length === 1 && ['studio.css', 'studio.js', 'presets.json', 'picker.css', 'picker.js', 'browse.js', 'hub.css', 'hub.js'].includes(segments[0])) {
            serveAppFile(res, segments[0]);
            return;
        }
        if (segments.length === 1 && segments[0] === 'agents.md') {
            // The manual, served where an agent (or a human) can fetch it: the page links it,
            // and a browser-only agent reads the workflow from the tool itself. The route is
            // the package-root AGENTS.md verbatim -- the same file the repo ships, so the copy
            // a friend's agent reads cannot drift from the CLI beside it.
            const file = path.resolve(__dirname, '../../AGENTS.md');
            try {
                const data = fs.readFileSync(file);
                res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
                res.end(data);
            } catch {
                json(res, 404, { error: 'manual not found (AGENTS.md missing beside the package)' });
            }
            return;
        }

        if (segments[0] === 'api' && segments[1] === 'projects' && segments.length === 2 && req.method === 'GET') {
            // Always a fresh scan (the picker tells the truth about new scenario files). Outside
            // trees (the boot directory, anything /api/open added) are scanned too and merged by
            // id, so an opened project and its sibling stories are pickable. Everything listed
            // must also be REGISTERED, or the picker offers cards whose routes 404 (a scenario
            // created after boot; a sibling of an opened outside dir). Registering from the
            // server's own scans widens nothing: the set stays "scanned or explicitly opened".
            // The registry keeps each story's own absolute config path: a basename re-join
            // pointed a nested scenario (demo/scenarios/x.json) at <root>/x.json, and opening
            // it fell through to the blank-concept flow instead of the story.
            const merged = new Map<string, ScannedProject>();
            for (const pr of scanProjects(root)) {
                merged.set(pr.id, pr);
                if (!registry.has(pr.id)) registry.set(pr.id, { ...pr, dirAbs: path.resolve(root, pr.dir) });
            }
            for (const outside of outsideRoots) {
                for (const pr of scanProjects(outside)) {
                    // dirAbs resolves the scan-relative dir against THIS root -- a scenario story's
                    // configFile sits under <screen>/scenarios/, and a dirname join there pointed
                    // every route at a dir with no index.html (500 on /preview). dir carries the
                    // same absolute path: an outside project has no repo-relative home to display,
                    // and the scenario switcher groups projects by dir equality, so screens under
                    // one root must stay distinct from each other and from other roots.
                    const dirAbs = path.resolve(outside, pr.dir);
                    merged.set(pr.id, { ...pr, dir: dirAbs });
                    if (!registry.has(pr.id)) registry.set(pr.id, { ...pr, dir: dirAbs, dirAbs });
                }
            }
            const currentId = url.searchParams.get('project') ?? defaultProjectId;
            json(res, 200, { projects: [...merged.values()].map(pr => { const { configFile, ...safe } = pr; void configFile; return { ...safe, current: pr.id === currentId }; }), defaultId: defaultProjectId });
            return;
        }

        if (segments[0] === 'api' && segments[1] === 'open' && segments.length === 2 && req.method === 'POST') {
            // The CLI's directory argument over HTTP -- the picker's "open a folder". It is the
            // one route where a request-borne path reaches the filesystem, and it only ever
            // REGISTERS a validated directory (the same checks `studio <dir>` runs); every
            // read and write below still goes through registry ids alone.
            const body = await readJsonBody(req);
            const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
            if (!rawPath) { json(res, 400, { error: 'path is required (absolute, or relative to the workspace)' }); return; }
            const abs = path.resolve(root, rawPath);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
                json(res, 404, { error: `directory not found: ${displayPath(abs)}` });
                return;
            }
            if (!fs.existsSync(path.join(abs, 'index.html'))) {
                json(res, 400, { error: `no index.html in ${displayPath(abs)}: the studio edits a screen + its timeline, so the mockup comes first` });
                return;
            }
            const entry = register(abs, resolveConfigPath(abs));
            if (path.relative(root, abs).startsWith('..')) outsideRoots.add(abs);
            json(res, 200, { id: entry.id, dir: entry.dir, title: entry.title });
            return;
        }

        // Every stateful route below resolves its project THROUGH THE REGISTRY ONLY: an unknown
        // id is a 404 and, apart from /api/open's registration above, no request-borne path
        // ever reaches the filesystem.
        const projectParam = url.searchParams.get('project');
        const projectEntry = registry.get(projectParam || defaultProjectId || '');
        if (!projectEntry) {
            json(res, 404, { error: 'unknown project (open one from the picker, or pass ?project=<id> from /api/projects)' });
            return;
        }
        const absDir = projectEntry.dirAbs;
        const configFile = projectEntry.configFile;
        const configArg = projectEntry.configName === 'anim.config.json' ? undefined : configFile;
        const indexHtmlPath = path.join(absDir, 'index.html');


        // Export artifacts, by fixed basename pattern only (no traversal surface: the name is
        // matched against /^studio\.[\w.-]+$/ before it ever reaches the filesystem).
        if (segments[0] === 'artifact' && segments.length === 2 && req.method === 'GET') {
            const name = segments[1];
            if (!/^studio\.[\w.-]+$/.test(name) || name.includes('..')) {
                json(res, 404, { error: 'not found' });
                return;
            }
            const file = path.join(absDir, name);
            try {
                const data = fs.readFileSync(file);
                res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
                res.end(data);
            } catch {
                json(res, 404, { error: 'not found' });
            }
            return;
        }

        if (segments[0] === 'preview' && segments.length === 1) {
            const { raw } = readRawTimeline(configFile);
            const device = url.searchParams.get('device') === 'mobile' ? 'mobile' : url.searchParams.get('device') === 'desktop' ? 'desktop' : undefined;
            const rawLocale = url.searchParams.get('locale');
            const locale = rawLocale && /^[\w-]{2,16}$/.test(rawLocale) ? rawLocale : undefined;
            // With device or locale the preview resolves through loadTimeline -- the exact path
            // export takes (strings applied, device overrides merged, other device's steps
            // dropped). With neither, the authored timeline plays (the M1 behaviour).
            // A `localize`-scaffolded locale is a full directory (its index.html carries the
            // translated visible copy); preview THAT screen. Otherwise overlay the strings.
            const localeDirectory = locale ? localeDir(absDir, configFile, locale) : null;
            const timeline = localeDirectory
                ? loadTimeline(localeDirectory, { device, config: configArg ? path.join(localeDirectory, path.basename(configArg)) : undefined })
                : device || locale
                    ? loadTimeline(absDir, { device, locale, config: configArg ?? undefined })
                    : parseTimeline(raw ?? { meta: {}, steps: [] });
            const screenHtml = fs.readFileSync(localeDirectory ? path.join(localeDirectory, 'index.html') : indexHtmlPath, 'utf8');
            const page = buildTourPage(screenHtml, timeline, { cursor: timeline.meta.cursor });
            const bridge = fs.readFileSync(path.join(APP_DIR, 'studio-bridge.js'), 'utf8');
            // Anchor on the tour block's END marker, never on "</body>": the runtime's own header
            // comment contains that literal text, and a first-match splice lands the bridge in the
            // middle of the runtime source, terminating its <script> early (found the hard way).
            const ANCHOR = '<!-- anim-cli-runtime:end -->';
            const withBridge = page.includes(ANCHOR)
                ? page.replace(ANCHOR, `${ANCHOR}\n<script data-anim-rerun="false">\n${bridge}\n</script>`)
                : page + `\n<script data-anim-rerun="false">\n${bridge}\n</script>\n`;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(withBridge);
            return;
        }

        if (segments[0] !== 'api' || segments.length !== 2) {
            json(res, 404, { error: 'not found' });
            return;
        }

        // --- timeline API ---
        if (segments[1] === 'timeline' && req.method === 'GET') {
            const { exists, raw, rawText, mtimeMs } = readRawTimeline(configFile);
            json(res, 200, {
                dir: displayPath(absDir),
                configPath: displayPath(configFile),
                exists,
                raw,
                ...(rawText !== undefined ? { rawText } : {}),
                ...(mtimeMs !== undefined ? { mtimeMs } : {}),
                mockupMtimeMs: fs.existsSync(indexHtmlPath) ? fs.statSync(indexHtmlPath).mtimeMs : undefined,
                preview: { width: previewWidth, height: previewHeight },
                viewports: {
                    desktop: { width: previewWidth, height: previewHeight },
                    mobile: options.width && options.height ? { width: previewWidth, height: previewHeight } : { width: 390, height: 844 },
                },
                baseLocale: String((raw as any)?.meta?.locale ?? 'en'),
                locales: availableLocales(absDir, configFile),
                initialDevice: options.device === 'mobile' ? 'mobile' : 'desktop',
                devices: deviceMap(raw),
                computed: computedFor(raw),
                issues: exists ? staticIssues(raw!).map(formatIssue) : [],
            });
            return;
        }
        if (segments[1] === 'timeline' && req.method === 'PUT') {
            const body = await readJsonBody(req);
            const raw = body?.raw;
            if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
                json(res, 400, { error: 'body.raw must be a timeline object { meta, steps }' });
                return;
            }
            // Last-save-wins is silent data loss when two studios (or a studio and an editor) share
            // a directory: refuse if the file changed on disk since this editor loaded it.
            if (typeof body?.mtime === 'number' && fs.existsSync(configFile)) {
                const onDisk = fs.statSync(configFile).mtimeMs;
                if (onDisk !== body.mtime) {
                    json(res, 409, { error: 'the file changed on disk since this editor loaded it (another studio window, or an editor); reload to see the newer version before saving over it' });
                    return;
                }
            }
            const issues = staticIssues(raw as Record<string, unknown>);
            const errors = issues.filter((i) => i.level === 'error');
            if (errors.length) {
                json(res, 422, { ok: false, issues: issues.map(formatIssue) });
                return;
            }
            delete (raw as any).__parseError;
            fs.mkdirSync(path.dirname(configFile), { recursive: true });
            fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n');
            const renames = Array.isArray(body?.renames)
                ? body.renames.filter((r: any) => r && typeof r.from === 'string' && typeof r.to === 'string')
                : [];
            const touched = applyRenames(absDir, configFile, renames);
            const orphans = orphanKeys(absDir, configFile, raw as Record<string, unknown>);
            json(res, 200, { ok: true, path: displayPath(configFile), mtimeMs: fs.statSync(configFile).mtimeMs, stringsFilesTouched: touched, orphanKeys: orphans });
            return;
        }
        if (segments[1] === 'scaffolds' && req.method === 'GET') {
            json(res, 200, { guide: CONFIG_SCAFFOLD, reel: REEL_SCAFFOLD });
            return;
        }
        if (segments[1] === 'mockup' && req.method === 'PUT') {
            const body = await readJsonBody(req);
            const patches: MockupPatch[] = Array.isArray(body?.patches)
                ? body.patches.filter((p: any) => p && typeof p.tag === 'string' && typeof p.index === 'number'
                    && p.patch && typeof p.patch === 'object' && typeof p.domCount === 'number')
                : [];
            if (!patches.length) {
                json(res, 400, { error: 'body.patches must be a non-empty array of {tag, index, domCount, patch}' });
                return;
            }
            if (typeof body?.mtime === 'number' && fs.existsSync(indexHtmlPath)) {
                const onDisk = fs.statSync(indexHtmlPath).mtimeMs;
                if (onDisk !== body.mtime) {
                    json(res, 409, { error: 'index.html changed on disk since this editor loaded it; reload before patching the screen' });
                    return;
                }
            }
            const html = fs.readFileSync(indexHtmlPath, 'utf8');
            const result = patchMockup(html, patches);
            if (result.refused) {
                json(res, 422, { ok: false, error: result.refused });
                return;
            }
            fs.writeFileSync(indexHtmlPath, result.html);
            json(res, 200, { ok: true, applied: result.applied, mtimeMs: fs.statSync(indexHtmlPath).mtimeMs });
            return;
        }

        // --- in-process CLI jobs (serial, behind the mutex) ---
        if (segments[1] === 'check' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const variant = variantOf(body);
            // The same convention split the preview honours: a localize directory IS the locale
            // (translated screen and all); checking the base dir against --locale would validate
            // the untranslated screen while the user believes otherwise.
            const checkDir = variant.locale ? (localeDir(absDir, configFile, variant.locale) ?? absDir) : absDir;
            const checkConfig = variant.locale && checkDir !== absDir
                ? (configArg ? path.join(checkDir, path.basename(configArg)) : undefined)
                : configArg ?? undefined;
            const issues = await runner.run(async (): Promise<Issue[]> => {
                let timeline: Timeline | undefined;
                const collected: Issue[] = [];
                try {
                    timeline = loadTimeline(checkDir, {
                        config: checkConfig,
                        ...(checkDir !== absDir ? {} : variant),
                        ...(checkDir !== absDir && variant.device ? { device: variant.device } : {}),
                    });
                } catch (e: any) {
                    return [{ level: 'error', message: e?.message ?? String(e) }];
                }
                collected.push(...validateTimeline(timeline, {}));
                if (!hasErrors(collected)) {
                    try {
                        collected.push(...await browserCheck(checkDir, timeline, variant.device ? { device: variant.device } : {}, collected));
                    } catch (e: any) {
                        collected.push({ level: 'error', message: e?.message ?? String(e) });
                    }
                }
                const rank: Record<string, number> = { error: 0, warning: 1, info: 2 };
                collected.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || (rank[a.level] ?? 3) - (rank[b.level] ?? 3));
                return collected;
            });
            json(res, 200, { exitCode: issues.some(i => i.level === 'error') ? 1 : 0, issues });
            return;
        }
        if (segments[1] === 'export' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const variant = variantOf(body);
            const exportDir = variant.locale ? (localeDir(absDir, configFile, variant.locale) ?? absDir) : absDir;
            const { raw } = readRawTimeline(configFile);
            const kind = (raw as any)?.meta?.kind;
            const base = path.join(absDir, 'studio.mp4');
            const tempVideoDir = path.join(absDir, '.temp-video');
            const outcome = await runner.run(async (): Promise<{ ok: boolean; error?: string }> => {
                try {
                    // Step failures do not throw (the recording completes and records them, the way
                    // `verify` reads them back); the honest exit code reads the results.
                    const summary = await runExport(exportDir, {
                        output: base,
                        ...(kind !== 'reel' ? { guide: true } : {}),
                        ...(exportDir !== absDir
                            ? (configArg ? { config: path.join(exportDir, path.basename(configArg)) } : {})
                            : (configArg ? { config: configArg } : {})),
                        ...(exportDir !== absDir ? (variant.device ? { device: variant.device } : {}) : variant),
                    }, tempVideoDir);
                    const failed = summary.results.filter(r => r.error);
                    return failed.length
                        ? { ok: false, error: `${failed.length} step(s) failed: ${failed.map(r => `#${r.index} (${r.id ?? r.action}) ${r.error}`).join('; ').slice(0, 500)}` }
                        : { ok: true };
                } catch (e: any) {
                    return { ok: false, error: e?.message ?? String(e) };
                } finally {
                    try { fs.rmSync(tempVideoDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
            });
            const artifacts = fs.existsSync(absDir)
                ? fs.readdirSync(absDir).filter((f) => f.startsWith('studio.')).sort()
                : [];
            json(res, 200, { exitCode: outcome.ok ? 0 : 1, artifacts, log: outcome.error ?? '' });
            return;
        }

        // --- strings API (locale editing) ---
        if (segments[1] === 'strings' && req.method === 'GET') {
            const locale = String(url.searchParams.get('locale') ?? '');
            if (!/^[\w-]{2,16}$/.test(locale)) { json(res, 400, { error: 'bad locale' }); return; }
            const file = stringsFileFor(absDir, configFile, locale);
            let map: Record<string, string> = {};
            let mtimeMs: number | undefined;
            if (fs.existsSync(file)) {
                try { map = readStrings(file); } catch (e: any) { json(res, 422, { error: `strings file is not a flat string map: ${e?.message ?? e}` }); return; }
                mtimeMs = fs.statSync(file).mtimeMs;
            }
            json(res, 200, { locale, path: displayPath(file), exists: fs.existsSync(file), map, mtimeMs });
            return;
        }
        if (segments[1] === 'strings' && req.method === 'PUT') {
            const body = await readJsonBody(req);
            const locale = String(body?.locale ?? '');
            if (!/^[\w-]{2,16}$/.test(locale)) { json(res, 400, { error: 'locale must be a code like fr or pt-BR' }); return; }
            if (body?.map === null || typeof body?.map !== 'object' || Array.isArray(body?.map)) {
                json(res, 400, { error: 'body.map must be a flat string map' }); return; }
            // Keys must name something that exists: meta.title or steps.<id>.<field>, with `value`
            // only on translatable steps -- the same grammar extractStrings writes.
            const rawSteps: any[] = (readRawTimeline(configFile).raw as any)?.steps ?? [];
            const byId = new Map<string, any>();
            for (const st of rawSteps) { if (st?.id) byId.set(String(st.id), st); }
            for (const [key, value] of Object.entries(body.map as Record<string, unknown>)) {
                if (typeof value !== 'string') { json(res, 422, { error: `value of "${key}" must be a string` }); return; }
                if (key === 'meta.title') continue;
                const m = /^steps\.([^.]+)\.(title|subtitle|narration|note|value)$/.exec(key);
                if (!m || !byId.has(m[1])) {
                    json(res, 422, { error: `key "${key}" does not match any step (grammar: steps.<id>.<field>, ids: ${[...byId.keys()].join(', ') || 'none'})` });
                    return;
                }
                // `value` is only extractable from translatable steps (extractStrings' rule);
                // a key that breaks it would be silently classified unknown on every load.
                if (m[2] === 'value' && !byId.get(m[1])?.translatable) {
                    json(res, 422, { error: `key "${key}": step "${m[1]}" is not translatable (add "translatable": true to type its value)` });
                    return;
                }
            }
            const file = stringsFileFor(absDir, configFile, locale);
            if (typeof body?.mtime === 'number' && fs.existsSync(file)) {
                if (fs.statSync(file).mtimeMs !== body.mtime) {
                    json(res, 409, { error: `strings.${locale}.json changed on disk since it was loaded; reload it before saving over it` });
                    return;
                }
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            writeStrings(file, body.map as Record<string, string>);
            json(res, 200, { ok: true, path: displayPath(file), mtimeMs: fs.statSync(file).mtimeMs });
            return;
        }

        json(res, 404, { error: 'not found' });
    }

    // A Ctrl-C should close the socket rather than leave the port limping in TIME_WAIT half-open.
    // Registered BEFORE the boot await: that promise resolves only on the error paths, so a
    // handler placed after it never ran on the success path this exists for (Ctrl-C killed by
    // default disposition and server.close never fired).
    process.on('SIGINT', () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    });

    await new Promise<void>((resolve) => {
        server.on('error', (e) => {
            console.error(`Error: could not listen on 127.0.0.1:${options.port ?? 0}: ${e.message}`);
            process.exitCode = 1;
            resolve();
        });
        const portNumber = Number(options.port ?? 0);
        if (!Number.isFinite(portNumber) || portNumber < 0 || portNumber > 65535) {
            console.error(`Error: --port must be a number between 0 and 65535 (got "${options.port}")`);
            process.exitCode = 1;
            resolve();
            return;
        }
        server.listen(portNumber, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : portNumber;
            const opened = defaultProjectId ? registry.get(defaultProjectId) : null;
            console.log(`studio listening on http://127.0.0.1:${port}${opened ? `  (editing ${displayPath(opened.dirAbs)}${opened.configName !== 'anim.config.json' ? `, ${opened.configName}` : ''})` : '  (project picker -- ' + registry.size + ' found)'}`);
            if (options.hub) {
                console.log(`vistaro hub at http://127.0.0.1:${port}/hub  -- the ask for your agent, the manual at /agents.md, the studio`);
            }
            console.log('studio editing the timeline file directly -- save (⌘S) writes it; review in git; Ctrl-C to stop');
            openBrowser(
                options.hub
                    ? `http://127.0.0.1:${port}/hub`
                    : `http://127.0.0.1:${port}${defaultProjectId ? `/?project=${defaultProjectId}` : '/'}`
            );
        });
    });

    // Never resolve: the listening server holds the process open, and cli.ts's drain watchdog
    // only arms once this command settles (it must not, or a 5 s timer would kill the editor).
    await new Promise<void>(() => undefined);
}
