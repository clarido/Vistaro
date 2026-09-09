import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import { loadTimeline, resolveConfigPath, parseTimeline } from '../src/engine/schema';
import { stringsPathFor, localizedStringsFiles } from '../src/engine/strings';
import { hashGuideDir, guideSourceFiles } from '../src/catalog';
import { buildTourPage } from '../src/engine/inject';
import { readTourCatalog } from '../src/commands/tour';
import { fileUrl } from '../src/browser';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'basic');
/**
 * A wedged child (a Chromium that will not close, a page stuck mid-navigation) used to hang the
 * whole suite: nothing bounded the wait, and node:test's own default timeout is Infinity. This
 * bound is per CALL, not per test, and it must stay well above the slowest healthy one -- CI runs
 * ~1.4x slower than a local machine and AGENTS.md warns the suite degrades beside other browser
 * jobs -- while staying far under the runner's own --test-timeout, so a wedge is reported here,
 * by name, rather than as the runner cancelling the whole test.
 */
const CLI_TIMEOUT_MS = 300000;

/** spawnSync reports a timeout as error ETIMEDOUT + signal SIGKILL and status null, which an
 *  `assert.equal(res.status, 0)` renders as "expected null to equal 0" -- true, and useless. */
function assertRan(res: { error?: Error; signal?: NodeJS.Signals | null }, args: string[]): void {
    if (res.signal || res.error) {
        const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
        const why = code === 'ETIMEDOUT' ? `did not finish within ${CLI_TIMEOUT_MS}ms and was killed` : `was killed by ${res.signal ?? code}`;
        throw new Error(`cli ${args.join(' ')} ${why}`);
    }
}
const cli = (args: string[]) => { const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' }); assertRan(res, args); return res; };

let work: string;
/** A copy of the fixture: `tour` records a manifest event into the source dir, and a test must
 *  never write into test/fixtures (a stray anim.manifest.json there leaks into other suites). */
let screen: string;
before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-tour-'));
    screen = path.join(work, 'screen');
    fs.cpSync(fixture, screen, { recursive: true });
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

/** Write a catalog in `work` whose scenarios point at absolute dirs (catalog paths are catalog-relative). */
function writeCatalog(name: string, catalog: any): string {
    const file = path.join(work, `${name}.catalog.json`);
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2), 'utf8');
    return file;
}

const basicScenario = (extra: any = {}) => ({ slug: 'basic', dir: screen, label: 'Basic', ...extra });

// --- the compatibility invariant -------------------------------------------------------------

test('an explicit default config resolves and hashes exactly like no config at all', () => {
    assert.equal(resolveConfigPath(fixture), path.join(fixture, 'anim.config.json'));
    assert.equal(resolveConfigPath(fixture, 'anim.config.json'), path.join(fixture, 'anim.config.json'));
    // Every cached contentHash and buildKey in existence depends on this staying true.
    assert.equal(hashGuideDir(fixture), hashGuideDir(fixture, { config: 'anim.config.json' }));
    assert.deepEqual(guideSourceFiles(fixture), guideSourceFiles(fixture, { config: 'anim.config.json' }));
});

test('an alternate timeline hashes itself, not the directory default', () => {
    const dir = path.join(work, 'hash');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    const alt = path.join(dir, 'scenarios', 'alt.json');
    fs.writeFileSync(alt, JSON.stringify({ meta: { title: 'Alt' }, steps: [{ id: 'a', time: '0s', action: 'wait', title: 'A' }] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'strings.en.json'), JSON.stringify({ 'meta.title': 'Base' }), 'utf8');

    const names = guideSourceFiles(dir, { config: 'scenarios/alt.json' }).map(f => path.basename(f));
    assert.ok(names.includes('alt.json'), 'its own timeline is hashed');
    assert.ok(names.includes('index.html'), 'the shared screen is hashed');
    // Folding in the default timeline would make an edit to one scenario rebuild every other one.
    assert.ok(!names.includes('anim.config.json'), 'the default timeline is not');
    assert.ok(!names.includes('strings.en.json'), "nor the default timeline's strings");
    assert.notEqual(hashGuideDir(dir, { config: 'scenarios/alt.json' }), hashGuideDir(dir));
});

test('strings belong to a timeline, not to a directory', () => {
    assert.equal(stringsPathFor('/x/anim.config.json', 'fr'), path.join('/x', 'strings.fr.json'));
    assert.equal(stringsPathFor('/x/scenarios/export-word.json', 'fr'), path.join('/x/scenarios', 'export-word.strings.fr.json'));

    const dir = path.join(work, 'strings');
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'strings.fr.json'), '{}', 'utf8');
    // Two timelines in one tree must not see each other's translations: the keys are steps.<id>.<field>,
    // so a shared file would translate a different scenario's step of the same id.
    assert.equal(localizedStringsFiles(path.join(dir, 'anim.config.json')).length, 1);
    assert.equal(localizedStringsFiles(path.join(dir, 'scenarios', 'alt.json')).length, 0);
});

