import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { readCatalog, resolveLocaleDir, writeIndex, IndexJson } from '../src/catalog';
import { diffPng } from '../src/guide/diff';
import { PNG } from 'pngjs';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
// The tsx loader by absolute path: these commands run from the catalog directory, where `tsx` does not resolve.
const cli = (args: string[], cwd = root) => spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(root, 'cli.ts'), ...args], { cwd, encoding: 'utf8' });

let work: string;
before(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-buildall-')); });
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

function png(file: string, w: number, h: number, rgb: [number, number, number]) {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) { p.data[i * 4] = rgb[0]; p.data[i * 4 + 1] = rgb[1]; p.data[i * 4 + 2] = rgb[2]; p.data[i * 4 + 3] = 255; }
    fs.writeFileSync(file, PNG.sync.write(p));
}

test('readCatalog validates shape, dirs, slugs, locales, outputs; warns on unknown keys', () => {
    const d = path.join(work, 'cat'); fs.mkdirSync(d, { recursive: true });
    fs.cpSync(fixture, path.join(d, 'g1'), { recursive: true });
    const warnings: string[] = [];
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({ outputDir: 'out', defaults: { locales: ['en'], outputs: ['video', 'guide'], bogus: 1 }, guides: [{ slug: 'g1', dir: 'g1', extra: true }] }));
    const c = readCatalog(path.join(d, 'help.catalog.json'), m => warnings.push(m));
    assert.equal(c.outputDir, path.join(d, 'out'));
    assert.equal(c.guides[0].dir, path.join(d, 'g1'));
    assert.ok(warnings.some(w => /unknown defaults key "bogus"/.test(w)) && warnings.some(w => /unknown key "extra"/.test(w)));
    fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ outputDir: '', guides: [{ slug: 'Bad Slug', dir: 'missing' }, { slug: 'g1', dir: 'g1', locales: ['nope-dir-name'], outputs: ['pdf'] }, { slug: 'g1', dir: 'g1', record: {} }] }));
    assert.throws(() => readCatalog(path.join(d, 'bad.json')), (e: any) => {
        for (const needle of ['"outputDir" must be', 'lowercase-kebab', 'has no anim.config.json', 'not a locale code', 'unknown output "pdf"', 'duplicate slug "g1"', '"record" needs a "url"']) assert.ok(e.message.includes(needle), `${needle} in: ${e.message}`);
        return true;
    });
    assert.throws(() => readCatalog(path.join(d, 'none.json')), /catalog not found/);
    // locale dir resolution: explicit map > locales/<code> > sibling; base locale = the guide dir
    const g = c.guides[0];
    assert.equal(resolveLocaleDir(g, 'en', 'en'), g.dir);
    assert.equal(resolveLocaleDir(g, 'fr', 'en'), undefined);
    assert.equal(cli(['localize', g.dir, 'fr']).status, 0);
    assert.equal(resolveLocaleDir(g, 'fr', 'en'), path.join(g.dir, 'locales', 'fr'));
    assert.equal(cli(['localize', g.dir, 'es', '--sibling']).status, 0);
    assert.equal(resolveLocaleDir(g, 'es', 'en'), path.join(d, 'es'));
    fs.mkdirSync(path.join(d, 'custom-de'), { recursive: true });
    fs.copyFileSync(path.join(g.dir, 'anim.config.json'), path.join(d, 'custom-de', 'anim.config.json'));
    assert.equal(resolveLocaleDir({ ...g, locales: { de: 'custom-de' } }, 'de', 'en'), path.join(d, 'custom-de'));
});

