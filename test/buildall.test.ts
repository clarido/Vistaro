import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { readCatalog, resolveLocaleDir, locateLocaleDir, writeIndex, mergeIndexEntries, outputDirProblem, effectiveSettings, IndexJson, IndexEntry } from '../src/catalog';
import { buildKeyFor } from '../src/commands/build-all';
import { diffPng } from '../src/guide/diff';
import { PNG } from 'pngjs';
import { startLiveApp } from './fixtures/live-app/server';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
// The tsx loader by absolute path: these commands run from the catalog directory, where `tsx` does not resolve.
const cli = (args: string[], cwd = root) => spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(root, 'cli.ts'), ...args], { cwd, encoding: 'utf8' });
/** Async variant for tests that serve a fixture app from this process (spawnSync would deadlock it). */
const cliAsync = (args: string[], cwd = root) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, path.join(root, 'cli.ts'), ...args], { cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
});

let work: string;
before(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-buildall-')); });
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

function png(file: string, w: number, h: number, rgb: [number, number, number]) {
    const p = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) { p.data[i * 4] = rgb[0]; p.data[i * 4 + 1] = rgb[1]; p.data[i * 4 + 2] = rgb[2]; p.data[i * 4 + 3] = 255; }
    fs.writeFileSync(file, PNG.sync.write(p));
}