test('an alternate timeline is loaded with the same locale and strings machinery as the default', () => {
    const dir = path.join(work, 'load');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scenarios', 'alt.json'),
        JSON.stringify({ meta: { title: 'Alt', locale: 'fr' }, steps: [{ id: 'a', time: '0s', action: 'wait', title: 'Untranslated' }] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'scenarios', 'alt.strings.fr.json'),
        JSON.stringify({ 'steps.a.title': 'Traduit' }), 'utf8');

    const tl = loadTimeline(dir, { config: 'scenarios/alt.json' });
    assert.equal(tl.steps[0].title, 'Traduit', 'its own strings file is applied');
    assert.equal(tl.configFile, path.join(dir, 'scenarios', 'alt.json'));
    assert.equal(loadTimeline(dir).steps[0].title, 'Overview', 'the default timeline is untouched');
});

test('a missing --config is a hard error naming the file, not a fallback', () => {
    assert.throws(() => loadTimeline(fixture, { config: 'scenarios/nope.json' }), /timeline not found:.*nope\.json/);
});

// --- catalog validation ------------------------------------------------------------------------

test('a broken catalog reports every problem in one run', () => {
    const file = writeCatalog('bad', {
        outputDir: path.join(work, 'bad-out'),
        groups: [{ id: 'a', label: 'A' }],
        scenarios: [
            basicScenario(),
            basicScenario(),                                            // duplicate slug
            { slug: 'grouped', dir: screen, group: 'nope' },           // undeclared group
            { slug: 'missing', dir: screen, config: 'nope.json' },     // no such timeline
            { slug: 'badlocale', dir: screen, locale: 'not-a-locale' },
            { slug: 'nodir' },
        ],
    });
    const message = (() => { try { readTourCatalog(file); return ''; } catch (e: any) { return e.message; } })();
    assert.match(message, /duplicate scenario slug "basic"/);
    assert.match(message, /group "nope", which no entry of "groups" declares/);
    assert.match(message, /timeline not found/);
    assert.match(message, /"locale" must be a locale code/);
    assert.match(message, /needs a "dir"/);
});

test('a reel is refused with the reason, not with one error per untitled step', () => {
    const dir = path.join(work, 'reel');
    fs.cpSync(fixture, dir, { recursive: true });
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8')));
    fs.writeFileSync(path.join(dir, 'anim.config.json'),
        JSON.stringify({ meta: { ...tl.meta, kind: 'reel' }, steps: tl.steps.map(s => ({ ...s, title: undefined })) }), 'utf8');
    const file = writeCatalog('reel', { outputDir: path.join(work, 'reel-out'), scenarios: [{ slug: 'reel', dir }] });

    const r = cli(['tour', file]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /kind: "reel"/);
    assert.doesNotMatch(r.stderr + r.stdout, /needs a "title"/);
});

test('an outputDir overlapping a scenario directory is refused, not allowed to eat the mockup', () => {
    const dir = path.join(work, 'overlap');
    fs.cpSync(fixture, dir, { recursive: true });
    const before = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    // The shell's own index.html is copied into outputDir; if that is the scenario's directory the
    // mockup is overwritten, then read back as the screen, and the run still reports success.
    const file = writeCatalog('overlap', { outputDir: dir, scenarios: [{ slug: 'basic', dir }] });

    const r = cli(['tour', file]);
    assert.notEqual(r.status, 0, 'refused');
    assert.match(r.stderr + r.stdout, /overlaps scenario/);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), before, 'the mockup is untouched');
});

test('a slug is lowercase, because it becomes a directory name on a case-insensitive filesystem', () => {
    const file = writeCatalog('case', {
        outputDir: path.join(work, 'case-out'),
        scenarios: [basicScenario({ slug: 'Export-Word' })],
    });
    assert.throws(() => readTourCatalog(file), /lowercase/);
});

// --- the scenario page -------------------------------------------------------------------------

test('a scenario page carries the scheduler and leaves playback to the shell', () => {
    const timeline = loadTimeline(fixture);
    const html = buildTourPage('<html><body><div id="app"></div></body></html>', timeline);
    assert.ok(html.includes('window.__tour'), 'the tour scheduler is injected');
    assert.ok(html.includes('window.__anim.boot('), 'so is the runtime');
    assert.match(html, /"autoplay":\s*"message"/, 'the page never starts on its own');
    assert.match(html, /"subtitles":\s*false/, 'the shell draws the caption, not the page');
    assert.ok(html.includes('__tour.boot('), 'the timeline travels with the page for instant replay');
});

test('a tour page does not drift, because a tour frame crops what a video merely lets overhang', () => {
    const timeline = loadTimeline(fixture);
    const html = buildTourPage('<html><body><div id="app"></div></body></html>', timeline);
    // scale(1.025) from a centred origin overhangs 1.25% per edge (16px at 1280). Off-screen in a
    // fullscreen video; cropped by the canvas in a tour, taking a full-bleed element's spotlight with it.
    assert.match(html, /"drift":\s*false/, 'drift is off by default on a tour page');

    const optedIn = buildTourPage('<html><body></body></html>', { ...timeline, meta: { ...timeline.meta, drift: true } });
    assert.match(optedIn, /"drift":\s*true/, 'an author can still opt in with meta.drift');
});

