import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { readFilesUnder, stripComments, SourceFile } from './scan-source';

/**
 * Canary for « Every spawnSync/execFileSync in src/ has a timeout » (docs/testing-discipline.md,
 * invariant inventory). A sync child blocks the event loop: no timer in this process and no
 * watchdog above it can end a wedged one, so the bound has to sit on the call itself -- which is
 * what the three identities say where they are declared (src/media/ffmpeg.ts:15 for
 * FFMPEG_TIMEOUT_MS at :21, src/media/tts.ts:54 for SAY_TIMEOUT_MS at :56, src/reset.ts:3 for
 * RESET_TIMEOUT_MS at :4).
 *
 * Discovery walks src/ recursively through the shared reader (test/scan-source.ts): *.ts only --
 * the two injected .js files launch nothing -- comment-stripped, and keyed on the open paren of
 * /\bspawnSync\(|\bexecFileSync\(/, so the prose mentions ("the test suite's spawnSync)" at
 * src/browser.ts:129, "execFileSync blocks" at src/media/tts.ts:55) classify as nothing even
 * unstripped. The scope is exactly the two APIs the rule names: the async runCli child belongs to
 * a different inventory row (its CHILD_TIMEOUT_MS is a setTimeout beside the spawn, which a
 * timeout-option scan cannot see), and the runner's own children are test/'s rows, not src/'s.
 *
 * The window is a RATCHET, not a tolerance: the opener line plus the 2 following lines, measured
 * against the code as it stands -- all three sites carry `timeout:` on the opener line (ffmpeg
 * :25, tts :61, reset :36). A legitimate reflow that pushes a real `timeout:` past the window
 * reds this canary on purpose: fold the option back up, or widen WINDOW_LINES as a documented
 * decision (rule 8) -- the red reads as designed, not as flake.
 *
 * The oracle wants a SCREAMING_SNAKE constant, never a literal (the sibling's «a literal instead
 * of the constant goes red» rule, spawn-bounds.test.ts:145): the exact numbers stay identities in
 * the sources, not magic numbers here. A 4th sync child goes red twice -- once on the oracle
 * until it carries the bound, once on the identity until it joins KNOWN_SITES.
 *
 * The planted snippets assemble their openers at runtime by concatenation (the
 * spawn-bounds.test.ts:30-34 precedent), so this file's own text never carries a call site.
 */

const root = path.resolve(__dirname, '..');
const SRC_DIR = path.join(root, 'src');