test('readCatalog validates shape, dirs, slugs, locales, outputs, settings types, outputDir; warns on unknown keys', () => {
    const d = path.join(work, 'cat'); fs.mkdirSync(d, { recursive: true });
    fs.cpSync(fixture, path.join(d, 'g1'), { recursive: true });
    const warnings: string[] = [];
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({ outputDir: 'out', version: 1, defaults: { locales: ['en'], outputs: ['video', 'guide'], bogus: 1 }, guides: [{ slug: 'g1', dir: 'g1', title: 'One', extra: true }] }));
    const c = readCatalog(path.join(d, 'help.catalog.json'), m => warnings.push(m));
    assert.equal(c.outputDir, path.join(d, 'out'));
    assert.equal(c.guides[0].dir, path.join(d, 'g1'));
    assert.equal(c.guides[0].title, 'One');
    assert.ok(warnings.some(w => /unknown defaults key "bogus"/.test(w)) && warnings.some(w => /unknown key "extra"/.test(w)));
    assert.ok(warnings.some(w => /output "video" is implied/.test(w)), 'legacy "video" output warns');
    assert.ok(!warnings.some(w => /unknown key "version"/.test(w)), 'version is a known catalog key');
    assert.deepEqual(effectiveSettings(c.guides[0], c.defaults).outputs, ['guide'], 'video is not an extra');
    assert.deepEqual(effectiveSettings({ slug: 'x', dir: 'x' }, {}).outputs, ['guide'], 'guide is the default extra');
    assert.deepEqual(effectiveSettings({ slug: 'x', dir: 'x', crop: false, width: 800 }, { crop: 60, width: 640, height: 400 }), { width: 800, height: 400, theme: undefined, crop: false, narration: false, hideCursor: false, outputs: ['guide'] }, 'guide values win over defaults, crop/hideCursor per guide');
    fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify({ outputDir: '', defaults: { width: '1280', theme: 'sepia', outputs: 'guide', crop: -1 }, guides: [{ slug: 'Bad Slug', dir: 'missing' }, { slug: 'g1', dir: 'g1', locales: ['nope-dir-name'], outputs: ['pdf'], narration: 'yes', hideCursor: 1, height: 0 }, { slug: 'g1', dir: 'g1', record: {} }, { slug: 'g2', dir: 'g1', record: { url: 'http://x', storageState: 'nope.json' } }] }));
    assert.throws(() => readCatalog(path.join(d, 'bad.json')), (e: any) => {
        for (const needle of ['"outputDir" must be', 'lowercase-kebab', 'has no anim.config.json', 'not a locale code', 'unknown output "pdf"', 'duplicate slug "g1"', '"record" needs a "url"',
            'defaults: "width" must be a positive integer', 'defaults: "theme" must be "light" or "dark"', 'defaults: "outputs" must be an array', 'defaults: "crop" must be a padding', 'guides[1]: "narration" must be true or false', 'guides[1]: "hideCursor" must be true or false', 'guides[1]: "height" must be a positive integer', 'record.storageState', 'does not exist']) assert.ok(e.message.includes(needle), `${needle} in: ${e.message}`);
        return true;
    });
    assert.throws(() => readCatalog(path.join(d, 'none.json')), /catalog not found/);
    // outputDir guards: root, home, the catalog dir, overlapping a guide dir
    assert.match(outputDirProblem('/', d, []) || '', /filesystem root/);
    assert.match(outputDirProblem(os.homedir(), d, []) || '', /home directory/);
    assert.match(outputDirProblem(d, d, []) || '', /catalog directory itself/);
    assert.match(outputDirProblem(path.join(d, 'g1', 'out'), d, [path.join(d, 'g1')]) || '', /inside guide directory/);
    assert.match(outputDirProblem(d + '-all', d, [path.join(d + '-all', 'guides', 'x')]) || '', /contains guide directory/);
    assert.equal(outputDirProblem(path.join(d, 'out'), d, [path.join(d, 'g1')]), undefined);
    for (const bad of ['.', 'g1/out']) {
        fs.writeFileSync(path.join(d, 'outdir.json'), JSON.stringify({ outputDir: bad, guides: [{ slug: 'g1', dir: 'g1' }] }));
        assert.throws(() => readCatalog(path.join(d, 'outdir.json')), /outputDir/, bad);
    }
    // locale dir resolution: explicit map > locales/<code> > sibling; base locale = the guide dir
    const g = c.guides[0];
    assert.equal(resolveLocaleDir(g, 'en', 'en'), g.dir);
    assert.equal(resolveLocaleDir(g, 'fr', 'en'), undefined);
    assert.match(locateLocaleDir(g, 'fr', 'en').error || '', /no directory for locale "fr"/);
    assert.equal(cli(['localize', g.dir, 'fr']).status, 0);
    assert.equal(resolveLocaleDir(g, 'fr', 'en'), path.join(g.dir, 'locales', 'fr'));
    assert.equal(cli(['localize', g.dir, 'es', '--sibling']).status, 0);
    assert.equal(resolveLocaleDir(g, 'es', 'en'), path.join(d, 'es'));
    // an explicit map resolves against the catalog file, not the guide's parent (dir "guides/foo" + map "guides/foo-de")
    fs.mkdirSync(path.join(d, 'guides', 'foo'), { recursive: true });
    fs.cpSync(fixture, path.join(d, 'guides', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(d, 'guides', 'foo-de'), { recursive: true });
    fs.copyFileSync(path.join(g.dir, 'anim.config.json'), path.join(d, 'guides', 'foo-de', 'anim.config.json'));
    fs.writeFileSync(path.join(d, 'map.json'), JSON.stringify({ outputDir: 'out', guides: [{ slug: 'foo', dir: 'guides/foo', locales: { de: 'guides/foo-de', it: 'guides/foo-it' } }] }));
    const cm = readCatalog(path.join(d, 'map.json'));
    assert.equal(resolveLocaleDir(cm.guides[0], 'de', 'en'), path.join(d, 'guides', 'foo-de'));
    assert.match(locateLocaleDir(cm.guides[0], 'it', 'en').error || '', /locales\.it points at .*foo-it, which has no anim\.config\.json/, 'an explicit-map miss is its own message');
    // the build key changes with the sources, the settings and the tool; not with key order
    const st = effectiveSettings(cm.guides[0], { width: 640 });
    const k1 = buildKeyFor('sha256:a', st, undefined, 'tool@1');
    assert.equal(k1, buildKeyFor('sha256:a', { ...st }, undefined, 'tool@1'));
    assert.notEqual(k1, buildKeyFor('sha256:b', st, undefined, 'tool@1'));
    assert.notEqual(k1, buildKeyFor('sha256:a', { ...st, width: 641 }, undefined, 'tool@1'));
    assert.notEqual(k1, buildKeyFor('sha256:a', st, undefined, 'tool@2'));
    assert.notEqual(k1, buildKeyFor('sha256:a', st, { url: 'http://x' }, 'tool@1'));
});

