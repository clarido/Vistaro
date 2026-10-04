import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLI_TIMEOUT_MS } from './assert-ran';
import { readFilesUnder } from './scan-source';

/**
 * Canary for the src/ row of « Nothing in a run may wait forever » (docs/testing-discipline.md):
 * every async child `spawn` in src/ whose window names cli.ts carries the CHILD_TIMEOUT_MS insist
 * block -- 15 minutes, SIGTERM, then SIGKILL after a 10 s grace. The bound is NOT a `timeout`
 * option: it is a setTimeout BESIDE the spawn, which is exactly why the sync-scan canary
 * (spawnSync/execFileSync) is structurally blind to this spawn and this canary exists.
 *
 * Discovery reads every .ts under src/, recursively, as text (test/scan-source.ts) and keys a
 * site on the runner canary's own opener regex (spawn-bounds.test.ts:25): a bare spawn opener.
 * The token is written open-form throughout this comment on purpose: the runner canary scans
 * this file's own text too, and a literal opener within its three-line window of the cli.ts
 * mention a few lines down reads as a child launch. The sync form never matches (the paren must
 * follow "spawn" directly) and neither does a member call like child.spawn (the lookbehind).
 * Only sites whose window names `cli.ts` count: runCli launches the CLI
 * (src/commands/build-all.ts:88); ffmpeg and sox children never carry that token.
 *
 * The scope is TRACKED src/ files only (git ls-files): an untracked file under src/ is another
 * session's in-flight lot, not a landed violation for this canary to gate. When such a lot lands,
 * its spawn must carry the insist block and join KNOWN_SITES (rule 8 for the list).
 *
 * THE WINDOW IS A RATCHET, NOT A TOLERANCE: opener + 20 lines was measured against the code as it
 * stands -- the insist block sits 8 to 15 lines below the opener (build-all.ts:96-103, opener
 * :88). A legitimate reflow that pushes the block beyond the window reds this canary on purpose;
 * move the block back beside the spawn, or revisit the ratchet deliberately (rule 8) -- it must
 * not read as flake.
 *
 * The two constants are asserted as VERBATIM file declarations because the doc's numbers ("15
 * min, SIGTERM then SIGKILL after a 10 s grace") are identities of this code, not parameters:
 * retuning either number must come through here and say so. The window oracle pins
 * CHILD_TIMEOUT_MS in the setTimeout's delay position, not as a bare token -- the timeout message
 * interpolates the same constant, so a token-only check stays green on a child whose delay was
 * retuned away (found by the mutation proof; see the retuned-delay self-test).
 *
 * Extending KNOWN_SITES (a second async CLI child in src/) needs the insist block on the new site
 * AND JF's explicit go -- the site list is an allowlist, not a convenience (rule 8).
 */

const root = path.resolve(__dirname, '..');

