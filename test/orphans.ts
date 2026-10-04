/**
 * The one shared helper behind the orphan canary (docs/testing-discipline.md, invariant inventory:
 * "The CLI leaves no orphaned Chromium/ffmpeg processes; the check counts them machine-wide
 * (parent pid 1)"). Not a test file (no `.test.` in the name): the runner's test/*.test.ts glob
 * never picks it up; it only ever runs as an import -- the test/assert-ran.ts convention, and for
 * the same reason: a scan-the-scanner canary (spawn-bounds.test.ts) reads every file the glob
 * picks up, and this file carries an execSync whose window must never classify as anything.
 *
 * What the counter counts: processes whose PARENT is pid 1 (launchd on macOS, init on CI's
 * Ubuntu) whose ps command line matches chrom|ffmpeg -- a browser or encoder its parent failed to
 * reap. The count is MACHINE-WIDE, not per test: it sees every Chromium and ffmpeg on the
 * machine, whoever started them. That is the property that makes it a canary (an orphan leaks out
 * of any test), and it is why the suite runs serial and one browser-driven job at a time
 * (AGENTS.md, Contributor notes and rule 6).
 *
 * Who wraps what:
 *   - watchOrphans(t) belongs at the top of every test that owns a Chromium in this process --
 *     the tests of the five files that call chromium.launch (browser/guide/tour/record/studio);
 *   - the CLI-driven browser tests (export/verify/buildall/learn) deliberately stay unwrapped:
 *     their Chromium lives inside a child CLI process whose lifecycle exitWhenDrained() and
 *     assertRan() already police, and an orphan there is not attributable to one test's cleanup
 *     -- wrapping them would buy a ps exec per test of noise;
 *   - the exception is record.test.ts's hang test, the canary's original home: it exists to prove
 *     the CLI leaves nothing behind, so it wraps through this same helper (its inline counter
 *     moved here verbatim, oracle unchanged), and the runTimeline test that drives the file's
 *     in-process browser wraps like any in-process owner.
 *
 * The counter's own health is part of the contract: a count of -1 (the ps pipeline failed) must
 * be a named failure wherever it is consumed, never a vacuous "-1 new orphans" that passes on
 * -1 <= -1. The self-test that proves the oracle can actually see an orphan lives in
 * test/orphans.test.ts (rule 3: a canary only counts if it can fail).
 */

import { execSync } from 'child_process';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/**
 * Count orphaned browser/ffmpeg processes (parent pid 1), machine-wide; -1 when the ps pipeline
 * itself failed. Moved verbatim from test/record.test.ts (where it wrapped only the hang test and
 * had no self-test): same pipeline, same 30 s bound, same -1-on-failure catch.
 */
export function countOrphans(): number {
    try {
        return parseInt(execSync("ps -ax -o ppid,command | awk '$1==1' | grep -E 'chrom|ffmpeg' | grep -v grep | wc -l", { timeout: 30000 }).toString().trim(), 10);
    } catch {
        return -1;
    }
}

/**
 * The canary's oracle, defined once so it cannot drift between consumers: nothing new with
 * parent pid 1, and a broken counter fails BY NAME instead of passing vacuously. `what` names the
 * consumer in the message; the "no orphaned browser/ffmpeg processes (before N, after M)" text is
 * the oracle record.test.ts's hang test has asserted all along.
 */
export function assertNoNewOrphans(before: number, what: string): void {
    assert.ok(before >= 0, `${what}: the orphan baseline count failed (ps exited non-zero, got ${before}); there is nothing to compare against`);
    const after = countOrphans();
    assert.ok(after >= 0, `${what}: the orphan count failed (ps exited non-zero, got ${after}); cannot tell a real orphan from a broken counter`);
    assert.ok(after <= before, `${what}: no orphaned browser/ffmpeg processes (before ${before}, after ${after})`);
}

/**
 * The one-line wrap for a test that owns a browser: snapshot before the body runs, assert after
 * it ends. after hooks run even when the body failed, so a test that reds on its own assertions
 * still reports an orphan it left behind (both failures surface). The counter is machine-wide, so
 * one check at the end sees an orphan of any point in the body.
 */
export function watchOrphans(t: TestContext): void {
    const before = countOrphans();
    t.after(() => assertNoNewOrphans(before, t.name));
}