test('mergeIndexEntries keeps untouched entries, replaces touched ones, drops entries no longer in the catalog', () => {
    const e = (slug: string, locale: string, status: IndexEntry['status']): IndexEntry => ({ slug, locale, dir: slug, output: `${slug}/${locale}`, status });
    const previous = [e('a', 'en', 'ok'), e('a', 'fr', 'ok'), e('gone', 'en', 'ok')];
    const merged = mergeIndexEntries(previous, [e('a', 'fr', 'failed')], [{ slug: 'a', locale: 'en' }, { slug: 'a', locale: 'fr' }, { slug: 'b', locale: 'en' }]);
    assert.deepEqual(merged.map(m => [m.slug, m.locale, m.status]), [['a', 'en', 'ok'], ['a', 'fr', 'failed']]);
    assert.deepEqual(mergeIndexEntries(undefined, [e('b', 'en', 'ok')], [{ slug: 'b', locale: 'en' }]).map(m => m.slug), ['b']);
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
        defaults: { locales: ['en', 'fr'], outputs: ['guide'], width: 640, height: 400, crop: 60 },
        guides: [{ slug: 'basic', dir: 'basic' }],
    }, null, 2));

    // dry run lists the plan without running anything
    const dry = cli(['build-all', 'help.catalog.json', '--dry-run'], d);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /basic\/fr:[\s\S]*anim-cli check .*--locale fr[\s\S]*anim-cli build[\s\S]*anim-cli export .*--guide/);
    assert.match(dry.stdout, /Dry run: 2 .*Nothing was written/);
    assert.ok(!fs.existsSync(path.join(d, 'help-out')), 'a dry run creates no output tree or index');
    assert.ok(!fs.existsSync(path.join(d, 'basic', 'anim.manifest.json')) || !JSON.parse(fs.readFileSync(path.join(d, 'basic', 'anim.manifest.json'), 'utf8')).history.some((h: any) => h.command === 'build-all'), 'a dry run records nothing');

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
    const en0 = index.guides[0];
    assert.equal(en0.video, 'basic/en/basic-en.mp4');
    assert.equal(en0.vtt, 'basic/en/basic-en.vtt');
    assert.equal(en0.guide, 'basic/en/guide/guide.json');
    assert.equal(en0.guideMd, 'basic/en/guide/guide.md');
    assert.equal(en0.guideHtml, 'basic/en/guide/guide.html');
    assert.equal(en0.poster, 'basic/en/guide/assets/poster.png');
    assert.ok(en0.builtAt && !Number.isNaN(Date.parse(en0.builtAt)), 'builtAt per entry');
    assert.ok(typeof en0.durationMs === 'number' && en0.durationMs > 0, 'durationMs');
    assert.match(en0.buildKey || '', /^sha256:/);
    const manifestEn = JSON.parse(fs.readFileSync(path.join(d, 'basic', 'anim.manifest.json'), 'utf8'));
    assert.match(manifestEn.contentHash.en, /^sha256:/);
    assert.equal(manifestEn.history.at(-1).command, 'build-all');
    assert.match(manifestEn.buildKey.en, /^sha256:/);

    // a dry run after a real build leaves the published index untouched (K-1)
    const indexBefore = fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8');
    const dry2 = cli(['build-all', 'help.catalog.json', '--dry-run', '--changed-only'], d);
    assert.equal(dry2.status, 0, dry2.stderr + dry2.stdout);
    assert.match(dry2.stdout, /basic\/en: unchanged .*would be skipped/);
    assert.equal(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'), indexBefore, 'dry run must not rewrite index.json');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'basic', 'anim.manifest.json'), 'utf8')).history.length, manifestEn.history.length, 'dry run records nothing');

    // --changed-only also notices catalog render settings: a new width rebuilds even though the sources are unchanged
    const catalogFile = path.join(d, 'help.catalog.json');
    const catalogText = fs.readFileSync(catalogFile, 'utf8');
    fs.writeFileSync(catalogFile, catalogText.replace('"width": 640', '"width": 600'));
    const dry3 = cli(['build-all', 'help.catalog.json', '--dry-run', '--changed-only'], d);
    assert.equal(dry3.status, 0, dry3.stderr + dry3.stdout);
    assert.match(dry3.stdout, /basic\/en: sources unchanged but the render settings or tool changed, rebuilding[\s\S]*anim-cli export .*--width 600/);
    assert.doesNotMatch(dry3.stdout, /would be skipped/);
    fs.writeFileSync(catalogFile, catalogText);

    // --changed-only: nothing changed -> both skipped without running any child command
    const c1 = cli(['build-all', 'help.catalog.json', '--changed-only'], d);
    assert.equal(c1.status, 0, c1.stderr + c1.stdout);
    assert.match(c1.stdout, /0 built, 2 skipped/);
    assert.doesNotMatch(c1.stdout, /→ basic/, 'no check/build/export was run');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'basic', 'anim.manifest.json'), 'utf8')).history.length, manifestEn.history.length, 'skipping records nothing');
    const idx1: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(idx1.guides.map(g => g.status), ['skipped', 'skipped']);
    assert.equal(idx1.guides[0].guide, 'basic/en/guide/guide.json', 'skipped entries keep their links');
    assert.equal(idx1.guides[0].video, 'basic/en/basic-en.mp4');
    assert.equal(idx1.guides[0].builtAt, en0.builtAt, 'skipped entries carry builtAt from the last build');

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
    assert.deepEqual(idx3.guides.map(g => [g.locale, g.status, !!g.stale]), [['en', 'skipped', false], ['fr', 'ok', false]], '--only/--locale merge into the previous index; an unedited re-run is not stale');
    assert.match(c3.stdout, /1 index entry kept from the previous run/);
    assert.ok(idx3.guides.find(g => g.locale === 'fr')!.diff!.maxFraction <= 0.005, 'unedited re-run frames settle (< 0.5%): ' + JSON.stringify(idx3.guides[1].diff));
    // filters that match nothing are an error and leave the index alone
    const indexAfterC3 = fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8');
    const nope = cli(['build-all', 'help.catalog.json', '--only', 'nope'], d);
    assert.equal(nope.status, 1);
    assert.match(nope.stderr, /--only nope matches no guide/);
    assert.equal(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'), indexAfterC3);

    // a failing guide: exit 1, index says failed; default stops at the first failure, --continue-on-error runs the rest
    fs.cpSync(fixture, path.join(d, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(d, 'broken', 'anim.config.json'), JSON.stringify([{ time: 0.5, action: 'click', target: '#missing', title: 'x' }]));
    fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({
        outputDir: 'help-out', defaults: { locales: ['en'], width: 640, height: 400, crop: 60 }, // same render settings as before, so basic is still unchanged
        guides: [{ slug: 'broken', dir: 'broken' }, { slug: 'basic', dir: 'basic' }],
    }));
    const f1 = cli(['build-all', 'help.catalog.json'], d);
    assert.equal(f1.status, 1);
    const fi1: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'help-out', 'index.json'), 'utf8'));
    assert.deepEqual(fi1.guides.map(g => [g.slug, g.locale, g.status]), [['broken', 'en', 'failed'], ['basic', 'en', 'skipped']], 'stop-at-first-failure keeps the untouched entry as it was; fr left the catalog and is dropped');
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