test('writeIndex writes the contract and a markdown table; diffPng measures changed pixels', () => {
    const out = path.join(work, 'idx');
    const index: IndexJson = { version: 1, generatedAt: 'now', tool: 't', catalog: '../help.catalog.json', guides: [
        { slug: 'a', locale: 'en', dir: 'a', output: 'a/en', status: 'ok', guide: 'a/en/guide/guide.json', video: 'a/en/a-en.mp4', durationMs: 5000 },
        { slug: 'a', locale: 'fr', dir: 'a', output: 'a/fr', status: 'failed', error: 'check exited 1: x | y' },
    ] };
    const w = writeIndex(out, index);
    assert.deepEqual(JSON.parse(fs.readFileSync(w.json, 'utf8')).guides.map((g: any) => g.status), ['ok', 'failed']);
    const md = fs.readFileSync(w.md, 'utf8');
    assert.match(md, /\| a \| en \| ok \| \[guide\]\(a\/en\/guide\/guide\.json\) \| \[video\]\(a\/en\/a-en\.mp4\) \| 5\.0s \|  \|/);
    assert.match(md, /\| a \| fr \| failed \|  \|  \|  \| check exited 1: x \\\| y \|/);
    png(path.join(work, 'w1.png'), 20, 10, [255, 255, 255]);
    png(path.join(work, 'w2.png'), 20, 10, [255, 255, 255]);
    png(path.join(work, 'r.png'), 20, 10, [255, 0, 0]);
    png(path.join(work, 'small.png'), 5, 5, [255, 255, 255]);
    assert.equal(diffPng(path.join(work, 'w1.png'), path.join(work, 'w2.png')), 0);
    assert.equal(diffPng(path.join(work, 'w1.png'), path.join(work, 'r.png'), path.join(work, 'd.png')), 1);
    assert.ok(fs.existsSync(path.join(work, 'd.png')));
    assert.equal(diffPng(path.join(work, 'w1.png'), path.join(work, 'small.png')), 1, 'different sizes count as fully changed');
});

