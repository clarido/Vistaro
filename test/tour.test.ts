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
    // 1-based authored indexes like guide.json and the manifest, not 0-based array positions.
    assert.deepEqual(variant.steps.map((s: any) => s.index), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

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

        // The error REPLACES the state message for its turn: a state right after it used to make
        // the shell's paint() overwrite the caption before anyone could read what went wrong.
        await page.waitForTimeout(250);
        const last = await page.evaluate(() => (window as any).__msgs[(window as any).__msgs.length - 1]);
        assert.equal(last.type, 'error', 'nothing follows the error');

        const state = await page.evaluate(() => (window as any).__tour.state());
        assert.equal(state.playing, false, 'playback stops rather than pretending to continue');
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

test('a play arriving during a seek replay resumes AT the seeked step, not past it', { skip }, async () => {
    // goto(n) then play() back-to-back: play lands while the instant replay is still running (or in
    // one of the gaps between its steps, where inFlight is false). Taking the advance(index + 1)
    // branch there abandoned the seek half-done and played n+1, skipping the step asked for.
    const out = path.join(work, 'seekplay-out');
    const file = writeCatalog('seekplay', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', file]).status, 0);
    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.addInitScript(() => {
            (window as any).__states = [];
            window.addEventListener('message', (e: any) => {
                if (e.data && e.data.source === 'anim-tour' && e.data.type === 'state') (window as any).__states.push({ index: e.data.index, playing: e.data.playing });
            });
        });
        await page.goto(fileUrl(path.join(out, 'scenarios', 'basic', 'index-desktop.html')));
        await page.waitForFunction(() => (window as any).__tour && (window as any).__tour.state().total === 9, null, { timeout: 15000 });
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'goto', index: 3 });
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'play' });
        // However the interleaving lands, step 3 must at some point be the one PLAYING; the bug
        // jumped straight to 4 (or re-seeked to a stale index) without ever playing 3.
        await page.waitForFunction(() => (window as any).__states.some((s: any) => s.index === 3 && s.playing), null, { timeout: 20000 });
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'pause' });
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

test('pause during a camera pan resumes by replaying the step, not skipping past it', { skip }, async () => {
    // A camera step completes through a timer __anim.stop() cannot cancel (the CSS transition
    // keeps painting to its end), so its completion resolves AFTER the pause and clears inFlight:
    // the next play used to take the advance(index + 1) branch and skip the step -- the replay
    // contract held for type steps only. pausedMidStep arms the replay whatever the completion
    // of the interrupted step does.
    const dir = path.join(work, 'pan');
    fs.cpSync(fixture, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { title: 'Pan', drift: false }, steps: [
        { id: 'open', time: 0.2, action: 'click', target: '#btn', title: 'Open' },
        { id: 'pan', time: 1.0, action: 'camera', target: '#field', scale: 1.4, duration: 2, title: 'Pan' },
        { id: 'after', time: 4.0, action: 'highlight', target: '#note', title: 'After' },
    ] }));
    const out = path.join(work, 'pan-out');
    const file = writeCatalog('pan', { outputDir: out, scenarios: [{ slug: 'pan', dir, label: 'Pan' }] });
    assert.equal(cli(['tour', file]).status, 0);
    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.addInitScript(() => {
            (window as any).__states = [];
            window.addEventListener('message', (e: any) => {
                if (e.data && e.data.source === 'anim-tour' && e.data.type === 'state') (window as any).__states.push({ index: e.data.index, playing: e.data.playing });
            });
        });
        await page.goto(fileUrl(path.join(out, 'scenarios', 'pan', 'index-desktop.html')));
        await page.waitForFunction(() => (window as any).__tour && (window as any).__tour.state().total === 3, null, { timeout: 15000 });
        // Seek to the pan and START it: goto alone plays the destination but reports playing:false
        // (only an explicit play turns the flag on), so the play is what makes the first playing
        // state exist. The second one can then only come from the resume, which is what is tested.
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'goto', index: 1 });
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'play' });
        await page.waitForFunction(() => (window as any).__states.some((s: any) => s.index === 1 && s.playing), null, { timeout: 20000 });
        // The state is emitted BEFORE the step runs, and the step's own lead (950ms) precedes the
        // interaction: pausing at ~1.5s lands after the pan has STARTED (interaction ~0.95s, pan
        // 2s) -- the window where its completion will outlive the pause and clear inFlight.
        await page.waitForTimeout(1500);
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'pause' });
        // Well past the pan's settle (lead 950ms + pan 2s from the step's start): the resume must
        // land after the completion has cleared inFlight, which is exactly the window where the
        // missing replay flag used to skip the step.
        await page.waitForTimeout(2600);
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'play' });
        await page.waitForFunction(() => (window as any).__states.filter((s: any) => s.index === 1 && s.playing).length >= 2, null, { timeout: 20000 });
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'pause' });
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