// An opener is one of the two sync child APIs named with an open paren: the paren is what keeps
// the prose mentions (browser.ts:129) and the `import { spawnSync } from 'child_process'` lines
// out of discovery.
const SYNC_CHILD_OPENER = /\bspawnSync\(|\bexecFileSync\(/;
// The window: the opener line plus the 2 following lines. All three known sites carry the option
// on the opener line; the +2 covers a wrapped options object (see the header: a ratchet).
const WINDOW_LINES = 3;
// A named constant, never a literal: `timeout: 10000` is the bug class the sibling canary names.
const TIMEOUT_CONSTANT = /timeout:\s*[A-Z][A-Z0-9_]+/;

// The 3 sync-child sites in src/, in discovery order (line order over the reader's sorted walk):
// spawnSync at media/ffmpeg.ts:25, execFileSync at media/tts.ts:61, spawnSync at reset.ts:36. A
// 4th sync child must carry `timeout: A_CONSTANT` and join this list (rule 8 to widen).
const KNOWN_SITES = ['media/ffmpeg.ts', 'media/tts.ts', 'reset.ts'];

// Planted-snippet openers, assembled so this file's own text never contains a raw call site.
const SPAWN_SYNC_NAME = ['spawn', 'Sync'].join('');
const EXEC_FILE_SYNC_NAME = ['exec', 'File', 'Sync'].join('');
const SPAWN_SYNC = `${SPAWN_SYNC_NAME}(`;
const EXEC_FILE_SYNC = `${EXEC_FILE_SYNC_NAME}(`;

type Site = { file: string; line: number; window: string };

/** Sync-child sites in one file's comment-stripped text, in line order. The strip keeps length and
 *  newlines, so `line` is the real file's line and the failure messages quote it as file:line. */
function syncChildSites(file: SourceFile): Site[] {
    const lines = stripComments(file.text).split('\n');
    const sites: Site[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!SYNC_CHILD_OPENER.test(lines[i])) continue;
        sites.push({ file: file.name, line: i + 1, window: lines.slice(i, i + WINDOW_LINES).join('\n') });
    }
    return sites;
}

function discover(files: SourceFile[]): Site[] {
    return files.flatMap(syncChildSites);
}

/** The one bound, and two distinct ways to miss it: a literal is a different mistake from a
 *  missing option, so the two failures are named apart. */
function timeoutProblems(site: Site): string[] {
    if (TIMEOUT_CONSTANT.test(site.window)) return [];
    const which = /timeout:/.test(site.window)
        ? 'the timeout is a literal, not a SCREAMING_SNAKE_CONSTANT'
        : 'no "timeout: A_SCREAMING_SNAKE_CONSTANT" in the sync child\'s window';
    return [`${site.file}:${site.line}: ${which}`];
}

test('every spawnSync/execFileSync in src/ carries a timeout constant', () => {
    const sites = discover(readFilesUnder(SRC_DIR));
    assert.ok(sites.length >= 1, 'discovery found no sync child in src/ -- the walk or the opener regex broke');
    assert.deepEqual(sites.map(s => s.file), KNOWN_SITES, 'the sync-child sites in src/ changed: bound the new site with a timeout constant and extend KNOWN_SITES');
    assert.deepEqual(sites.flatMap(timeoutProblems), [], 'a sync child in src/ is missing its timeout bound');
});

test('self-test: an empty discovery fails instead of passing vacuously', () => {
    assert.throws(() => {
        // A renamed walk or a broken extension filter scans zero files; the identity assert must go red.
        const sites = discover([]);
        assert.ok(sites.length >= 1, 'discovery found no sync child in src/ -- the walk or the opener regex broke');
        assert.deepEqual(sites.map(s => s.file), KNOWN_SITES);
    }, /discovery found no sync child in src\//);
});

test('self-test: a planted sync child is discovered clean; the broken shapes go red by name', () => {
    const sitesOf = (lines: string[]) => discover([{ name: 'planted.ts', text: lines.join('\n') }]);

    const clean = sitesOf([`const r = ${SPAWN_SYNC}cmd, { shell: true, timeout: RESET_TIMEOUT_MS });`]);
    assert.deepEqual(clean.map(s => [s.file, s.line]), [['planted.ts', 1]], 'a planted sync child is discovered');
    assert.deepEqual(clean.flatMap(timeoutProblems), [], 'the planted site carries its timeout constant');

    const literal = sitesOf([`const r = ${SPAWN_SYNC}cmd, { shell: true, timeout: 120000 });`]);
    assert.equal(literal.length, 1, 'the literal snippet is itself discovered');
    assert.match(literal.flatMap(timeoutProblems)[0], /literal/, 'a literal instead of the constant goes red');

    const unbounded = sitesOf([
        `const r = ${SPAWN_SYNC}cmd, { shell: true, stdio: 'inherit' });`,
        'if (r.error) throw r.error;',
    ]);
    assert.match(unbounded.flatMap(timeoutProblems)[0], /no "timeout/, 'a dropped timeout goes red');

    // The other opener shape, with the options folded onto the next line: still inside the window.
    const folded = sitesOf([
        `const spoken = ${EXEC_FILE_SYNC}'say', args,`,
        '    { input: text, timeout: SAY_TIMEOUT_MS });',
    ]);
    assert.deepEqual(folded.map(s => s.line), [1], 'the execFileSync opener shape is discovered');
    assert.deepEqual(folded.flatMap(timeoutProblems), [], 'a timeout folded to the next line stays inside the 3-line window');
});

test('self-test: a commented-out call and a paren-less mention classify as nothing', () => {
    // The two false positives this canary must not raise: a call retired into a comment (the
    // stripper blanks it) and a prose mention with no open paren -- planted here inside a string
    // literal, which the stripper keeps verbatim, so the paren requirement alone decides it
    // (browser.ts:129).
    const commented = [
        `// retired: ${SPAWN_SYNC}cmd, { timeout: OLD_TIMEOUT_MS });`,
        `/* ${EXEC_FILE_SYNC}'say', args, { timeout: SAY_TIMEOUT_MS }); was here */`,
        'const plain = 1;',
    ].join('\n');
    assert.deepEqual(discover([{ name: 'commented.ts', text: commented }]), [], 'a call inside a comment must not classify (stripComments works)');

    const mention = `const doc = 'the docs say a ${SPAWN_SYNC_NAME}) call blocks the event loop';`;
    assert.deepEqual(discover([{ name: 'mention.ts', text: mention }]), [], 'a mention without an open paren must not classify');
});
