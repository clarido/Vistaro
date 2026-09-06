import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

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

export function toolVersion(): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        return `${pkg.name}@${pkg.version}`;
    } catch {
        return 'screenshot-animator';
    }
}
