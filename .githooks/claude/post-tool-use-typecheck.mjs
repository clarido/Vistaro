#!/usr/bin/env node
/**
 * PostToolUse typecheck for Edit|Write|MultiEdit — whole-project `npx tsc --noEmit` after a
 * TypeScript edit, nothing cheaper and nothing narrower.
 *
 * MECHANISM: the harness feeds one JSON event on stdin ({tool_name, tool_input:{file_path}}).
 * PostToolUse cannot un-run the edit — "block" means the failure comes back to the agent as a
 * blocking error it must resolve before continuing.
 *   exit 0 = silent ok (also every non-TypeScript edit: only /\.tsx?$/ pays the run);
 *   exit 2 = blocking error — tsc reported diagnostics; stderr (the tsc output plus the block
 *            message) is fed back to the agent;
 *   any other non-zero = non-blocking — used here only for FAIL OPEN, LOUD.
 *
 * WHY WHOLE-PROJECT: tsconfig.json includes every .ts in the repo (strict + skipLibCheck); passing files on
 * the command line would bypass tsconfig.json entirely (the repo's strict/module settings would
 * not apply) and cross-file breaks (edit cli.ts, break src/commands/x.ts) would be invisible.
 * The script spawns exactly `npx tsc --noEmit` — no auto-fix flag, no formatter, no fs writes —
 * and only for TypeScript edits, so it exits 0 in tens of milliseconds otherwise.
 *
 * BOUNDS: TSC_HOOK_TIMEOUT_MS with killSignal SIGKILL, reported by name — the innermost bound
 * rule (AGENTS.md, «Nothing in a run may wait forever»: add a spawn, add its bound). A timeout
 * or a spawn error FAILS OPEN LOUDLY: the edit is NOT type-checked, and stderr says so.
 *
 * KNOWN HOLE, stated not fixed: an edit made through Bash (sed/tee) bypasses this hook — the
 * matcher never sees it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const TSC_HOOK_TIMEOUT_MS = 120000;

function failOpen(reason) {
    console.error(`post-tool-use typecheck could not run (${reason}) — FAILING OPEN; the edit is NOT type-checked`);
    process.exit(1);
}

let event;
try {
    event = JSON.parse(readFileSync(0, 'utf8'));
} catch (err) {
    failOpen(`unreadable stdin event: ${(err && err.message) || err}`);
}

const filePath = event && event.tool_input && event.tool_input.file_path;
if (typeof filePath !== 'string' || filePath.length === 0) failOpen('the tool event carries no file_path');
if (!/\.tsx?$/.test(filePath)) process.exit(0); // only TypeScript edits pay

// cwd: the project directory the harness names (CLAUDE_PROJECT_DIR), else the nearest
// package.json walking up from the edited file. Neither → fail open loudly.
let cwd = process.env.CLAUDE_PROJECT_DIR;
if (!cwd) {
    let dir = path.dirname(path.resolve(filePath));
    for (;;) {
        if (existsSync(path.join(dir, 'package.json'))) { cwd = dir; break; }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
}
if (!cwd) failOpen('no CLAUDE_PROJECT_DIR and no package.json above the edited file');
if (!existsSync(path.join(cwd, 'tsconfig.json'))) failOpen(`no tsconfig.json under ${cwd} — nothing to type-check against`);
// TypeScript must already be resolvable from cwd: without this check, `npx tsc` in a project
// that has not installed typescript FETCHES the decoy `tsc` npm package from the registry
// (a placeholder that prints "This is not the tsc command you are looking for" and exits 1),
// which would block a perfectly clean edit. Fail open loudly instead — never fetch.
if (!tscResolvable(cwd)) failOpen(`typescript is not installed under ${cwd} (no node_modules/.bin/tsc) — run npm install first`);

/** True when node_modules/.bin/tsc exists at `dir` or any parent of it. */
function tscResolvable(dir) {
    for (;;) {
        if (existsSync(path.join(dir, 'node_modules', '.bin', 'tsc'))) return true;
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

const res = spawnSync('npx', ['tsc', '--noEmit'], {
    cwd,
    timeout: TSC_HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
});
if (res.error || res.signal) {
    const why = res.error && res.error.code === 'ETIMEDOUT'
        ? `tsc exceeded ${TSC_HOOK_TIMEOUT_MS} ms and was killed`
        : `tsc could not be started (${(res.error && (res.error.code || res.error.message)) || res.signal})`;
    failOpen(why);
}
if (res.status === 0) process.exit(0);

const output = `${res.stdout || ''}${res.stderr || ''}`;
const errorCount = (output.match(/error TS\d+/g) || []).length;
// The verdict keys on the diagnostic shape in the output, not on a magic exit status: tsc 5.9
// with --noEmit exits 2 on diagnostics here (measured), and a non-zero exit without any
// `error TS…` line means tsc never really ran — that fails open, it never blocks.
if (errorCount === 0) failOpen(`tsc exited with status ${res.status} and produced no diagnostics`);
const block =
    `\n${output}` +
    `typecheck failed after ${event.tool_name} on ${filePath}: ${errorCount} errors. ` +
    "Fix ONLY what your own change introduced — errors naming files you edited or types your edit flows into. " +
    'Errors naming files you did not touch may pre-date your change: do not fix them here; a red naming a file that is not yours is a cross-lot event — report it (docs/testing-discipline.md, «When a canary goes red at you» §6). ' +
    "Never widen a type, add `any`, or add @ts-ignore to go green: loosening a guard needs JF's typed go (rule 8). " +
    'The hook keeps no baseline and cannot attribute errors to your edit; attribution is yours, by reading which files the errors name.';
console.error(block);
process.exit(2);