// --- embedding ---------------------------------------------------------------------------------

test('play while playing is a no-op; pause stops the in-flight step and resume replays it', { skip }, async () => {
    // A slow type step (~4s) gives a wide mid-flight window to fire the duplicate play and the
    // pause into. The duplicate play used to orphan the typing step and start the next one on top
    // of it; the pause used to leave the typing and the interaction running behind a "paused" UI.
    const dir = path.join(work, 'reentry'); fs.cpSync(fixture, dir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'anim.config.json'), 'utf8'));
    cfg.steps = [
        { id: 'fill', time: '0.2s', action: 'type', target: '#field', value: 'x'.repeat(20), cps: 5, title: 'Fill' },
        { id: 'after', time: '6s', action: 'highlight', target: '#btn', title: 'After' },
    ];
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(cfg), 'utf8');
    const out = path.join(work, 'reentry-out');
    const file = writeCatalog('reentry', { outputDir: out, scenarios: [{ slug: 'reentry', dir }] });
    const r = cli(['tour', file]);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.goto(fileUrl(path.join(out, 'scenarios', 'reentry', 'index-desktop.html')));
        await page.waitForFunction(() => (window as any).__tour && (window as any).__tour.state().total === 2, null, { timeout: 15000 });
        const send = (type: string) => page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type });
        const value = () => page.evaluate(() => (document.getElementById('field') as HTMLInputElement).value);

        await send('play');
        await page.waitForFunction(() => (document.getElementById('field') as HTMLInputElement).value.length > 0, null, { timeout: 15000 });
        // The duplicate play must not advance: the next step would start while the typing runs.
        await send('play');
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate(() => (window as any).__tour.state().index), 0, 'still on the typing step');
        assert.ok((await value()).length > 1, 'and it is still typing');

        // Pause mid-typing: the runtime's own timers stop, so the text freezes.
        await send('pause');
        await page.waitForFunction(() => (window as any).__tour.state().playing === false, null, { timeout: 5000 });
        const frozen = (await value()).length;
        assert.ok(frozen > 0 && frozen < 20, `paused mid-type at ${frozen} chars`);
        await page.waitForTimeout(900);
        assert.equal((await value()).length, frozen, 'the typing stopped, not merely the dwell timer');
        assert.equal(await page.evaluate(() => (window as any).__tour.state().playing), false);

        // Resume replays the interrupted step from its beginning rather than skipping past it.
        await send('play');
        await page.waitForFunction(() => (window as any).__tour.state().playing === true, null, { timeout: 5000 });
        await page.waitForFunction(() => (document.getElementById('field') as HTMLInputElement).value === '', null, { timeout: 5000 }).catch(() => {});
        await page.waitForFunction(() => (document.getElementById('field') as HTMLInputElement).value === 'x'.repeat(20), null, { timeout: 20000 });
        assert.equal(await page.evaluate(() => (window as any).__tour.state().index), 0, 'the interrupted step replays');
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

