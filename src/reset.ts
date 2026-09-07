import { spawnSync } from 'child_process';

/** How long a reset command may run before the CLI gives up on it. */
export const RESET_TIMEOUT_MS = 120000;

/**
 * Live pages: run the reset command (`--reset-cmd`, or `meta.reset` from the timeline) before a pass
 * over the app, so a timeline that writes data starts from the same state every time (`record --guide`
 * replays the whole timeline a second time). The command is a shell string on purpose: it is the
 * caller's own script (`npm run db:seed`, `curl -X POST …/reset`), never anything derived from page
 * content. It runs in the CLI's working directory, not the guide directory.
 *
 * The child's stdout is routed to our stderr, and our own line goes through `log`, so a reset can
 * never contaminate `check --json`.
 */
export function runResetCommand(cmd: string | undefined, label: string, log: (m: string) => void = console.log): void {
    if (!cmd || !cmd.trim()) return;
    log(`Resetting the app before the ${label} (${cmd})...`);
    const r = spawnSync(cmd, { shell: true, stdio: ['ignore', process.stderr, 'inherit'], timeout: RESET_TIMEOUT_MS });
    if (r.error) throw new Error(`reset command failed to start: ${r.error.message}`);
    if (r.signal) {
        const why = r.signal === 'SIGTERM' ? ` (it ran longer than ${RESET_TIMEOUT_MS / 1000}s)` : '';
        throw new Error(`reset command was killed by ${r.signal}${why} before the ${label}: ${cmd}`);
    }
    if (r.status !== 0) throw new Error(`reset command exited with status ${r.status} before the ${label}: ${cmd}`);
}