test('tour builds a shell plus one page per scenario, and records an event per source dir', () => {
    const dir = path.join(work, 'build');
    fs.cpSync(fixture, dir, { recursive: true });
    const out = path.join(work, 'build-out');
    const file = writeCatalog('build', { outputDir: out, scenarios: [{ slug: 'basic', dir, label: 'Basic', blurb: 'b' }] });

    const r = cli(['tour', file]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const f of ['index.html', 'app.css', 'app.js', 'tours.json']) {
        assert.ok(fs.existsSync(path.join(out, f)), `${f} written`);
    }
    assert.ok(fs.existsSync(path.join(out, 'scenarios', 'basic', 'index.html')));

    const tours = JSON.parse(fs.readFileSync(path.join(out, 'tours.json'), 'utf8'));
    assert.equal(tours.scenarios.length, 1);
    assert.equal(tours.scenarios[0].steps.length, 9, 'every step travels, hidden or not');
    assert.equal(tours.scenarios[0].stepCount, 9, 'all nine are titled in the fixture');

    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.equal(ev.command, 'tour');
    assert.equal(ev.scenario, 'basic');
    assert.ok(ev.contentHash.startsWith('sha256:'));
    assert.ok(!path.isAbsolute(ev.output), 'manifest paths are relative to the directory that owns them');
});

// --- the bridge protocol -----------------------------------------------------------------------

test('the tour scheduler plays, seeks, and rewinds the page state with it', { skip }, async () => {
    const out = path.join(work, 'bridge-out');
    const file = writeCatalog('bridge', { outputDir: out, scenarios: [basicScenario()] });
    const r = cli(['tour', file]);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        // Unframed, `parent === window`, so the bridge's outbound posts land on this listener.
        await page.addInitScript(() => {
            (window as any).__msgs = [];
            window.addEventListener('message', (e: any) => {
                if (e.data && e.data.source === 'anim-tour') (window as any).__msgs.push(e.data);
            });
        });
        await page.goto(fileUrl(path.join(out, 'scenarios', 'basic', 'index.html')));

        await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'ready'), null, { timeout: 15000 });
        const ready = await page.evaluate(() => (window as any).__msgs.find((m: any) => m.type === 'ready'));
        assert.equal(ready.total, 9);
        assert.equal(ready.steps[2].id, 'name');

        const send = (type: string, extra: any = {}) =>
            page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type, ...extra });
        const index = () => page.evaluate(() => (window as any).__tour.state().index);

        await send('play');
        await page.waitForFunction(() => (window as any).__tour.state().index >= 2, null, { timeout: 20000 });
        await send('pause');

        // Step 3 types "Ada" into #field; play through it, then seek back before it.
        await send('goto', { index: 3 });
        await page.waitForFunction(() => (window as any).__tour.state().index === 3, null, { timeout: 20000 });
        await page.waitForFunction(() => (document.getElementById('field') as HTMLInputElement).value === 'Ada', null, { timeout: 20000 });

        await send('goto', { index: 1 });
        await page.waitForFunction(() => (window as any).__tour.state().index === 1, null, { timeout: 20000 });
        assert.equal(await index(), 1);
        // Seeking replays from the authored DOM rather than rewinding, so the field is genuinely
        // empty again -- this is the assertion that catches a broken restart().
        assert.equal(await page.evaluate(() => (document.getElementById('field') as HTMLInputElement).value), '',
            'seeking backwards past a type step un-types it');

        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

test('a step that cannot run reports an error instead of hanging the tour', { skip }, async () => {
    // A selector that no longer matches rejects inside the instant replay. Unreported, the seek
    // never reaches advance() and the shell waits forever with no state, no end and no error.
    const dir = path.join(work, 'broken');
    fs.cpSync(fixture, dir, { recursive: true });
    const tl = JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8'));
    tl.steps[1].target = '#does-not-exist';
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(tl), 'utf8');

    const out = path.join(work, 'broken-out');
    const file = writeCatalog('broken', { outputDir: out, scenarios: [{ slug: 'broken', dir }] });
    const r = cli(['tour', file, '--force']);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.addInitScript(() => {
            (window as any).__msgs = [];
            window.addEventListener('message', (e: any) => {
                if (e.data && e.data.source === 'anim-tour') (window as any).__msgs.push(e.data);
            });
        });
        page.on('pageerror', () => { /* the rejected step is expected to surface */ });
        await page.goto(fileUrl(path.join(out, 'scenarios', 'broken', 'index.html')));
        await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'ready'), null, { timeout: 15000 });

        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'goto', index: 3 });
        await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'error'), null, { timeout: 20000 });

        const state = await page.evaluate(() => (window as any).__tour.state());
        assert.equal(state.playing, false, 'playback stops rather than pretending to continue');
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});
