import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { readCatalog, effectiveSettings } from '../src/catalog';
import { loadTimeline, isReel, audioOf, brandOf } from '../src/engine/schema';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';
import { countOrphans, assertNoNewOrphans } from './orphans';

/**
 * Lot 6 of docs/next-level-plan.md: showcase.catalog.json holds one short clip per new capability,
 * built by `build-all showcase.catalog.json` so the clips the website shows are regenerated when
 * the engine changes. The standard the plan sets: every showcase timeline passes `check` with no
 * warnings, at the render settings the catalog gives it.
 */

const root = path.resolve(__dirname, '..');
const skip = process.env.SKIP_BROWSER === '1';
const catalogFile = path.join(root, 'showcase.catalog.json');
const cli = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};

let orphanBaseline = -1;
before(() => { orphanBaseline = countOrphans(); });
after(() => { if (!skip) assertNoNewOrphans(orphanBaseline, 'showcase.test.ts'); });

test('the showcase catalog covers each capability the plan names, with one clip each', () => {
    const catalog = readCatalog(catalogFile);
    const slugs = catalog.guides.map(g => g.slug);
    assert.deepEqual(slugs, ['transitions', 'brand-kit', 'auto-zoom', 'vertical', 'audio']);
    const by = (slug: string) => loadTimeline(catalog.guides.find(g => g.slug === slug)!.dir);
    for (const slug of slugs) assert.ok(isReel(by(slug)), `${slug} is a reel (no guide chrome, loops on a page)`);
    // Each clip really exercises what it is named for, so the gallery never shows a mislabelled clip.
    assert.ok(by('transitions').steps.some(s => s.transition === 'push') && by('transitions').steps.some(s => s.action === 'overlay'));
    assert.ok(brandOf(by('brand-kit'))?.intro && brandOf(by('brand-kit'))?.outro && brandOf(by('brand-kit'))?.accent);
    assert.ok(by('auto-zoom').steps.some(s => s.action === 'camera' && s.follow === true));
    assert.deepEqual([effectiveSettings(catalog.guides.find(g => g.slug === 'vertical')!, catalog.defaults).width, effectiveSettings(catalog.guides.find(g => g.slug === 'vertical')!, catalog.defaults).height], [1080, 1920]);
    assert.ok(audioOf(by('audio'))?.click);
});

test('every showcase timeline passes check with no warnings at its catalog settings', { skip }, () => {
    const catalog = readCatalog(catalogFile);
    for (const guide of catalog.guides) {
        const s = effectiveSettings(guide, catalog.defaults);
        const args = ['check', guide.dir, '--json', '-w', String(s.width), '-H', String(s.height), ...(s.scale ? ['--scale', String(s.scale)] : [])];
        const r = cli(args);
        assert.equal(r.status, 0, `${guide.slug}: ${r.stderr}`);
        const issues: any[] = JSON.parse(r.stdout).issues ?? JSON.parse(r.stdout);
        assert.deepEqual(issues.filter(i => i.level !== 'info').map(i => `${i.level}: ${i.message}`), [], `${guide.slug} is check-clean`);
    }
});

test('every showcase clip the website references is built by the deploy job, and its poster is committed', () => {
    const fs = require('fs') as typeof import('fs');
    const html = ['formats.html', 'index.html'].map(f => fs.readFileSync(path.join(root, 'website', f), 'utf8')).join('\n');
    const refs = [...new Set([...html.matchAll(/assets\/showcase\/([a-z0-9-]+)\.(mp4|webm|poster\.webp)/g)].map(m => m[0]))];
    // An empty match means the gallery moved or was renamed, not that there is nothing to check.
    assert.ok(refs.length > 0, 'website/formats.html references no assets/showcase/ clip: update this test with the gallery');
    const slugs = readCatalog(catalogFile).guides.map(g => g.slug);
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');
    const loop = workflow.match(/for s in ([a-z0-9 -]+); do\n\s+cp "showcase-out\/\$s\/en\/\$s-en\.mp4"/);
    assert.ok(loop, 'the deploy job no longer copies showcase-out clips into website/assets/showcase/');
    const copied = loop![1].trim().split(/\s+/);
    for (const ref of refs) {
        const [, slug, ext] = ref.match(/assets\/showcase\/([a-z0-9-]+)\.(.+)$/)!;
        assert.ok(slugs.includes(slug), `${ref}: "${slug}" is not a guide in showcase.catalog.json`);
        if (ext === 'poster.webp') assert.ok(fs.existsSync(path.join(root, 'website', ref)), `${ref} is referenced but not committed`);
        else assert.ok(copied.includes(slug), `${ref} is referenced but the deploy job does not copy "${slug}"`);
    }
});

test('every scenario the animations page embeds is in tour.showcase.json', () => {
    const fs = require('fs') as typeof import('fs');
    const html = fs.readFileSync(path.join(root, 'website', 'animations.html'), 'utf8');
    const used = [...html.matchAll(/<vistaro-tour src="src\/showcase-out\/" scenario="([^"]+)"/g)].map(m => m[1]);
    assert.ok(used.length > 0, 'animations.html embeds no showcase scenario: update this test with the page');
    const known = JSON.parse(fs.readFileSync(path.join(root, 'tour.showcase.json'), 'utf8')).scenarios.map((s: { slug: string }) => s.slug);
    assert.deepEqual(used.filter(s => !known.includes(s)), [], 'scenarios embedded but never built');
});
