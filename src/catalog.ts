import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

/** Files that define a guide's content: index.html, anim.config.json, strings.*.json and top-level media. */
export function guideSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (!fs.statSync(full).isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        if (name === 'index.html' || name === 'anim.config.json' || /^strings\.[a-z0-9-]+\.json$/i.test(name) || MEDIA_EXTENSIONS.has(ext)) {
            out.push(full);
        }
    }
    return out;
}

/** `sha256:<hex>` over the guide's source files (names + bytes), for staleness checks. */
export function hashGuideDir(dir: string): string {
    const h = createHash('sha256');
    for (const file of guideSourceFiles(dir)) {
        h.update(path.basename(file));
        h.update('\0');
        h.update(fs.readFileSync(file));
        h.update('\0');
    }
    return 'sha256:' + h.digest('hex');
}

export function toolVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        return `${pkg.name}@${pkg.version}`;
    } catch {
        return 'screenshot-animator';
    }
}