test('a scenario with no steps still answers: ready then end, and every command replies end', { skip }, async () => {
    // An empty timeline used to leave the protocol silent: enabled controls that do nothing,
    // forever, and an autoplaying embed whose veil never lifted.
    const dir = path.join(work, 'emptysteps'); fs.cpSync(fixture, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify({ meta: { title: 'Empty' }, steps: [] }), 'utf8');
    const out = path.join(work, 'empty-out');
    const file = writeCatalog('empty', { outputDir: out, scenarios: [{ slug: 'empty', dir }] });
    const r = cli(['tour', file]);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        await page.addInitScript(() => {
            (window as any).__msgs = [];
            window.addEventListener('message', (e: any) => { if (e.data && e.data.source === 'anim-tour') (window as any).__msgs.push(e.data); });
        });
        await page.goto(fileUrl(path.join(out, 'scenarios', 'empty', 'index-desktop.html')));
        await page.waitForFunction(() => (window as any).__msgs.some((m: any) => m.type === 'ready'), null, { timeout: 15000 });
        const endsAtBoot = await page.evaluate(() => (window as any).__msgs.filter((m: any) => m.type === 'end').length);
        assert.ok(endsAtBoot >= 1, 'an empty scenario announces its end as soon as it is ready');
        await page.evaluate((m) => window.postMessage(m, '*'), { source: 'anim-tour', type: 'play' });
        await page.waitForFunction((n) => (window as any).__msgs.filter((m: any) => m.type === 'end').length > n, endsAtBoot, { timeout: 5000 });
        await context.close();
    } finally {
        if (browser) await browser.close();
    }
});

