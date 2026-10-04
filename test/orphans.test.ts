import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { countOrphans } from './orphans';

/**
 * Rule-3 self-test for the orphan canary (docs/testing-discipline.md:54): `orphans()` existed
 * only as an inline counter in record.test.ts, wrapping one test with no proof it can fail -- a
 * grep that matched nothing, a ppid filter that caught nothing, or a ps that broke into -1 would
 * pass every wrapped test vacuously ("0 new orphans", or "-1 <= -1"). This test plants a REAL
 * orphan and watches the counter see it, through the same accessor its consumers use
 * (countOrphans), never a look-alike.
 *
 * The decoy solves reparenting honestly: the direct parent (/bin/sh) must EXIT so the kernel
 * reparents the child to pid 1 (launchd on macOS, init on CI's Ubuntu) -- the machine-wide
 * ppid==1 assumption the counter is built on, here made explicit and tested. sh backgrounds a
 * node process that would self-exit after 15 s, echoes its pid ($! IS the node pid -- sh
 * backgrounds node directly) and exits immediately, orphaning it. The decoy's ps command line
 * carries both needles via one argument (-- decoy-chromium-ffmpeg), so the counter's own grep
 * matches it unmodified: the oracle's pattern is never widened to make the decoy visible.
 *
 * The test must leave the machine as it found it: the suite is serial and record.test.ts's hang
 * test counts orphans on this same machine minutes later, so the decoy is SIGKILLed and the
 * count is polled back down to the baseline before the test ends. Even on a red path the decoy
 * self-exits within 15 s, so a failure here cannot poison the rest of the run for long. Every
 * wait is bounded (nothing in a run may wait forever), and no window of this file's spawn names
 * cli.ts, so spawn-bounds.test.ts classifies it as nothing, like its node probe.
 */

const DECOY_ARG = 'decoy-chromium-ffmpeg';
/** The decoy kills itself after this long, so it can never outlive the test that planted it. */
const DECOY_SELF_EXIT_MS = 15000;
/** Nothing waits forever: the pid read, and each of the two polls, get their own bound. */
const PID_READ_BUDGET_MS = 5000;
const POLL_INTERVAL_MS = 250;
const POLL_BUDGET_MS = 5000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** sh backgrounds the decoy node, prints its pid and exits at once; the node process lives on,
 *  reparented to pid 1. Resolves with the pid, or fails by name within the budget. */
function spawnDecoy(): Promise<number> {
    return new Promise((resolve, reject) => {
        const sh = spawn('/bin/sh', ['-c', `"${process.execPath}" -e "setTimeout(() => process.exit(0), ${DECOY_SELF_EXIT_MS})" -- ${DECOY_ARG} & echo $!`], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        const bail = setTimeout(() => {
            sh.kill('SIGKILL');
            reject(new Error(`the decoy shell never printed the orphan pid within ${PID_READ_BUDGET_MS}ms`));
        }, PID_READ_BUDGET_MS);
        sh.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const pid = parseInt(out.trim(), 10);
            if (Number.isFinite(pid) && pid > 1) {
                clearTimeout(bail);
                resolve(pid);
            }
        });
        sh.on('error', (error) => { clearTimeout(bail); reject(error); });
    });
}

/** Poll the machine-wide counter until the predicate holds; null when the budget ran out (the
 *  caller turns that into the named failure). A -1 mid-poll (a ps hiccup) keeps polling. */
async function pollOrphansUntil(predicate: (n: number) => boolean): Promise<number | null> {
    const deadline = Date.now() + POLL_BUDGET_MS;
    for (;;) {
        const n = countOrphans();
        if (n >= 0 && predicate(n)) return n;
        if (Date.now() > deadline) return null;
        await sleep(POLL_INTERVAL_MS);
    }
}

test('orphans: the counter sees a real orphan (ppid 1, ps line matching chrom|ffmpeg) and the machine is left as it was found', async () => {
    // The counter's own health first: a broken ps pipeline must fail here by name -- and by the
    // same token fail every wrapped test's baseline through assertNoNewOrphans -- instead of
    // passing vacuously as "-1 new orphans".
    const before = countOrphans();
    assert.ok(before >= 0, `countOrphans() returned ${before}: the ps pipeline behind the canary is broken, so no wrapped test can count anything`);
    const pid = await spawnDecoy();

    // The decoy is alive and reparented: the counter must rise above the baseline. Poll rather
    // than check once -- the reparenting lands between two scheduler ticks.
    const seen = await pollOrphansUntil(n => n > before);
    assert.ok(seen !== null, `the counter never saw the decoy (pid ${pid}): it stayed at ${countOrphans()} against a baseline of ${before} for ${POLL_BUDGET_MS}ms -- the grep, the ppid==1 filter or the kernel reparenting broke, and every wrapped test would pass vacuously`);

    // Leave the machine exactly as it was found: the suite is serial and record.test.ts's hang
    // test counts orphans on this same machine minutes later -- a lingering decoy would red
    // there as a false orphan.
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    const down = await pollOrphansUntil(n => n <= before);
    assert.ok(down !== null, `the decoy (pid ${pid}) is still counted ${POLL_BUDGET_MS}ms after SIGKILL (baseline ${before}, now ${countOrphans()}): it would red every later orphan check as a false orphan`);
});
