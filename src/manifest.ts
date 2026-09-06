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

export function readManifest(outputDir: string): Manifest {
    const p = manifestPath(outputDir);
    if (fs.existsSync(p)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
            if (!Array.isArray(parsed.history)) parsed.history = [];
            return parsed;
        } catch {
            // Fall through to a fresh manifest if the existing file is corrupt.
        }
    }
    return { history: [] };
}

function writeManifest(outputDir: string, manifest: Manifest) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(manifestPath(outputDir), JSON.stringify(manifest, null, 2));
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