test('a failed tours.json fetch is not cached forever: a later element retries it', { skip }, async () => {
    const out = path.join(work, 'evict-out');
    const file = writeCatalog('evict', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', file, '--embed']).status, 0);

    // The server 404s tours.json until told otherwise, and counts the attempts made by the HOST
    // page (by Referer: the embed page's own iframe fetches tours.json too, and would mask the
    // very thing under test).
    let toursJsonOk = false;
    let hostFetches = 0;
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
        if (rel === 'tours.json' && /host\.html$/.test(req.headers.referer || '')) {
            hostFetches++;
            if (!toursJsonOk) { res.writeHead(404); res.end(); return; }
        }
        const full = path.join(out, rel);
        if (!full.startsWith(out) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
        const type = full.endsWith('.js') ? 'text/javascript' : full.endsWith('.json') ? 'application/json' : 'text/html';
        res.writeHead(200, { 'content-type': type });
        res.end(fs.readFileSync(full));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html><meta charset="utf-8"><title>host</title>
<div id="one"><anim-tour src="./" scenario="basic"></anim-tour></div>
<div id="two"></div>
<script type="module" src="anim-tour.js"></script>`, 'utf8');

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
        await page.goto(`http://127.0.0.1:${port}/host.html`);
        // First element: tours.json 404s, so the manifest is null and the element falls back to the
        // wanted device. That null must not be CACHED, or the second element below never retries.
        await page.waitForFunction(() => !!document.querySelector('#one iframe')!.getAttribute('src'), null, { timeout: 15000 });
        // hostFetches is a Node-side counter (the server owns it); poll it from here rather than
        // through a page predicate, which cannot see Node closures.
        const waitHostFetches = async (n: number, ms: number) => {
            const deadline = Date.now() + ms;
            while (hostFetches < n && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
            return hostFetches;
        };
        assert.equal(await waitHostFetches(1, 15000), 1, 'the host page made exactly one attempt');

        toursJsonOk = true;
        // A NEW element for the same root must fetch the manifest again, not inherit the failure.
        await page.evaluate(() => {
            const el = document.createElement('anim-tour');
            el.setAttribute('src', './');
            el.setAttribute('scenario', 'basic');
            document.getElementById('two')!.appendChild(el);
        });
        assert.ok((await waitHostFetches(2, 15000)) >= 2, 'the new element retried the manifest');
    } finally {
        if (browser) await browser.close();
        await new Promise<void>(r => server.close(() => r()));
    }
});

test('commands sent before ready queue in order (goto then play), and an unknown scenario fires tourerror', { skip }, async () => {
    const out = path.join(work, 'queue-out');
    const file = writeCatalog('queue', { outputDir: out, scenarios: [basicScenario()] });
    assert.equal(cli(['tour', file, '--embed']).status, 0);
    const server = await serve(out);
    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
        // The element wiring lives in the PAGE (not in an evaluate callback: inner functions there
        // hit the tsx __name hazard), so __make can be called and commanded in one synchronous go
        // while the frame is still loading -- before it reports ready.
        fs.writeFileSync(path.join(out, 'host.html'), `<!doctype html><meta charset="utf-8"><title>host</title>
<div id="one"></div>
<script type="module" src="anim-tour.js"></script>
<script>
  window.__ev = [];
  window.__make = function (scenario) {
    var el = document.createElement('anim-tour');
    el.setAttribute('src', './');
    el.setAttribute('scenario', scenario);
    el.setAttribute('autoplay', 'none');
    ['tourstep', 'tourend', 'tourerror'].forEach(function (n) {
      el.addEventListener(n, function (e) { window.__ev.push({ n: n, detail: e.detail }); });
    });
    document.getElementById('one').appendChild(el);
    return el;
  };
</script>`, 'utf8');
        await page.goto(`http://127.0.0.1:${server.port}/host.html`);
        await page.waitForFunction(() => typeof (window as any).__make === 'function' && !!customElements.get('anim-tour'), null, { timeout: 15000 });
        // goto(1) then play(), both before the frame reports ready: a single-slot queue used to
        // lose the goto to last-write-wins and play from step 0.
        await page.evaluate(() => { const el = (window as any).__make('basic'); el.goto(1); el.play(); });
        await page.waitForFunction(() => (window as any).__ev.some((e: any) => e.n === 'tourstep'), null, { timeout: 20000 });
        const first = await page.evaluate(() => (window as any).__ev.find((e: any) => e.n === 'tourstep'));
        assert.equal(first.detail.index, 1, 'the queued goto landed before the play, so playback starts at step 1');

        // An unknown scenario is a misconfiguration that must surface, not a silent 404 frame.
        await page.evaluate(() => { (window as any).__make('draft-responce'); });   // typo
        await page.waitForFunction(() => (window as any).__ev.some((e: any) => e.n === 'tourerror'), null, { timeout: 15000 });
        const err = await page.evaluate(() => (window as any).__ev.find((e: any) => e.n === 'tourerror'));
        assert.match(err.detail.message, /is not in .*tours\.json/);
    } finally {
        if (browser) await browser.close();
        await server.close();
    }
});

test('Space activates a focused rail card instead of hijacking playback; a play clicked during load is not lost', { skip }, async () => {
    const out = path.join(work, 'shell-out');
    const other = path.join(work, 'shell2'); fs.cpSync(fixture, other, { recursive: true });
    const file = writeCatalog('shell', { outputDir: out, scenarios: [basicScenario(), { slug: 'second', dir: other, label: 'Second' }] });
    assert.equal(cli(['tour', file]).status, 0);

    // The scenario page loads slowly (500ms), so the big play button is clickable while the frame
    // is still loading: the click must queue rather than be posted into a document with no listener.
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
        const full = path.join(out, rel);
        if (!full.startsWith(out) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end(); return; }
        const type = full.endsWith('.js') ? 'text/javascript' : full.endsWith('.css') ? 'text/css' : full.endsWith('.json') ? 'application/json' : 'text/html';
        setTimeout(() => { res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(full)); }, rel.startsWith('scenarios/') ? 500 : 0);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    let browser: Browser | undefined;
    try {
        browser = await chromium.launch({ headless: true });
        const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
        await page.goto(`http://127.0.0.1:${port}/index.html`);
        // While the (slow) scenario iframe is still loading, click the big play button once.
        await page.waitForSelector('#play-big');
        await page.click('#play-big');
        await page.waitForFunction(() => document.body.classList.contains('is-playing'), null, { timeout: 20000 });
        await page.click('#btn-play');   // pause, so the Space assertion below starts from a stopped tour
        await page.waitForFunction(() => !document.body.classList.contains('is-playing'), null, { timeout: 10000 });

        // Space on a focused rail card activates the card; it must not toggle tour playback.
        await page.focus('.card[data-slug="second"]');
        const before = await page.evaluate(() => location.hash);
        await page.keyboard.press('Space');
        await page.waitForFunction(() => location.hash === '#second', null, { timeout: 10000 });
        assert.notEqual(before, '#second', 'the card was selected by Space');
        assert.equal(await page.evaluate(() => document.body.classList.contains('is-playing')), false, 'and the tour did not start playing behind it');
    } finally {
        if (browser) await browser.close();
        await new Promise<void>(r => server.close(() => r()));
    }
});

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
