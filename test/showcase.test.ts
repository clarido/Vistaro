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
