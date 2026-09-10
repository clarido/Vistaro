import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawnSync } from 'child_process';
import { chromium, Browser } from 'playwright';
import { loadTimeline, resolveConfigPath, parseTimeline } from '../src/engine/schema';
import { stringsPathFor, localizedStringsFiles } from '../src/engine/strings';
import { hashGuideDir, guideSourceFiles } from '../src/catalog';
import { buildTourPage } from '../src/engine/inject';
import { readTourCatalog } from '../src/commands/tour';
import { videoFromManifest } from '../src/commands/guide';
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

// --- --config on the read commands ------------------------------------------------------------

test('check validates a scenario timeline, and still names whichever file it read', () => {
    const dir = path.join(work, 'checkcfg');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    const alt = path.join(dir, 'scenarios', 'alt.json');
    fs.writeFileSync(alt, JSON.stringify({ meta: { title: 'Alt' }, steps: [
        { id: 'a', time: '0s', action: 'click', target: '#btn', title: 'Press it' },
    ] }), 'utf8');

    const scoped = cli(['check', dir, '--config', alt, '--static']);
    assert.equal(scoped.status, 0, scoped.stderr + scoped.stdout);
    assert.match(scoped.stdout, /alt\.json \(1 steps/, 'the summary names the timeline actually validated');

    const dflt = cli(['check', dir, '--static']);
    assert.equal(dflt.status, 0, dflt.stderr + dflt.stdout);
    assert.match(dflt.stdout, /anim\.config\.json \(9 steps/, 'the default path is untouched');
});

test('a --config that does not exist fails loudly instead of recording a blind legacy video', () => {
    const dir = path.join(work, 'blind');
    fs.cpSync(fixture, dir, { recursive: true });
    // The trap: export falls back to animated.html when it finds no timeline, so a typo used to
    // produce a plausible 5-second video of whatever the last build left behind.
    fs.writeFileSync(path.join(dir, 'animated.html'), '<html><body>stale</body></html>', 'utf8');
    const out = path.join(work, 'blind.mp4');

    const r = cli(['export', dir, '--config', path.join(dir, 'nope.json'), '-o', out]);
    assert.notEqual(r.status, 0, 'refused');
    assert.match(r.stderr + r.stdout, /timeline not found/);
    assert.ok(!fs.existsSync(out), 'and wrote no video');
});

test('a scenario gets its own preview and animated page instead of clobbering the default', () => {
    const dir = path.join(work, 'names');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
    const alt = path.join(dir, 'scenarios', 'alt.json');
    fs.writeFileSync(alt, JSON.stringify({ meta: { title: 'Alt' }, steps: [
        { id: 'a', time: '0s', action: 'wait', title: 'A' },
    ] }), 'utf8');

    assert.equal(cli(['build', dir]).status, 0);
    assert.equal(cli(['build', dir, '--config', alt]).status, 0);
    assert.ok(fs.existsSync(path.join(dir, 'animated.html')), 'the default page still exists');
    assert.ok(fs.existsSync(path.join(dir, 'animated.alt.html')), 'and the scenario has its own');
});

test('a guide links the video its own timeline produced, not the sibling scenario\'s', () => {
    const dir = path.join(work, 'videolink');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'default.mp4'), 'x', 'utf8');
    fs.writeFileSync(path.join(dir, 'alt.mp4'), 'x', 'utf8');
    // Two exports from one directory. Without scoping, both timelines resolve to the newest.
    fs.writeFileSync(path.join(dir, 'anim.manifest.json'), JSON.stringify({ history: [
        { command: 'export', driven: true, output: 'default.mp4', duration: 1, steps: [] },
        { command: 'export', driven: true, output: 'alt.mp4', duration: 1, steps: [], config: 'scenarios/alt.json' },
    ] }), 'utf8');

    assert.match(videoFromManifest(dir)!.file, /default\.mp4$/, 'no config means the default timeline');
    assert.match(videoFromManifest(dir, 'scenarios/alt.json')!.file, /alt\.mp4$/, 'the scenario gets its own');
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
    // The device is in the name even when only one is built: an unsuffixed page would be
    // overwritten the day a second device is added, leaving a desktop page in a phone frame.
    assert.ok(fs.existsSync(path.join(out, 'scenarios', 'basic', 'index-desktop.html')));
    assert.ok(!fs.existsSync(path.join(out, 'scenarios', 'basic', 'index.html')), 'no unsuffixed page is written');

    const tours = JSON.parse(fs.readFileSync(path.join(out, 'tours.json'), 'utf8'));
    assert.equal(tours.scenarios.length, 1);
    assert.deepEqual(tours.scenarios[0].devices, ['desktop']);
    const variant = tours.scenarios[0].variants.desktop;
    assert.equal(variant.page, 'scenarios/basic/index-desktop.html');
    assert.equal(variant.steps.length, 9, 'every step travels, hidden or not');
    assert.equal(variant.stepCount, 9, 'all nine are titled in the fixture');

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
        await page.goto(fileUrl(path.join(out, 'scenarios', 'basic', 'index-desktop.html')));

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
        await page.goto(fileUrl(path.join(out, 'scenarios', 'broken', 'index-desktop.html')));
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

// --- embedding ---------------------------------------------------------------------------------

test('--embed writes a page per device, the custom element and a snippet; a plain build writes none', () => {
    const out = path.join(work, 'embed-out');
    const file = writeCatalog('embed', { outputDir: out, scenarios: [basicScenario({ blurb: 'b' })] });

    const plain = cli(['tour', file]);
    assert.equal(plain.status, 0, plain.stderr + plain.stdout);
    assert.ok(!fs.existsSync(path.join(out, 'anim-tour.js')), 'the element is not shipped when nothing embeds it');
    assert.ok(!fs.readdirSync(out).some(f => f.startsWith('embed-')), 'no embed pages without --embed');

    const r = cli(['tour', file, '--embed']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const f of ['anim-tour.js', 'embed-basic-desktop.html', 'embed-basic.snippet.html']) {
        assert.ok(fs.existsSync(path.join(out, f)), `${f} written`);
    }
    const page = fs.readFileSync(path.join(out, 'embed-basic-desktop.html'), 'utf8');
    // Solo mode is the whole mechanism: the same app.js, told which scenario and which device.
    assert.match(page, /data-scenario="basic"/);
    assert.match(page, /data-device="desktop"/);
    assert.match(page, /class="solo"/);
    assert.ok(!page.includes('rail-list'), 'an embed has no scenario rail');

    const snippet = fs.readFileSync(path.join(out, 'embed-basic.snippet.html'), 'utf8');
    // The observer must be in the PARENT: inside the frame it measures against the frame's own
    // viewport and reports an embed far below the fold as fully visible.
    assert.match(snippet, /IntersectionObserver/);
    assert.match(snippet, /anim-tour-host/);
    // Only desktop was built, so the phone branch may not point at a page that does not exist.
    assert.match(snippet, /data-mobile="embed-basic-desktop\.html"/);
});

test('a two-device scenario builds a page per device, and dropping one prunes its pages but not the other\'s', () => {
    const out = path.join(work, 'twodev-out');
    const both = writeCatalog('twodev2', { outputDir: out, scenarios: [basicScenario({ devices: ['desktop', 'mobile'] })] });
    assert.equal(cli(['tour', both, '--embed']).status, 0);
    for (const f of ['scenarios/basic/index-desktop.html', 'scenarios/basic/index-mobile.html', 'embed-basic-desktop.html', 'embed-basic-mobile.html']) {
        assert.ok(fs.existsSync(path.join(out, f)), `${f} written`);
    }
    const tours = JSON.parse(fs.readFileSync(path.join(out, 'tours.json'), 'utf8'));
    assert.deepEqual(tours.scenarios[0].devices, ['desktop', 'mobile']);
    // The phone page is 390x844 unless defaults.mobile says otherwise; the desktop default is 1920.
    assert.equal(tours.scenarios[0].variants.mobile.viewport.width, 390);
    assert.equal(tours.scenarios[0].variants.desktop.viewport.width, 1920);
    // With both built, the snippet's phone branch is a real phone page rather than the desktop one.
    assert.match(fs.readFileSync(path.join(out, 'embed-basic.snippet.html'), 'utf8'), /data-mobile="embed-basic-mobile\.html"/);

    const one = writeCatalog('twodev1', { outputDir: out, scenarios: [basicScenario({ devices: ['desktop'] })] });
    assert.equal(cli(['tour', one, '--embed']).status, 0);
    assert.ok(!fs.existsSync(path.join(out, 'embed-basic-mobile.html')), 'the dropped device loses its embed page');
    assert.ok(!fs.existsSync(path.join(out, 'scenarios', 'basic', 'index-mobile.html')), 'and its scenario page');
    assert.ok(fs.existsSync(path.join(out, 'embed-basic-desktop.html')), 'the surviving device keeps both');
});

test('an empty devices list is refused rather than building a scenario with no variants', () => {
    const out = path.join(work, 'nodev-out');
    for (const [name, catalog] of [
        ['nodev-scenario', { outputDir: out, scenarios: [basicScenario({ devices: [] })] }],
        ['nodev-defaults', { outputDir: out, defaults: { devices: [] }, scenarios: [basicScenario()] }],
    ] as [string, any][]) {
        const r = cli(['tour', writeCatalog(name, catalog)]);
        // Left to itself it survives the `?? defaults` fallback, builds zero pages, writes a
        // variant-less entry the shell dereferences into a blank canvas -- and exits 0.
        assert.equal(r.status, 1, `${name} must fail: ${r.stdout}`);
        assert.match(r.stderr + r.stdout, /"devices" must be a non-empty array|defaults\.devices must be a non-empty array/);
    }
    assert.ok(!fs.existsSync(path.join(out, 'tours.json')), 'and nothing is written');
});

test('a scenario that fails keeps the embed pages a customer may be framing', () => {
    const broken = path.join(work, 'flaky');
    fs.cpSync(fixture, broken, { recursive: true });
    const out = path.join(work, 'flaky-out');
    const file = writeCatalog('flaky', { outputDir: out, scenarios: [basicScenario(), { slug: 'flaky', dir: broken, label: 'Flaky' }] });
    assert.equal(cli(['tour', file, '--embed']).status, 0);
    assert.ok(fs.existsSync(path.join(out, 'embed-flaky-desktop.html')));

    // Titles are what the shell's ticks and captions are built from, so losing them is a build error.
    const t = JSON.parse(fs.readFileSync(path.join(broken, 'anim.config.json'), 'utf8'));
    for (const step of t.steps) delete step.title;
    fs.writeFileSync(path.join(broken, 'anim.config.json'), JSON.stringify(t, null, 2), 'utf8');

    const r = cli(['tour', file, '--embed']);
    assert.equal(r.status, 1, 'the failure is still reported');
    // The scenario is still in the catalog and its scenario page is still on disk, so deleting its
    // embed pages would break someone's site over an error the next run may well fix.
    assert.ok(fs.existsSync(path.join(out, 'embed-flaky-desktop.html')), 'a failed scenario keeps its embed page');
    assert.ok(fs.existsSync(path.join(out, 'embed-flaky.snippet.html')), 'and its snippet');
});

test('an embed page for a scenario dropped from the catalog is removed, not left being framed', () => {
    const other = path.join(work, 'screen2');
    fs.cpSync(fixture, other, { recursive: true });
    const out = path.join(work, 'embed-prune-out');
    const two = writeCatalog('prune2', { outputDir: out, scenarios: [basicScenario(), { slug: 'second', dir: other, label: 'Second' }] });
    assert.equal(cli(['tour', two, '--embed']).status, 0);
    assert.ok(fs.existsSync(path.join(out, 'embed-second-desktop.html')));

    const one = writeCatalog('prune1', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', one, '--embed']).status, 0);
    assert.ok(!fs.existsSync(path.join(out, 'embed-second-desktop.html')), 'the stale embed page is gone');
    assert.ok(!fs.existsSync(path.join(out, 'embed-second.snippet.html')), 'and so is its snippet');
    assert.ok(fs.existsSync(path.join(out, 'embed-basic-desktop.html')), 'the surviving scenario keeps its page');
});

/** Serve `dir` over http: the shell reads tours.json with fetch, which file:// refuses. */
async function serve(dir: string): Promise<{ port: number; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const full = path.join(dir, rel);
        if (!full.startsWith(dir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
        const type = full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : 'text/html';
        res.writeHead(200, { 'content-type': type });
        res.end(fs.readFileSync(full));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as any).port, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('<anim-tour> loads lazily, emits its events, and survives being moved in the DOM', { skip }, async () => {
    const out = path.join(work, 'element-out');
    const file = writeCatalog('element', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', file, '--embed']).status, 0);

    // The element is desktop-only here, so a phone-shaped host must fall back rather than frame a
    // 404: `device="mobile"` is asked for and `embed-basic-desktop.html` is what may load.
    fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html><meta charset="utf-8"><title>host</title>
<div style="height:1400px"></div>
<anim-tour id="t" src="./" scenario="basic" device="mobile" autoplay="inview"></anim-tour>
<div style="height:1400px"></div>
<div id="elsewhere"></div>
<script type="module" src="anim-tour.js"></script>
<script>
  window.__ev = [];
  for (const n of ['tourready', 'tourstep', 'tourend', 'tourerror'])
    document.getElementById('t').addEventListener(n, e => window.__ev.push({ n, detail: e.detail }));
</script>`, 'utf8');

    const server = await serve(out);
    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
        await page.goto(`http://127.0.0.1:${server.port}/host.html`);

        // Lazy: 1400px above the fold, the frame must not have a src yet.
        assert.equal(await page.evaluate(() => !document.querySelector('#t iframe')!.getAttribute('src')), true, 'the frame is not loaded until it is near the viewport');

        await page.evaluate(() => document.getElementById('t')!.scrollIntoView({ block: 'center' }));
        await page.waitForFunction(() => (window as any).__ev.some((e: any) => e.n === 'tourready'), null, { timeout: 20000 });
        const src = await page.evaluate(() => document.querySelector('#t iframe')!.getAttribute('src'));
        assert.match(src!, /embed-basic-desktop\.html$/, 'mobile was asked for and only desktop exists, so desktop is what loads');

        // autoplay="inview" is the host's decision, and it is taken on `ready` -- the frame finishes
        // loading long after the visibility observer first fired.
        await page.waitForFunction(() => (window as any).__ev.some((e: any) => e.n === 'tourstep'), null, { timeout: 20000 });
        const before = await page.evaluate(() => (window as any).__ev.filter((e: any) => e.n === 'tourstep').length);
        const height = await page.evaluate(() => parseInt((document.querySelector('#t iframe') as HTMLElement)!.style.height, 10));
        assert.ok(height > 0 && height !== 620, `auto-height replaced the 620px default (got ${height})`);

        // Moving the element re-runs connectedCallback. An element that re-registered nothing keeps
        // rendering its frame and looks fine, while every event and the auto-height are gone.
        await page.evaluate(() => document.getElementById('elsewhere')!.appendChild(document.getElementById('t')!));
        await page.evaluate(() => (document.getElementById('t') as any).restart());
        await page.waitForFunction((n) => (window as any).__ev.filter((e: any) => e.n === 'tourstep').length > n, before, { timeout: 20000 });
    } finally {
        if (browser) await browser.close();
        await server.close();
    }
});

test('an embed relays to its host, takes commands from it, and reports a height that can shrink', { skip }, async () => {
    const out = path.join(work, 'relay-out');
    const file = writeCatalog('relay', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', file, '--embed']).status, 0);

    // http, not file://: the shell reads tours.json with fetch, which file:// refuses.
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const full = path.join(out, rel);
        if (!full.startsWith(out) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
        const type = full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : 'text/html';
        res.writeHead(200, { 'content-type': type });
        res.end(fs.readFileSync(full));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    // The frame is deliberately opened much TALLER than the embed needs: a height measured from the
    // document can never come back below the frame it is inside, so this is what proves the reported
    // height is measured from the content instead.
    const FRAME_H = 900;
    fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html><meta charset="utf-8"><title>host</title>
<iframe id="f" src="embed-basic-desktop.html" style="width:900px;height:${FRAME_H}px;border:0"></iframe>
<script>
  window.__got = [];
  addEventListener('message', function (e) { if (e.data && e.data.source === 'anim-tour-embed') window.__got.push(e.data); });
  window.__send = function (type) { document.getElementById('f').contentWindow.postMessage({ source: 'anim-tour-host', type: type }, '*'); };
</script>`, 'utf8');

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
        await page.goto(`http://127.0.0.1:${port}/host.html`);

        await page.waitForFunction(() => (window as any).__got.some((m: any) => m.type === 'ready'), null, { timeout: 20000 });
        const ready = await page.evaluate(() => (window as any).__got.find((m: any) => m.type === 'ready'));
        assert.equal(ready.scenario, 'basic');
        assert.equal(ready.device, 'desktop', 'the page says which variant it is, so a host can label it');

        await page.waitForFunction(() => (window as any).__got.some((m: any) => m.type === 'size'), null, { timeout: 10000 });
        const height = await page.evaluate(() => (window as any).__got.filter((m: any) => m.type === 'size').pop().height);
        assert.ok(height > 0 && height < FRAME_H, `reported height ${height} must be the content's, not the ${FRAME_H}px frame's`);

        // Playback is the host's decision, because only the host can see where the frame really is.
        await page.evaluate(() => (window as any).__send('play'));
        await page.waitForFunction(() => (window as any).__got.some((m: any) => m.type === 'step' && m.playing), null, { timeout: 20000 });
        await page.evaluate(() => (window as any).__send('pause'));
        await page.waitForFunction(() => { const s = (window as any).__got.filter((m: any) => m.type === 'step').pop(); return s && !s.playing; }, null, { timeout: 20000 });
    } finally {
        if (browser) await browser.close();
        await new Promise<void>(r => server.close(() => r()));
    }
});
