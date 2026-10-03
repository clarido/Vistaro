/**
 * The one shared helper behind every CLI spawn in test/: the per-call bound, the result shape both
 * spawn styles resolve to, and the guard that turns a killed child into a named failure instead of
 * an "expected null to equal 0". Not a test file (no `.test.` in the name): the runner's
 * test/*.test.ts glob never picks it up; it only ever runs as an import.
 */

/**
 * A wedged child (a Chromium that will not close, a page stuck mid-navigation) used to hang the
 * whole suite: nothing bounded the wait, and node:test's own default timeout is Infinity. This
 * bound is per CALL, not per test, and it must stay well above the slowest healthy one -- CI runs
 * ~1.4x slower than a local machine and AGENTS.md warns the suite degrades beside other browser
 * jobs -- while staying far under the runner's own --test-timeout, so a wedge is reported here,
 * by name, rather than as the runner cancelling the whole test.
 */
export const CLI_TIMEOUT_MS = 300000;

/** One shape for both spawn styles: a utf8 `spawnSync` result satisfies it, and so does the
 *  { status, signal, stdout, stderr } the async helpers resolve; `error` is optional so the async
 *  shape can carry a spawn failure (an ENOENT resolves it) and assertRan reports that by name too. */
export type CliSpawnResult = {
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    error?: Error;
};

/** spawnSync reports a timeout as error ETIMEDOUT + signal SIGKILL and status null, which an
 *  `assert.equal(res.status, 0)` renders as "expected null to equal 0" -- true, and useless.
 *  Works on both shapes: call it on the spawnSync result inside a sync cli() wrapper, or after
 *  awaiting the raw spawn promise in an async one (a throw there rejects the helper's promise and
 *  fails the test by name; never inside the child's 'close' handler, where a throw cannot reject
 *  the outer promise and would escape as an uncaught exception). */
export function assertRan(res: CliSpawnResult, args: string[]): void {
    if (res.signal || res.error) {
        const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
        const why = code === 'ETIMEDOUT' ? `did not finish within ${CLI_TIMEOUT_MS}ms and was killed` : `was killed by ${res.signal ?? code}`;
        throw new Error(`cli ${args.join(' ')} ${why}`);
    }
}
