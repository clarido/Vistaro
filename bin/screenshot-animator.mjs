#!/usr/bin/env node
// Published entry point. The package ships TypeScript with no build step: the CLI is
// src-side cli.ts, run through tsx, exactly like the repo's own test suite and docs
// scripts do (`node --import tsx cli.ts ...`). cli.ts only runs its program when it is
// the main module (`require.main === module`), which an import from this shim would
// never satisfy -- so the shim gives it a process of its own, with tsx registered via
// --import. tsx is resolved from this package's own dependency (not the caller's cwd),
// and the child's exit code and stdio are forwarded; Ctrl+C reaches both processes
// through the process group.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// Either bin name installs this shim (screenshot-animator, vistaro): speak as whichever
// command the user actually typed. Windows shims invoke node with the real file path, so the
// extension is stripped to at least degrade to the package name there.
const invokedName = basename(process.argv[1] ?? 'vistaro').replace(/\.(mjs|cjs|js)$/i, '');

let tsxImport;
try {
    tsxImport = pathToFileURL(require.resolve('tsx')).href;
} catch {
    console.error(`${invokedName}: the "tsx" package is missing (it is a runtime dependency of this CLI); reinstall the package.`);
    process.exit(1);
}

const child = spawn(process.execPath, ['--import', tsxImport, join(packageDir, 'cli.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
});
child.on('error', (e) => {
    console.error(`${invokedName}: could not start node: ${e.message}`);
    process.exit(1);
});
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
});