test('build-all: a record entry builds against a live page, with and without storageState (check --live, no build)', { skip }, async () => {
    const app = await startLiveApp({ listDelayMs: 200 });
    try {
        const d = path.join(work, 'rec'); fs.mkdirSync(d, { recursive: true });
        const host = new URL(app.url).hostname;
        // Without storage state: the timeline logs in (form POST + redirect) then highlights the async list.
        fs.mkdirSync(path.join(d, 'live-login'));
        fs.writeFileSync(path.join(d, 'live-login', 'anim.config.json'), JSON.stringify({
            meta: { title: 'Sign in', url: `${app.url}/login`, cursor: 'mac', tailMs: 500 },
            steps: [
                { id: 'user', time: 0.5, action: 'type', target: '[data-help="login-user"]', value: 'ada', title: 'Enter your user name' },
                { id: 'submit', time: 1.6, action: 'click', target: '[data-help="login-submit"]', title: 'Sign in' },
                { id: 'items', time: 2.8, action: 'highlight', target: '[data-help="items"] li:first-child', waitFor: '[data-help="items"] li', title: 'Your proposals' },
            ],
        }));
        // With storage state: the session cookie skips the login; the URL is the dashboard itself.
        fs.mkdirSync(path.join(d, 'live-auth'));
        fs.writeFileSync(path.join(d, 'auth.json'), JSON.stringify({ cookies: [{ name: 'session', value: '1', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }));
        fs.writeFileSync(path.join(d, 'live-auth', 'anim.config.json'), JSON.stringify({
            meta: { title: 'Settings', url: `${app.url}/dashboard`, cursor: 'mac', tailMs: 500 },
            steps: [
                { id: 'items', time: 0.8, action: 'highlight', target: '[data-help="items"] li:first-child', waitFor: '[data-help="items"] li', title: 'Your proposals' },
                { id: 'settings', time: 1.8, action: 'click', target: '[data-help="tab-settings"]', title: 'Open settings' },
            ],
        }));
        fs.writeFileSync(path.join(d, 'help.catalog.json'), JSON.stringify({
            outputDir: 'rec-out', defaults: { width: 640, height: 400, crop: 60 },
            guides: [
                { slug: 'live-login', dir: 'live-login', record: { url: `${app.url}/login` } },
                { slug: 'live-auth', dir: 'live-auth', record: { url: `${app.url}/dashboard`, storageState: 'auth.json' } },
            ],
        }));
        const r = await cliAsync(['build-all', 'help.catalog.json'], d);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(r.stdout, /→ live-login\/en: check[\s\S]*→ live-login\/en: record/);
        assert.doesNotMatch(r.stdout, /→ live-login\/en: build/, 'record entries do not run build');
        const index: IndexJson = JSON.parse(fs.readFileSync(path.join(d, 'rec-out', 'index.json'), 'utf8'));
        assert.deepEqual(index.guides.map(g => [g.slug, g.status]), [['live-login', 'ok'], ['live-auth', 'ok']]);
        for (const slug of ['live-login', 'live-auth']) {
            const e = index.guides.find(g => g.slug === slug)!;
            assert.equal(e.video, `${slug}/en/${slug}-en.mp4`);
            assert.equal(e.guide, `${slug}/en/guide/guide.json`);
            assert.ok(fs.existsSync(path.join(d, 'rec-out', slug, 'en', `${slug}-en.mp4`)), `${slug} video`);
            const g = JSON.parse(fs.readFileSync(path.join(d, 'rec-out', slug, 'en', 'guide', 'guide.json'), 'utf8'));
            assert.ok(g.steps.length >= 2 && g.steps.every((st: any) => !st.error), `${slug} guide steps: ${JSON.stringify(g.steps.map((st: any) => st.error))}`);
        }
        // The auth guide's first frame is the dashboard (the cookie was applied), not the login form.
        const auth = JSON.parse(fs.readFileSync(path.join(d, 'rec-out', 'live-auth', 'en', 'guide', 'guide.json'), 'utf8'));
        assert.equal(auth.steps[0].id, 'items');
    } finally {
        await app.close();
    }
});