// spawn-bounds.test.ts:25's async half. `spawning(` never matches (an open paren must follow).
const SPAWN_OPENER = /(?<![.\w])spawn\(/;
// The opener line plus the 20 following lines (see the ratchet note in the header).
const WINDOW_LINES = 21;

const DISCOVERY_MESSAGE = 'discovery found no async CLI spawn in src/ -- the glob or the opener regex broke';

type SourceFile = { name: string; text: string };
type Site = { file: string; line: number; window: string; fileText: string };

/** Async-spawn sites in one file's text whose window names cli.ts, in line order. */
function asyncCliSpawnSites(file: SourceFile): Site[] {
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

function discover(files: SourceFile[]): Site[] {
    return files.flatMap(asyncCliSpawnSites);
}

/** The discovery scope: tracked src/ files only, as src/-relative names. git ls-files, bounded
 *  like every child this suite launches; a git failure throws and fails the run by name. */
function trackedSrcFiles(): SourceFile[] {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    return out.split('\0')
        .filter(f => /\.ts$/.test(f))
        .sort()
        .map(name => ({ name: name.replace(/^src\//, ''), text: fs.readFileSync(path.join(root, name), 'utf8') }));
}

/** The insist block, inside the spawn's window: the setTimeout beside the spawn, the constant it
 *  fires on -- in the DELAY POSITION, not merely mentioned (the timeout message interpolates the
 *  same constant, so a bare-token check alone is satisfied by a child whose delay was retuned to
 *  0 or inlined) -- and the soft kill and the hard one. */
function windowProblems(site: Site): string[] {
    const problems: string[] = [];
    if (!/setTimeout\(/.test(site.window)) problems.push(`no "setTimeout(...)" beside the spawn`);
    if (!site.window.includes('CHILD_TIMEOUT_MS')) problems.push(`no CHILD_TIMEOUT_MS in the spawn's window`);
    if (!/,\s*CHILD_TIMEOUT_MS\s*\)\s*;/.test(site.window)) problems.push(`CHILD_TIMEOUT_MS is not the setTimeout's delay in the spawn's window`);
    if (!site.window.includes(`child.kill('SIGTERM')`)) problems.push(`no "child.kill('SIGTERM')" soft kill in the spawn's window`);
    if (!site.window.includes('SIGKILL')) problems.push(`no SIGKILL hard kill in the spawn's window`);
    return problems;
}

/** The two constants, verbatim, at file scope: the doc's numbers as exact identities. */
function constantProblems(site: Site): string[] {
    const problems: string[] = [];
    if (!site.fileText.includes('const CHILD_TIMEOUT_MS = 15 * 60 * 1000')) problems.push(`the file does not declare "const CHILD_TIMEOUT_MS = 15 * 60 * 1000" verbatim`);
    if (!site.fileText.includes('const CHILD_KILL_GRACE_MS = 10000')) problems.push(`the file does not declare "const CHILD_KILL_GRACE_MS = 10000" verbatim`);
    return problems;
}

function siteProblems(site: Site): string[] {
    return [...windowProblems(site), ...constantProblems(site)].map(p => `${site.file}:${site.line}: ${p}`);
}

// The one known async CLI child spawn in tracked src/: runCli (build-all.ts:88). A new one must
// carry the insist block and join this list -- and extending this allowlist is a documented
// decision of JF's, not a test edit (docs/testing-discipline.md rule 8).
const KNOWN_SITES = ['commands/build-all.ts'];

test('every async child spawn in src/ whose window names cli.ts carries the CHILD_TIMEOUT_MS insist block', () => {
    const sites = discover(trackedSrcFiles());
    assert.ok(sites.length >= 1, DISCOVERY_MESSAGE);
    assert.deepEqual(sites.map(s => s.file), KNOWN_SITES, 'the async CLI spawn sites of src/ changed: carry the insist block on the new site, then extend KNOWN_SITES with JF\'s go (rule 8)');
    assert.deepEqual(sites.flatMap(siteProblems), [], 'an async CLI spawn is missing part of the CHILD_TIMEOUT_MS insist block');
});

// The planted snippets assemble their call openers at runtime by concatenation (the
// spawn-bounds.test.ts:30-34 precedent), so this file's own text never contains a bare spawn
// opener and a scanning canary never classifies its own snippets.

const SPAWN_OPEN = ['spawn', '('].join('');

const PLANTED_LINES = [
    `const CHILD_TIMEOUT_MS = 15 * 60 * 1000;`,
    `const CHILD_KILL_GRACE_MS = 10000;`,
    `function runCli(args: string[]): Promise<StepRun> {`,
    `    return new Promise((resolve) => {`,
    `        const child = ${SPAWN_OPEN}process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd });`,
    `        let stdout = '';`,
    `        let timedOut = false;`,
    `        let hard: NodeJS.Timeout | undefined;`,
    `        const insist = setTimeout(() => {`,
    `            timedOut = true;`,
    `            child.kill('SIGTERM');`,
    `            hard = setTimeout(() => child.kill('SIGKILL'), CHILD_KILL_GRACE_MS);`,
    `        }, CHILD_TIMEOUT_MS);`,
    `        insist.unref();`,
    `    });`,
    `}`,
];
const PLANTED_CLEAN = PLANTED_LINES.join('\n');
// The insist block is 1-based lines 8-14: dropped whole, declarations kept, so only the window
// oracle can red on this variant.
const PLANTED_WITHOUT_INSIST = [...PLANTED_LINES.slice(0, 7), ...PLANTED_LINES.slice(14)].join('\n');

test('self-test: a planted async CLI spawn carrying the insist block is discovered and clean', () => {
    const sites = discover([{ name: 'commands/planted.ts', text: PLANTED_CLEAN }]);
    assert.deepEqual(sites.map(s => [s.file, s.line]), [['commands/planted.ts', 5]], 'the planted site is discovered at its opener line');
    assert.deepEqual(windowProblems(sites[0]), [], 'the planted insist block satisfies the window oracle');
    assert.deepEqual(constantProblems(sites[0]), [], 'the planted declarations satisfy the file oracle');
});

test('self-test: the same spawn without the insist block reds the window oracle', () => {
    const sites = discover([{ name: 'commands/planted.ts', text: PLANTED_WITHOUT_INSIST }]);
    assert.equal(sites.length, 1, 'the spawn itself is still discovered without the block');
    const problems = windowProblems(sites[0]).join('\n');
    assert.match(problems, /setTimeout\(/, 'a missing setTimeout reds');
    assert.match(problems, /CHILD_TIMEOUT_MS/, 'no CHILD_TIMEOUT_MS in the window reds');
    assert.match(problems, /SIGTERM/, 'a missing soft kill reds');
    assert.match(problems, /SIGKILL/, 'a missing hard kill reds');
});

test('self-test: a retuned delay that keeps the token alive in the log message still reds', () => {
    // The mutation-proof shape: the delay is no longer the constant, but the timeout message still
    // interpolates it, so a bare-token window check alone would stay green on an unbounded child.
    const planted = PLANTED_LINES.map(l => l.replace('}, CHILD_TIMEOUT_MS);', '}, 0);')).join('\n');
    const sites = discover([{ name: 'commands/planted.ts', text: planted }]);
    assert.equal(sites.length, 1, 'the planted site is still discovered');
    const problems = windowProblems(sites[0]).join('\n');
    assert.match(problems, /CHILD_TIMEOUT_MS is not the setTimeout's delay/, 'a delay that is not the constant reds');
    assert.equal(siteProblems(sites[0]).filter(p => /setTimeout|SIGTERM|SIGKILL/.test(p)).length, 1, 'the delay slot is the only thing that broke');
});

test('self-test: a member call (child.spawn) and a printed mention never open a site', () => {
    // The lookbehind: `child.spawn(` is a member call, not an opener -- even with cli.ts in the
    // would-be window, so a wrongly matching regex would discover this and fail the assert.
    const memberCall = [
        `const runner = { child };`,
        `const child = runner.child.${SPAWN_OPEN}process.execPath, ['--import', 'tsx', 'cli.ts'], { cwd });`,
        `child.unref();`,
    ].join('\n');
    assert.deepEqual(discover([{ name: 'commands/member.ts', text: memberCall }]), [], 'a member call is not a spawn opener');

    // src/ prints `npx tsx cli.ts ...` hints (init-config, build, localize): no opener, no site,
    // however loudly the window names cli.ts.
    const printMention = [
        `function next(dir: string): void {`,
        `    console.log('  npx tsx cli.ts check ' + dir);`,
        `}`,
    ].join('\n');
    assert.deepEqual(discover([{ name: 'printer.ts', text: printMention }]), [], 'a printed cli.ts mention is not a spawn');
});

test('self-test: a site whose file lacks the verbatim constant declarations reds the file oracle', () => {
    // The insist block is present (the window oracle is clean); only the declarations are gone.
    const planted = PLANTED_CLEAN.split('\n').filter(l => !/^const CHILD_/.test(l)).join('\n');
    const sites = discover([{ name: 'commands/planted.ts', text: planted }]);
    assert.equal(sites.length, 1, 'the planted site is still discovered');
    assert.deepEqual(windowProblems(sites[0]), [], 'the window oracle stays clean -- the file oracle is the one that reds');
    const problems = constantProblems(sites[0]).join('\n');
    assert.match(problems, /const CHILD_TIMEOUT_MS = 15 \* 60 \* 1000/, 'a retuned or deleted CHILD_TIMEOUT_MS declaration reds');
    assert.match(problems, /const CHILD_KILL_GRACE_MS = 10000/, 'a retuned or deleted CHILD_KILL_GRACE_MS declaration reds');
});

test('self-test: an empty src/ glob fails instead of passing vacuously', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'src-async-spawn-bound-'));
    try {
        assert.deepEqual(readFilesUnder(empty), [], 'an empty tree scans to nothing');
        assert.throws(() => {
            // A renamed directory or a broken filter scans zero files; the identity assert must
            // go red, naming itself.
            const sites = discover(readFilesUnder(empty));
            assert.ok(sites.length >= 1, DISCOVERY_MESSAGE);
            assert.deepEqual(sites.map(s => s.file), KNOWN_SITES);
        }, /discovery found no async CLI spawn/);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});