test('build-all: guide x locale outputs, index, --changed-only skips, --diff marks stale, failures exit 1, --continue-on-error, --only', { skip }, () => {
    const d = path.join(work, 'site'); fs.mkdirSync(d, { recursive: true });
    fs.cpSync(fixture, path.join(d, 'basic'), { recursive: true });
    assert.equal(cli(['localize', path.join(d, 'basic'), 'fr']).status, 0);
    const frStrings = path.join(d, 'basic', 'locales', 'fr', 'strings.fr.json');
    fs.writeFileSync(frStrings, JSON.stringify({ ...JSON.parse(fs.readFileSync(frStrings, 'utf8')), 'steps.open.title': 'Ouvrir le panneau' }));
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({
        outputDir: 'help-out',
        defaults: { locales: ['en', 'fr'], outputs: ['video', 'guide'], width: 640, height: 400, crop: 60 },
        guides: [{ slug: 'basic', dir: 'basic' }],
    }, null, 2));

    // dry run lists the plan without running anything
    const dry = cli(['build-all', 'help.catalog.json', '--dry-run'], d);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /basic\/fr:[\s\S]*anim-cli check .*--locale fr[\s\S]*anim-cli build[\s\S]*anim-cli export .*--guide/);
    assert.ok(!fs.existsSync(path.join(d, 'help-out', 'basic', 'en', 'basic-en.mp4')));

    const r = cli(['build-all', 'help.catalog.json'], d);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const index: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(index.guides.map(g => [g.locale, g.status]), [['en', 'ok'], ['fr', 'ok']]);
    for (const loc of ['en', 'fr']) {
        assert.ok(fs.existsSync(path.join(d, 'help-out', 'basic', loc, `basic-${loc}.mp4`)), `${loc} video`);
        assert.ok(fs.existsSync(path.join(d, 'help-out', 'basic', loc, `basic-${loc}.vtt`)), `${loc} vtt`);
        const g = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'basic', loc, 'guide', 'guide.json'), 'utf8'));
        assert.equal(g.locale, loc);
        assert.equal(g.video.file, `../basic-${loc}.mp4`);
    }
    const gfr = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'basic', 'fr', 'guide', 'guide.json'), 'utf8'));
    assert.equal(gfr.steps.find((s: any) => s.id === 'open').title, 'Ouvrir le panneau', 'French strings applied in the fr guide');
    assert.ok(fs.existsSync(path.join(d, 'help-out', 'index.md')));
    assert.match(r.stdout, /2 built, 0 skipped, 0 failed/);
    const manifestEn = JSON.parse(fs.readFileSync(path.join(d, 'basic', 'anim.manifest.json'), 'utf8'));
    assert.match(manifestEn.contentHash.en, /^sha256:/);
    assert.equal(manifestEn.history.at(-1).command, 'build-all');

    // --changed-only: nothing changed -> both skipped, quickly
    const started = Date.now();
    const c1 = cli(['build-all', 'help.catalog.json', '--changed-only'], d);
    assert.equal(c1.status, 0, c1.stderr + c1.stdout);
    assert.match(c1.stdout, /0 built, 2 skipped/);
    assert.ok(Date.now() - started < 15000, 'skipping does not launch browsers');
    const idx1: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(idx1.guides.map(g => g.status), ['skipped', 'skipped']);
    assert.equal(idx1.guides[0].guide, 'basic/en/guide/guide.json', 'skipped entries keep their links');

    // edit the fr page -> only fr rebuilt; --diff keeps previous frames; a visible change marks it stale
    const frIndex = path.join(d, 'basic', 'locales', 'fr', 'index.html');
    fs.writeFileSync(frIndex, fs.readFileSync(frIndex, 'utf8').replace('background: #f8fafc;', 'background: #111827;'));
    const c2 = cli(['build-all', 'help.catalog.json', '--changed-only', '--diff'], d);
    assert.equal(c2.status, 0, c2.stderr + c2.stdout);
    assert.match(c2.stdout, /1 built, 1 skipped/);
    const idx2: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    const fr = idx2.guides.find(g => g.locale === 'fr')!;
    assert.equal(fr.status, 'ok');
    assert.equal(fr.stale, true, JSON.stringify(fr.diff));
    assert.ok(fr.diff!.maxFraction > 0.02);
    assert.ok(fs.existsSync(path.join(d, 'help-out', 'basic', 'fr', 'guide', '.previous', 'step-02.png')));
    assert.ok(fs.existsSync(path.join(d, 'help-out', 'basic', 'fr', 'guide', '.previous', 'step-02.diff.png')));
    assert.match(c2.stderr, /basic\/fr: frames changed/);
    // unchanged frames are not stale on the next diff run
    const c3 = cli(['build-all', 'help.catalog.json', '--diff', '--only', 'basic', '--locale', 'fr'], d);
    assert.equal(c3.status, 0, c3.stderr + c3.stdout);
    const idx3: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(idx3.guides.map(g => [g.locale, g.status, !!g.stale]), [['fr', 'ok', false]]);

    // a failing guide: exit 1, index says failed; default stops at the first failure, --continue-on-error runs the rest
    fs.cpSync(fixture, path.join(d, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(d, 'broken', 'anim.config.json'), JSON.stringify([{ time: 0.5, action: 'click', target: '#missing', title: 'x' }]));
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({
        outputDir: 'help-out', defaults: { locales: ['en'], width: 640, height: 400 },
        guides: [{ slug: 'broken', dir: 'broken' }, { slug: 'basic', dir: 'basic' }],
    }));
    const f1 = cli(['build-all', 'help.catalog.json'], d);
    assert.equal(f1.status, 1);
    const fi1: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(fi1.guides.map(g => [g.slug, g.status]), [['broken', 'failed']]);
    assert.match(fi1.guides[0].error!, /check exited 1/);
    const f2 = cli(['build-all', 'help.catalog.json', '--continue-on-error', '--changed-only'], d);
    assert.equal(f2.status, 1);
    const fi2: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(fi2.guides.map(g => [g.slug, g.status]), [['broken', 'failed'], ['basic', 'skipped']]);
    assert.match(f2.stdout, /0 built, 1 skipped, 1 failed/);
    // a missing locale dir is a failure with a hint
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({ outputDir: 'help-out', guides: [{ slug: 'basic', dir: 'basic', locales: ['de'] }] }));
    const f3 = cli(['build-all', 'help.catalog.json'], d);
    assert.equal(f3.status, 1);
    assert.match(f3.stderr, /no directory for locale "de" \(run `localize basic de`\)/);
});
