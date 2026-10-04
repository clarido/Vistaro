import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Canary for the « Nothing in a run may wait forever » rule (docs/testing-discipline.md): every
 * child the suite launches for the CLI carries three bounds -- a `timeout: CLI_TIMEOUT_MS` option,
 * a `killSignal: 'SIGKILL'` option, and an `assertRan()` call in the owning file -- so a wedged
 * child is reported by name instead of as "expected null to equal 0".
 *
 * Discovery reads the runner's own glob scope, top-level test/*.test.ts (package.json), as text --
 * no recursion into test/fixtures/, which spawns nothing -- and keys a CLI child on the one token
 * every CLI command carries in its spawn window (`cli.ts`, bare or via path.join(root, 'cli.ts'))
 * and no other child does: the six ffmpeg probes, the node -e probe in guide.test.ts and the saas
 * shim text in saas-queue.test.ts all lack it in their window. A 13th CLI spawn goes red until its
 * author adds the three bounds and extends KNOWN_SITES; a rename that scans zero files fails the
 * identity assert instead of passing vacuously.
 */

const root = path.resolve(__dirname, '..');

// An opener is a spawnSync call, or a bare spawn call (the lookbehind skips member calls like
// child.spawn); 'spawnCommand' and 'spawning' never match because an open paren must follow.
const SPAWN_OPENER = /\bspawnSync\(|(?<![.\w])spawn\(/;
// The window: the opener line plus the 2 following lines, guarding against wrapped options. All
// known sites carry args and options on the opener line already.
const WINDOW_LINES = 3;

// The planted snippets of the self-tests assemble their call openers at runtime by concatenation,
// so this file's own text never contains one: the canary scans itself too (it is inside the glob)
// and must classify as nothing, like every other non-spawning file.
const SYNC_OPEN = ['spawn', 'Sync('].join('');
const ASYNC_OPEN = ['spawn', '('].join('');

type SourceFile = { name: string; text: string };
type Site = { file: string; line: number; window: string; fileText: string };

/** CLI-spawn sites in one file's text, in line order. */
function cliSpawnSites(file: SourceFile): Site[] {
    const lines = file.text.split('\n');
    const sites: Site[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!SPAWN_OPENER.test(lines[i])) continue;
        const window = lines.slice(i, i + WINDOW_LINES).join('\n');
        if (!window.includes('cli.ts')) continue;
        sites.push({ file: file.name, line: i + 1, window, fileText: file.text });
    }
    return sites;
}

/** The three bounds on one site. Bound 3 is checked at file scope: each of the files here owns
 *  exactly one CLI helper, and the async helpers call assertRan after awaiting, never in 'close'. */
function boundsProblems(site: Site): string[] {
    const problems: string[] = [];
    if (!/timeout:\s*CLI_TIMEOUT_MS/.test(site.window)) problems.push(`no "timeout: CLI_TIMEOUT_MS" in the spawn's window`);
    if (!/killSignal:\s*['"]SIGKILL['"]/.test(site.window)) problems.push(`no "killSignal: 'SIGKILL'" in the spawn's window`);
    if (!site.fileText.includes('assertRan(')) problems.push(`the owning file never calls assertRan(`);
    return problems.map(p => `${site.file}:${site.line}: ${p}`);
}

/** The runner's glob, as text: every top-level *.test.ts sibling of this canary, sorted. */
function readRunnerGlob(dir: string): SourceFile[] {
    return fs.readdirSync(dir)
        .filter(f => /\.test\.ts$/.test(f))
        .sort()
        .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

function discover(files: SourceFile[]): Site[] {
    return files.flatMap(cliSpawnSites);
}

/** The 12 known CLI spawn sites, sorted; buildall.test.ts twice (its sync cli and its async
 *  cliAsync). A 13th CLI spawn must join this list -- after carrying the three bounds. */
const KNOWN_SITES = [
    'browser.test.ts', 'buildall.test.ts', 'buildall.test.ts', 'export.test.ts', 'filmstrip.test.ts',
    'guide.test.ts', 'learn.test.ts', 'record.test.ts', 'strings.test.ts', 'studio.test.ts', 'tour.test.ts', 'verify.test.ts',
];

test('every CLI spawn in test/ carries the three bounds: timeout, killSignal, assertRan', () => {
    const sites = discover(readRunnerGlob(__dirname));
    assert.ok(sites.length >= 1, 'discovery found no CLI spawn in test/ -- the glob or the opener regex broke');
    assert.deepEqual(sites.map(s => s.file), KNOWN_SITES, 'the CLI spawn sites changed: carry the three bounds on the new site and extend KNOWN_SITES');
    assert.deepEqual(sites.flatMap(boundsProblems), [], 'a CLI spawn is missing a bound');
});

test('self-test: discovery finds a planted CLI child (both opener shapes)', () => {
    const plantedSync = [
        `const res = ${SYNC_OPEN}process.execPath, ['--import', 'tsx', 'cli.ts', ...args],`,
        `    { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });`,
        `assertRan(res, args);`,
    ].join('\n');
    const syncSites = discover([{ name: 'planted.test.ts', text: plantedSync }]);
    assert.deepEqual(syncSites.map(s => [s.file, s.line]), [['planted.test.ts', 1]], 'a planted sync CLI child is discovered');
    assert.deepEqual(boundsProblems(syncSites[0]), [], 'the planted site carries all three bounds');

    const plantedAsync = [
        `const child = ${ASYNC_OPEN}process.execPath, ['--import', 'tsx', 'cli.ts', ...args],`,
        `    { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });`,
        `assertRan(res, args);`,
    ].join('\n');
    assert.equal(discover([{ name: 'planted.test.ts', text: plantedAsync }]).length, 1, 'a planted async CLI child is discovered');
});

test('self-test: the known non-CLI children classify as nothing', () => {
    // An ffmpeg probe: bounded in its own right, never a CLI child.
    const ffmpegProbe = [
        `const res = ${SYNC_OPEN}require('ffmpeg-static'), ['-i', file, '-vf', 'crop', '-'],`,
        `    { maxBuffer: 64 * 1024 * 1024, timeout: FFMPEG_PROBE_TIMEOUT_MS });`,
    ].join('\n');
    // The node -e probe (guide.test.ts): process.execPath, both spawn options, but no cli.ts.
    const nodeProbe = [
        `const cueCount = ${SYNC_OPEN}process.execPath, ['-e', 'process.stdout.write("2")', guideFile],`,
        `    { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });`,
        `assert.equal(parseInt(cueCount.stdout.trim(), 10) >= 2, true);`,
    ].join('\n');
    // The saas shim text (saas-queue.test.ts): cli.ts in the file, no child launch in any window.
    const shimText = [
        `const shimSource = 'npx tsx cli.ts export --force';`,
        `assert.match(shimSource, /npx tsx cli/);`,
    ].join('\n');
    for (const [name, text] of [['ffmpeg-probe.test.ts', ffmpegProbe], ['node-probe.test.ts', nodeProbe], ['shim-text.test.ts', shimText]] as const) {
        assert.deepEqual(discover([{ name, text }]), [], `${name} must not classify as a CLI spawn:\n${text}`);
    }
});

test('self-test: an empty glob fails instead of passing vacuously', () => {
    assert.throws(() => {
        // A renamed glob or a broken filter scans zero files; the identity assert must go red.
        const sites = discover([]);
        assert.ok(sites.length >= 1, 'discovery found no CLI spawn in test/ -- the glob or the opener regex broke');
        assert.deepEqual(sites.map(s => s.file), KNOWN_SITES);
    }, /discovery found no CLI spawn/);
});

test('self-test: the bounds oracle fails when any one bound is missing and passes on the complete shape', () => {
    const problemsOf = (lines: string[]) => {
        const sites = discover([{ name: 'probe.test.ts', text: lines.join('\n') }]);
        assert.equal(sites.length, 1, 'the probe snippet itself must be discovered');
        return boundsProblems(sites[0]);
    };
    const opener = `const res = ${SYNC_OPEN}process.execPath, ['--import', 'tsx', 'cli.ts', ...args],`;
    assert.deepEqual(problemsOf([opener, `    { timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });`, `assertRan(res, args);`]), [], 'the complete shape passes');
    assert.match(problemsOf([opener, `    { timeout: 300000, killSignal: 'SIGKILL' });`, `assertRan(res, args);`])[0], /timeout: CLI_TIMEOUT_MS/, 'a literal instead of the constant goes red');
    assert.match(problemsOf([opener, `    { timeout: CLI_TIMEOUT_MS });`, `assertRan(res, args);`])[0], /killSignal: 'SIGKILL'/, 'a dropped killSignal goes red');
    assert.match(problemsOf([opener, `    { timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });`, `return res;`])[0], /assertRan/, 'a deleted assertRan call goes red');
});
