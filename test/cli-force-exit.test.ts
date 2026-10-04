import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Canary for the « Every CLI run force-exits through exitWhenDrained() (5 s grace, naming the
 * holders) » row (docs/testing-discipline.md, "Nothing in a run may wait forever"): the bootstrap
 * at the end of cli.ts is the one place every command exits through -- buildProgram()
 * .parseAsync(process.argv).catch(...).finally(exitWhenDrained). Drop the .finally and a browser
 * that refuses to close (or any handle left ref'd) hangs build-all's runCli and the suite's
 * spawnSync forever with every byte of output already printed -- a hung run that reads as a loop,
 * not a failure, exactly what the rule forbids.
 *
 * The oracle is a pure identity assert: cli.ts is read as text and never imported, so it cannot
 * agree by construction. Six asserts:
 *   1. "if (require.main === module) {" -- the bootstrap's home; if it moved to another file this
 *      reds and the canary is re-pointed deliberately, not silently;
 *   2. parseAsync is terminated by .finally(exitWhenDrained), which occurs exactly once in the file;
 *   3. the ".catch(" exitCode-1 path sits between them by index -- a failed command rides the same
 *      drain-then-leave path instead of exiting directly and skipping the holder report;
 *   4. "function exitWhenDrained(" is declared exactly once;
 *   5. "const EXIT_GRACE_MS = 5000" verbatim -- the 5 s grace the rule states;
 *   6. the holder-naming line ("still hold this process open") is present and counts both
 *      _getActiveHandles and _getActiveRequests -- a pending libuv request holds the loop open too.
 *
 * The verbatim strings are ratchets, not tolerances: renaming the drain, retuning the grace or
 * restructuring the chain reds this canary and forces a deliberate revisit (loosening needs rule
 * 8). There is no window here that could red as flake; a red always names the drifted string.
 *
 * The planted bootstrap texts of the self-tests assemble their load-bearing tokens at runtime by
 * concatenation (test/spawn-bounds.test.ts precedent) so this file's own text never carries a
 * complete matchable bootstrap: the oracle reads the repo root's cli.ts only today, but a
 * deliberate re-point at test/ must not classify this canary itself.
 */

const CLI_PATH = path.resolve(__dirname, '..', 'cli.ts');

// The 5 s grace as an identity: the number lives in cli.ts's declaration, quoted verbatim by the
// oracle and reused to plant the self-test's good text -- it appears once in this file.
const GRACE_IDENTITY = ['const EXIT_GRACE_', 'MS = 5000'].join('');

/** One problem per broken assert, each naming what drifted; empty means the bootstrap is intact. */
type Problem = string;

/** The force-exit bootstrap audit, as a pure function over the file's text. */
function auditForceExit(text: string): Problem[] {
    const problems: Problem[] = [];

    // 1. The bootstrap's home.
    if (!text.includes('if (require.main === module) {')) {
        problems.push('the bootstrap guard "if (require.main === module) {" is gone from cli.ts -- the entry point moved or was restructured; re-point this canary deliberately');
    }

    // 2. The chain terminates in the drain, and the drain is attached exactly once.
    if (!/buildProgram\(\)\.parseAsync\(process\.argv\)[\s\S]*?\.finally\(exitWhenDrained\)/.test(text)) {
        problems.push('buildProgram().parseAsync(process.argv) is no longer terminated by .finally(exitWhenDrained) -- drop the .finally and a browser that refuses to close hangs build-all\'s runCli and the suite\'s spawnSync forever with the output already printed');
    }
    const finallyCount = text.split('.finally(exitWhenDrained)').length - 1;
    if (finallyCount !== 1) {
        problems.push(`".finally(exitWhenDrained)" occurs ${finallyCount} times in cli.ts, expected exactly once -- every command path must leave through the one drain`);
    }

    // 3. The exitCode-1 path rides the same drain: ".catch(" sits between the chain's head and the
    // .finally by index. (Skipped when 2 already red -- there is no pair to sit between.)
    const parseIdx = text.search(/buildProgram\(\)\.parseAsync\(process\.argv\)/);
    const finallyIdx = text.indexOf('.finally(exitWhenDrained)');
    if (parseIdx >= 0 && finallyIdx >= 0) {
        const catchIdx = text.indexOf('.catch(', parseIdx);
        if (catchIdx < 0 || catchIdx >= finallyIdx) {
            problems.push('the ".catch(" exitCode-1 path no longer sits between buildProgram().parseAsync(process.argv) and .finally(exitWhenDrained) -- a failed command must ride the same drain-then-leave path, not exit directly and skip the holder report');
        }
    }

    // 4. Declared exactly once.
    const declCount = text.split('function exitWhenDrained(').length - 1;
    if (declCount !== 1) {
        problems.push(`"function exitWhenDrained(" is declared ${declCount} times in cli.ts, expected exactly once`);
    }

    // 5. The grace, verbatim -- the 5 s the rule states. A retune is a doc change too.
    if (!text.includes(GRACE_IDENTITY)) {
        problems.push(`"${GRACE_IDENTITY}" is gone from cli.ts -- the 5 s grace the rule states changed; revisit AGENTS.md and docs/testing-discipline.md with it, not silently`);
    }

    // 6. The holder report names its holders, libuv requests included.
    if (!text.includes('still hold this process open')) {
        problems.push('the holder-report line ("... still hold this process open ...") is gone from cli.ts -- a hung run must say what holds it open before leaving');
    }
    if (!text.includes('_getActiveHandles') || !text.includes('_getActiveRequests')) {
        problems.push('the holder report no longer counts both _getActiveHandles and _getActiveRequests -- a pending libuv request holds the loop open too, and counting only handles prints "0 handle(s)" in the one situation where this message is the whole diagnostic');
    }

    return problems;
}

// --- Planted bootstrap texts (the self-tests) ---------------------------------------------

// Load-bearing tokens, assembled at runtime so this file never carries a complete matchable
// bootstrap (test/spawn-bounds.test.ts precedent).
const GUARD = ['if (require.main ', '=== module) {'].join('');
const CHAIN_OPEN = ['buildProgram().parse', 'Async(process.argv)'].join('');
const CATCH = ['.cat', 'ch((e) => { process.exitCode = 1; })'].join('');
const FINALLY_TERM = ['.finally(', 'exitWhenDrained', ');'].join('');
const RENAMED_TERM = ['.finally(', 'tearDown', ');'].join('');
const DECL = ['function exitWhen', 'Drained(): void {'].join('');
const HANDLES = ['_getActive', 'Handles?.()'].join('');
const REQUESTS = ['_getActive', 'Requests?.()'].join('');
const HOLDER_LINE = ['still hold this process ', 'open'].join('');

/** A miniature of cli.ts's tail, faithful to the six asserts; each option breaks exactly one. */
function plantedBootstrap(opts: { guard?: boolean; finallyTerm?: string | null; grace?: string } = {}): string {
    const term = opts.finallyTerm === undefined ? FINALLY_TERM : opts.finallyTerm;
    const grace = opts.grace ?? `${GRACE_IDENTITY};`;
    const holder = [
        grace,
        `${DECL}`,
        '  const timer = setTimeout(() => {',
        `    const open = [...(process as any).${HANDLES} ?? [], ...(process as any).${REQUESTS} ?? []];`,
        `    console.error(\`warning \${open.length} ${HOLDER_LINE}\`);`,
        '    process.exit(process.exitCode ?? 0);',
        '  }, EXIT_GRACE_MS);',
        '  timer.unref();',
        '}',
    ];
    const chain = [
        ...(opts.guard === false ? [] : [GUARD]),
        `  ${CHAIN_OPEN}`,
        `    ${CATCH}${term === null ? ';' : ''}`,
        ...(term === null ? [] : [`    ${term}`]),
        ...(opts.guard === false ? [] : ['}']),
    ];
    return [...holder, ...chain].join('\n');
}

// --- The canary ----------------------------------------------------------------------------

test('cli.ts ends parseAsync with .finally(exitWhenDrained): the six identity asserts', () => {
    assert.ok(fs.existsSync(CLI_PATH), `cli.ts is gone from the repo root -- this canary reads ${CLI_PATH} by identity; re-point it deliberately, it may not pass vacuously`);
    const problems = auditForceExit(fs.readFileSync(CLI_PATH, 'utf8'));
    assert.deepEqual(problems, [], 'the force-exit bootstrap at the end of cli.ts drifted -- a dropped .finally hangs the suite as a loop with its output already printed, not as a failure');
});

test('self-test: a planted correct bootstrap audits clean', () => {
    assert.deepEqual(auditForceExit(plantedBootstrap()), [], 'a planted faithful bootstrap must audit clean -- the oracle reads the shape, not just this repo\'s file');
});

test('self-test: a dropped or renamed .finally goes red, naming it', () => {
    const dropped = auditForceExit(plantedBootstrap({ finallyTerm: null })).join('\n');
    assert.match(dropped, /no longer terminated by \.finally\(exitWhenDrained\)/, 'dropping the .finally must red by name');
    const renamed = auditForceExit(plantedBootstrap({ finallyTerm: RENAMED_TERM })).join('\n');
    assert.match(renamed, /no longer terminated by \.finally\(exitWhenDrained\)/, 'a renamed drain (.finally(tearDown)) must red by name too');
});

test('self-test: the grace, the guard and the holder report each red on their own break', () => {
    const grace = auditForceExit(plantedBootstrap({ grace: ['const EXIT_GRACE_', 'MS = 4000;'].join('') })).join('\n');
    assert.match(grace, /5 s grace/, 'EXIT_GRACE_MS = 4000 must red on the grace identity');
    const noGuard = auditForceExit(plantedBootstrap({ guard: false })).join('\n');
    assert.match(noGuard, /require\.main === module/, 'a bootstrap without the require.main guard must red -- the moved-entry-point case');
    assert.doesNotMatch(noGuard, /no longer terminated|occurs \d+ times|5 s grace|holder/, 'the guard-less text keeps a correct chain -- only the re-point assert reds, by name');
});

test('self-test: a missing cli.ts fails the read instead of passing vacuously', () => {
    assert.throws(() => fs.readFileSync(path.join(__dirname, 'no-such-dir', 'cli.ts'), 'utf8'), /ENOENT/, 'a vanished cli.ts must fail loudly at the read, never pass');
});
