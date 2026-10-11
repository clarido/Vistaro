import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium } from 'playwright';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';

const root = path.resolve(__dirname, '..');

/**
 * Playwright's Chromium (the recording engine) is a separate download from `npm install` -- the
 * setup step in AGENTS.md. Without it, every browser-driven command used to die with Playwright's
 * raw banner: an unversioned `npx playwright install` that can resolve a different major whose
 * browser revision will not match. src/browser.ts guards the one launch seam with a version-matched
 * fix command; these tests pin that contract.
 *
 * The absent-engine cases must run in CHILD processes: playwright resolves PLAYWRIGHT_BROWSERS_PATH
 * once, at import time (verified on 1.58.2), so flipping the env var inside a process that has
 * already imported src/browser.ts (and with it playwright) is ignored -- the "absent" probe would
 * quietly report the real cache and the test would pass vacuously.
 */

/** The fix command a missing-engine failure must carry, pinned to the playwright actually installed. */
function expectedCommand(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'playwright', 'package.json'), 'utf8'));
    return `npx playwright@${pkg.version} install chromium`;
}

/** A temp dir playwright will find no browser under. */
function emptyBrowsersDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'anim-no-chromium-'));
}

/**
 * A PARTIAL install, staged from the real browsers cache: a temp PLAYWRIGHT_BROWSERS_PATH root
 * holding a symlink to only one of the two binaries playwright installs for chromium -- the
 * full-Chrome build (chromium-<rev>) or the headless shell (chromium-headless-shell-<rev>). They
 * are separate binaries, and a channel-less headless launch runs the SHELL, which is exactly the
 * split the two partial-install tests below pin: Chrome-without-shell must still fail with the
 * fix command (the probe-only guard misses it), and shell-without-Chrome must still LAUNCH (a
 * full-Chrome probe would falsely refuse it).
 */
function partialBrowsersRoot(keep: 'chromium' | 'shell'): string {
    // Walk up to the chromium-<rev> dir rather than counting dirnames: on macOS the binary sits
    // inside a .app bundle, five levels deep, and any fixed count is platform-wrong.
    let dir = chromium.executablePath();
    while (dir !== path.dirname(dir) && !/^chromium-\d+$/.test(path.basename(dir))) dir = path.dirname(dir);
    assert.ok(/^chromium-\d+$/.test(path.basename(dir)), `could not find the chromium-<rev> dir above ${chromium.executablePath()}`);
    const root = path.dirname(dir);
    const wanted = keep === 'chromium'
        ? path.basename(dir)
        : fs.readdirSync(root).find((name) => /^chromium_headless_shell-\d+$/.test(name));
    assert.ok(wanted, `no ${keep === 'chromium' ? 'chromium' : 'headless-shell'} binary found under ${root} -- run the browser install first`);
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-partial-'));
    fs.symlinkSync(path.join(root, wanted), path.join(partial, wanted));
    return partial;
}

test('chromiumMissingMessage(): null when the engine is installed', async () => {
    const { chromiumMissingMessage } = await import('../src/browser');
    assert.equal(chromiumMissingMessage(), null);
});

test('chromiumMissingMessage(): the versioned fix command when the engine is absent', () => {
    const empty = emptyBrowsersDir();
    try {
        // Fresh node + tsx, so playwright meets PLAYWRIGHT_BROWSERS_PATH at import time.
        const probe = `const m = require(${JSON.stringify(path.join(root, 'src', 'browser'))}).chromiumMissingMessage(); process.stdout.write(m === null ? 'null' : m);`;
        const res = spawnSync(process.execPath, ['--import', 'tsx', '-e', probe], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } });
        assertRan(res, ['-e', '<chromiumMissingMessage probe>']);
        assert.equal(res.status, 0, `the probe itself failed: ${res.stderr}`);
        assert.notEqual(res.stdout, 'null', 'the engine is reported present under an empty PLAYWRIGHT_BROWSERS_PATH -- the absence simulation stopped simulating');
        assert.match(res.stdout, /npx playwright@\d+\.\d+\.\d+ install chromium/);
        assert.ok(res.stdout.includes(expectedCommand()), `the command is pinned to the installed playwright: expected "${expectedCommand()}" in "${res.stdout}"`);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('a browser-driven CLI command fails with the versioned fix command when the engine is absent', () => {
    // The fixture must stay statically clean for the browser pass to run at all (check skips it
    // on timing/action errors): this test's oracle is the fix command ON STDERR, which only the
    // browser pass can put there.
    const empty = emptyBrowsersDir();
    try {
        const args = ['check', 'test/fixtures/basic'];
        const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } });
        assertRan(res, args);
        assert.notEqual(res.status, 0, 'check must not succeed without the recording engine');
        assert.match(res.stderr, /npx playwright@\d+\.\d+\.\d+ install chromium/);
        assert.ok(res.stderr.includes(expectedCommand()), `stderr carries the versioned command: ${res.stderr}`);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test('a partial install (full Chrome present, headless shell absent) still fails with the fix command', () => {
    // The existence probe watches the full-Chrome binary, so this state passes any probe -- only
    // the launch itself, which resolves the headless shell, knows the engine is unusable.
    const partial = partialBrowsersRoot('chromium');
    try {
        const args = ['check', 'test/fixtures/basic'];
        const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: partial } });
        assertRan(res, args);
        assert.notEqual(res.status, 0, 'a Chrome-without-shell install cannot run the browser pass');
        assert.ok(res.stderr.includes(expectedCommand()), `stderr carries the versioned command, not the raw banner: ${res.stderr}`);
    } finally {
        fs.rmSync(partial, { recursive: true, force: true });
    }
});

test('a shell-only install (what `install --only-shell` produces) still launches, not falsely refused', { timeout: 180000 }, () => {
    // The other direction of the same split: the shell is the binary a headless launch runs, so
    // this state WORKED before the guard existed and must keep working -- a probe that refuses
    // on a missing full-Chrome binary is a functional regression, not a guard.
    const partial = partialBrowsersRoot('shell');
    try {
        const args = ['check', 'test/fixtures/basic'];
        const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: partial } });
        assertRan(res, args);
        assert.equal(res.status, 0, `check must still run on a headless-shell-only install:\nstdout:${res.stdout}\nstderr:${res.stderr}`);
        assert.match(res.stdout, /static \+ browser check/, 'a real browser pass ran');
    } finally {
        fs.rmSync(partial, { recursive: true, force: true });
    }
});
