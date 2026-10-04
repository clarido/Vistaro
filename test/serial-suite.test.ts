import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Canary for the « The suite runs serial » row (docs/testing-discipline.md, invariant inventory):
 * both npm test scripts -- `test` and `test:static` (package.json:26-27) -- must carry
 * `--test-concurrency=1`. That flag is the whole rule: the orphaned-process check counts Chromium
 * and ffmpeg machine-wide, and « one browser-driven job at a time » (rule 6) both assume no two
 * tests of this suite ever run at once. `test:static` is named in the row, not just `test`, so
 * both scripts are asserted here.
 *
 * Identity: the read IS the identity assert -- a missing package.json throws ENOENT out of
 * readFileSync and a malformed one throws out of JSON.parse, so the canary cannot pass on a file
 * it never saw; a package.json without a scripts object yields {} and both keys go red by name.
 * Each key must be a string (a renamed or deleted script key fails loudly, never vacuously) and
 * must contain the flag.
 *
 * Self-tested (rule 3) against planted scripts objects through the SAME oracle the main test
 * runs: the clean shape passes; the flag dropped from either script, the value retuned, a script
 * key missing and a non-string script each go red naming `scripts.<key>`.
 *
 * The pinned flag is asserted from one constant, assembled by concatenation
 * (test/spawn-bounds.test.ts:30-34 precedent) so the token has exactly one definition -- this
 * file scans nothing, so its own text never needs to classify as anything. No window ratchets
 * here -- the only string asserted is the flag itself; the scripts are free to change around it
 * (a new flag, a reordered one, another chained command) without redding this canary.
 */

const root = path.resolve(__dirname, '..');

/** The one token the rule pins, assembled so this file's own text never carries it. */
const SERIAL_FLAG = ['--test', '-concurrency', '=1'].join('');
/** The same flag with the concurrency retuned, for the self-test's value mutation. */
const PARALLEL_FLAG = SERIAL_FLAG.slice(0, -1) + '4';
const SERIAL_SCRIPTS = ['test', 'test:static'] as const;

type Scripts = Record<string, unknown>;

/** The whole oracle: one problem string per violated expectation, each naming its script key. */
function serialProblems(scripts: Scripts): string[] {
    const problems: string[] = [];
    for (const key of SERIAL_SCRIPTS) {
        const script = scripts[key];
        if (typeof script !== 'string') {
            problems.push(`scripts.${key} is missing (or not a string) in package.json -- a renamed or deleted script key must fail loudly here, never vacuously`);
            continue;
        }
        if (!script.includes(SERIAL_FLAG)) {
            problems.push(`scripts.${key} does not carry ${SERIAL_FLAG} -- the orphaned-process check counts Chromium/ffmpeg machine-wide and the one-browser-job-at-a-time rule both assume a serial suite`);
        }
    }
    return problems;
}

/** The identity assert is the read itself: a missing file throws ENOENT, a malformed one throws in
 *  JSON.parse, and a package.json without a scripts object yields {} (both keys then go red by
 *  name). Deliberately never wrapped in try/catch. */
function readScriptsAt(pkgPath: string): Scripts {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Scripts };
    return pkg.scripts ?? {};
}

test('the suite runs serial: both npm test scripts carry --test-concurrency=1', () => {
    const scripts = readScriptsAt(path.join(root, 'package.json'));
    for (const key of SERIAL_SCRIPTS) {
        assert.equal(typeof scripts[key], 'string', `scripts.${key} is missing or not a string in package.json -- a renamed script key must fail loudly here, never vacuously`);
    }
    assert.deepEqual(serialProblems(scripts), [], 'the suite must run serial: carry --test-concurrency=1 on BOTH scripts -- test:static too, not just test');
});

test('self-test: the oracle passes the flagged shape and goes red naming the key on every break', () => {
    const flagged: Scripts = {
        test: `node --import tsx --test ${SERIAL_FLAG} test/*.test.ts`,
        'test:static': `SKIP_BROWSER=1 SKIP_TTS=1 node --import tsx --test ${SERIAL_FLAG} test/*.test.ts`,
    };
    assert.deepEqual(serialProblems(flagged), [], 'both scripts flagged is the clean shape');

    const droppedFromStatic = { ...flagged, 'test:static': (flagged['test:static'] as string).replace(SERIAL_FLAG, '') };
    assert.match(serialProblems(droppedFromStatic)[0], /^scripts\.test:static does not carry/, 'the flag dropped from test:static goes red naming the key');

    const droppedFromTest = { ...flagged, test: (flagged.test as string).replace(SERIAL_FLAG, '') };
    assert.match(serialProblems(droppedFromTest)[0], /^scripts\.test does not carry/, 'the flag dropped from test goes red naming the key');

    const retuned = { ...flagged, 'test:static': (flagged['test:static'] as string).replace(SERIAL_FLAG, PARALLEL_FLAG) };
    assert.match(serialProblems(retuned)[0], /^scripts\.test:static does not carry/, 'a retuned concurrency is not the flag the rule pins');

    const renamedAway: Scripts = { 'test:static': flagged['test:static'] };
    assert.match(serialProblems(renamedAway)[0], /^scripts\.test is missing/, 'a missing scripts.test goes red naming the key');

    assert.match(serialProblems({ test: 42 })[0], /^scripts\.test is missing/, 'a non-string script is red by name too');
});

test('self-test: a nonexistent package.json throws -- the identity assert is the read itself', () => {
    assert.throws(() => readScriptsAt(path.join(root, 'no-such-package.json')), /ENOENT/);
});
