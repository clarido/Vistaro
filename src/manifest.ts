import * as fs from 'fs';
import * as path from 'path';

interface ManifestEvent {
    command: string;
    timestamp: string;
    [key: string]: any;
}

interface Manifest {
    locale?: string;
    baseLocale?: string;
    history: ManifestEvent[];
    [key: string]: any;
}

function manifestPath(outputDir: string): string {
    return path.join(outputDir, 'anim.manifest.json');
}

/** Bumped per in-flight temp file so a crash between two writes cannot collide with the next one. */
let manifestTmpSeq = 0;

function writeManifest(outputDir: string, manifest: Manifest) {
    fs.mkdirSync(outputDir, { recursive: true });
    const p = manifestPath(outputDir);
    // Temp + rename: a write interrupted mid-file (kill, full disk) must not leave a truncated
    // manifest that the next read treats as corrupt and overwrites, taking the history with it.
    const tmp = `${p}.tmp-${process.pid}-${++manifestTmpSeq}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    try {
        fs.renameSync(tmp, p);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
        throw e;
    }
}

/** Bumped per quarantine so two corruptions in the same millisecond never share an aside name. */
let quarantineSeq = 0;

/** Set aside an existing manifest that cannot be parsed, so its contents stay recoverable. */
function quarantineManifest(p: string, why: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${p}.corrupt-${stamp}-${++quarantineSeq}`;
    try {
        fs.renameSync(p, aside);
        console.error(`warning  ${p} is not valid JSON (${why}); moved aside to ${aside} and starting a fresh manifest`);
    } catch {
        // Could not move it (read-only?): say so and carry on with a fresh manifest rather than die.
        console.error(`warning  ${p} is not valid JSON (${why}) and could not be moved aside; starting a fresh manifest`);
    }
}

export function readManifest(outputDir: string): Manifest {
    const p = manifestPath(outputDir);
    if (fs.existsSync(p)) {
        let parsed: any;
        try {
            parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch (e: any) {
            quarantineManifest(p, e.message);
            return { history: [] };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            quarantineManifest(p, `parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
            return { history: [] };
        }
        if (!Array.isArray(parsed.history)) parsed.history = [];
        return parsed;
    }
    return { history: [] };
}

/** Append a timestamped record of a CLI command run against this output directory. */
export function recordEvent(outputDir: string, event: Record<string, any>) {
    const manifest = readManifest(outputDir);
    const record: ManifestEvent = { ...event, command: event.command, timestamp: new Date().toISOString() };
    manifest.history.push(record);
    writeManifest(outputDir, manifest);
}

/** Merge top-level metadata fields (e.g. locale, baseLocale) into this output directory's manifest. */
export function setManifestFields(outputDir: string, fields: Record<string, any>) {
    const manifest = readManifest(outputDir);
    Object.assign(manifest, fields);
    writeManifest(outputDir, manifest);
}
