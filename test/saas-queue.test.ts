import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Unit tests for saas/lib/queue.js — the serial in-process export queue.
 *
 * No module mocking: the queue is driven through its own seams. dataDir, repoRoot,
 * timeoutMs, disabled and log are constructor options (queue.js:59), and
 * spawnCommand() (queue.js:209) is overridden per test to return the absolute path of
 * a fake `npx` shim — a real executable script the queue really spawns as a child
 * process. The args (['tsx','cli.ts','export',<project>,'-o',<mp4>], queue.js:125)
 * and env (process.env, queue.js:140) are hard-coded in the lib, so the shim parses
 * its own argv to find the project dir and the -o output path; cwd is repoRoot
 * (queue.js:139), which is how the shim finds the per-test order log. PATH is never
 * modified and nothing listens on a port.
 */

// saas/lib is plain CommonJS JavaScript with no type declarations, and tsconfig keeps
// allowJs off: a static import would fail `npx tsc --noEmit` with TS7016. The
// workaround lives in this file only — a dynamic import whose specifier is typed as a
// plain string (so tsc cannot resolve the module, hence no error) plus a local cast.
const queuePath: string = '../saas/lib/queue.js';
const jobsPath: string = '../saas/lib/jobs.js';

type JobMeta = {
    id: string;
    status: string;
    createdAt?: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt?: string;
    durationMs?: number | null;
    error?: string;
    log?: string;
    command?: string;
    artifacts?: Record<string, string>;
};

type ExportQueueLike = {
    dataDir: string;
    repoRoot: string;
    timeoutMs: number;
    disabled: boolean;
    waiting: string[];
    runningJob: string | null;
    child: unknown;
    stopped: boolean;
    readonly depth: number;
    enqueue(meta: JobMeta): void;
    position(id: string): number | null;
    drain(): void;
    runOne(id: string): Promise<void>;
    spawnCommand(): string;
    finishFailure(id: string, message: string, tail?: string): void;
    markInterruptedJobs(): void;
    shutdown(): void;
};

type QueueModule = {
    ExportQueue: new (opts: {
        dataDir: string;
        repoRoot: string;
        timeoutMs?: number;
        disabled?: boolean;
        log?: (line: string) => void;
    }) => ExportQueueLike;
    discoverArtifacts(jobDirAbs: string): Record<string, string>;
};

type JobsModule = {
    createJobDirs(dataDir: string): { id: string; dir: string };
    jobDir(dataDir: string, id: string): string;
    readMeta(dataDir: string, id: string): JobMeta | null;
    writeMeta(dataDir: string, meta: JobMeta): void;
    listJobs(dataDir: string): JobMeta[];
};

async function loadModule<T>(spec: string): Promise<T> {
    // Non-literal specifier: tsc has nothing to resolve, so no TS7016. At runtime tsx
    // compiles this file to CommonJS and the import lands on the lib's module.exports;
    // under a native dynamic import the CJS module shows up as `default`, so take that
    // when present.
    const ns: unknown = await import(spec);
    const wrapped = ns as { default?: T };
    return wrapped.default !== undefined && wrapped.default !== null ? wrapped.default : (ns as T);
}

type Libs = { queue: QueueModule; jobs: JobsModule };

const libsP: Promise<Libs> = (async () => ({
    queue: await loadModule<QueueModule>(queuePath),
    jobs: await loadModule<JobsModule>(jobsPath),
}))();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const POSIX_ONLY = process.platform === 'win32' ? 'the fake-npx shim is a POSIX executable' : false;

// ---------------------------------------------------------------------------
// The fake `npx` shim
// ---------------------------------------------------------------------------

function shimSource(body: string[]): string {
    const lines = [
        '#!/usr/bin/env node',
        "// Test double for `npx`: queue.js spawns `<command> tsx cli.ts export <project> -o <out>`",
        '// (queue.js:125) with cwd at the repo root and env=process.env (queue.js:138-141). The',
        '// test that writes this file bakes one behavior into the body.',
        "'use strict';",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        'const argv = process.argv.slice(2);',
        "const project = argv[argv.indexOf('export') + 1];",
        "const out = argv[argv.indexOf('-o') + 1];",
        "const record = (kind) => fs.appendFileSync(path.join(process.cwd(), 'shim-order.log'), kind + ' ' + out + '\\n');",
        '(async () => {',
        ...body,
        '})().then(() => process.exit(), (e) => { console.error(e && (e.stack || e)); process.exit(1); });',
    ];
    return lines.join('\n') + '\n';
}

const SUCCESS_BODY = [
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(out, 'fake mp4 bytes');",
    "fs.writeFileSync(path.join(path.dirname(out), 'demo.vtt'), 'WEBVTT\\n');",
    "const guide = path.join(project, 'guide');",
    "fs.mkdirSync(path.join(guide, 'assets'), { recursive: true });",
    "fs.writeFileSync(path.join(guide, 'guide.html'), '<html>guide</html>');",
    "fs.writeFileSync(path.join(guide, 'guide.json'), '{}');",
    "fs.writeFileSync(path.join(guide, 'assets', 'poster.png'), 'png bytes');",
    "console.log('fake-npx: artifacts written for ' + project);",
];

const SLOW_SUCCESS_BODY = [
    "record('start');",
    'await new Promise((r) => setTimeout(r, 150));',
    "record('end');",
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(out, 'fake mp4 bytes');",
];

const EXIT_3_BODY = [
    "console.error('fake-npx: simulated CLI crash');",
    'process.exit(3);',
];

const EXIT_0_NO_VIDEO_BODY = [
    "fs.mkdirSync(path.dirname(out), { recursive: true });",
    "fs.writeFileSync(path.join(path.dirname(out), 'demo.vtt'), 'WEBVTT\\n');",
    "console.log('fake-npx: exit 0 with no demo.mp4');",
];

const HANG_BODY = [
    "process.on('SIGTERM', () => process.exit(143));",
    "console.log('fake-npx: hanging until killed');",
    'await new Promise((resolve) => setTimeout(resolve, 120000));',
];

// ---------------------------------------------------------------------------
// Per-test world: temp dirs, queue, log capture, cleanup
// ---------------------------------------------------------------------------

type World = {
    tmp: string;
    dataDir: string;
    repoRoot: string;
    logs: string[];
    queue: ExportQueueLike;
    jobs: JobsModule;
};

function makeWorld(libs: Libs, opts: { timeoutMs?: number; disabled?: boolean } = {}): World {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-queue-'));
    const dataDir = path.join(tmp, 'data');
    const repoRoot = path.join(tmp, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    const logs: string[] = [];
    const queue = new libs.queue.ExportQueue({
        dataDir,
        repoRoot,
        timeoutMs: opts.timeoutMs ?? 300,
        disabled: opts.disabled ?? false,
        log: (line: string) => logs.push(line),
    });
    return { tmp, dataDir, repoRoot, logs, queue, jobs: libs.jobs };
}

async function destroyWorld(w: World): Promise<void> {
    // Idempotent; for worlds with a running child it SIGTERMs it (the shim exits on
    // TERM) and empties the queue, so nothing survives into the next serial test.
    w.queue.shutdown();
    await delay(120); // let a SIGTERMed shim die before its cwd is removed
    fs.rmSync(w.tmp, { recursive: true, force: true });
}

function newJob(w: World, status = 'queued'): { id: string; dir: string; meta: JobMeta } {
    const { id, dir } = w.jobs.createJobDirs(w.dataDir);
    const meta: JobMeta = { id, status, createdAt: new Date().toISOString() };
    w.jobs.writeMeta(w.dataDir, meta);
    return { id, dir, meta };
}

// 30 s: all ten callers poll real child processes under a serial, machine-sensitive
// suite (AGENTS.md, "browser-driven commands are sensitive to what else is running");
// one 15 s window starved once in suite context. The 20 ms poll makes the wider window
// free when idle, and 30 s stays far under the runner's per-test cap. The optional
// evidence hook exists because the success test starved twice in suite context while
// green alone in 371 ms: the next red must say WHERE the job sat (never started vs
// running-forever), not only that a deadline passed.
async function until(fn: () => boolean, what: string, timeoutMs = 30000, evidence?: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${evidence ? `; ${evidence()}` : ''}`);
        }
        await delay(20);
    }
}

// ---------------------------------------------------------------------------
// discoverArtifacts (exported, queue.js:31-48)
// ---------------------------------------------------------------------------

test('discoverArtifacts finds exactly the five artifacts, as forward-slash paths relative to the job dir, and omits absent ones', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-queue-'));
    try {
        const jobDir = path.join(tmp, 'job');
        fs.mkdirSync(path.join(jobDir, 'out'), { recursive: true });
        fs.mkdirSync(path.join(jobDir, 'project', 'guide', 'assets'), { recursive: true });
        fs.writeFileSync(path.join(jobDir, 'out', 'demo.mp4'), 'mp4');
        fs.writeFileSync(path.join(jobDir, 'out', 'demo.vtt'), 'WEBVTT');
        fs.writeFileSync(path.join(jobDir, 'project', 'guide', 'guide.html'), '<html>');
        fs.writeFileSync(path.join(jobDir, 'project', 'guide', 'guide.json'), '{}');
        fs.writeFileSync(path.join(jobDir, 'project', 'guide', 'assets', 'poster.png'), 'png');
        fs.writeFileSync(path.join(jobDir, 'out', 'decoy.bin'), 'not an artifact');

        assert.deepEqual(
            libs.queue.discoverArtifacts(jobDir),
            {
                video: 'out/demo.mp4',
                subtitles: 'out/demo.vtt',
                guideHtml: 'project/guide/guide.html',
                guideJson: 'project/guide/guide.json',
                poster: 'project/guide/assets/poster.png',
            },
            'every present artifact is keyed and reported job-dir-relative',
        );

        fs.rmSync(path.join(jobDir, 'project', 'guide', 'assets', 'poster.png'));
        const after = libs.queue.discoverArtifacts(jobDir);
        assert.equal(after.poster, undefined, 'a missing file is omitted, not invented');
        assert.equal(after.video, 'out/demo.mp4', 'the others survive');

        const empty = path.join(tmp, 'nothing-here');
        assert.deepEqual(libs.queue.discoverArtifacts(empty), {}, 'a job dir with no artifacts discovers nothing');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// spawnCommand default (queue.js:209-212)
// ---------------------------------------------------------------------------

test('spawnCommand defaults to npx on POSIX and npx.cmd on win32 — the documented CLI entry point', async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        assert.equal(
            w.queue.spawnCommand(),
            process.platform === 'win32' ? 'npx.cmd' : 'npx',
            'the runner spawns the parent repo CLI through npx, exactly as documented',
        );
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// disabled limbo (queue.js:86-95)
// ---------------------------------------------------------------------------

test('disabled queue keeps jobs at the FRONT of waiting, never spawns, and their status honestly stays "queued"', async () => {
    const libs = await libsP;
    const w = makeWorld(libs, { disabled: true });
    try {
        const a = newJob(w);
        const b = newJob(w);
        w.queue.enqueue(a.meta);
        w.queue.enqueue(b.meta);
        await delay(80); // both setImmediate drains have run

        assert.equal(w.jobs.readMeta(w.dataDir, a.id)?.status, 'queued', 'job 1 was never started');
        assert.equal(w.jobs.readMeta(w.dataDir, b.id)?.status, 'queued', 'job 2 was never started');
        assert.equal(w.queue.runningJob, null, 'nothing is running');
        assert.equal(w.queue.child, null, 'no child was ever spawned');
        assert.ok(
            w.logs.every((l) => !l.includes('spawning')),
            `no spawn was logged, got: ${JSON.stringify(w.logs)}`,
        );
        assert.ok(
            w.logs.some((l) => l.includes('runner disabled (SAAS_DISABLE_RUNNER=1)') && l.includes(a.id)),
            'the limbo is announced in the log',
        );
        // The unshift (queue.js:93) is the point: after two drains the first job must
        // still sit at the front, so a server without the flag picks it up first.
        assert.deepEqual(w.queue.waiting, [a.id, b.id], 'both ids stay in waiting, first job first');
        assert.equal(w.queue.position(a.id), 1, 'job 1 holds position 1');
        assert.equal(w.queue.position(b.id), 2, 'job 2 holds position 2');
        assert.equal(w.queue.depth, 2, 'depth counts both waiting jobs');
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// Success path: status done, durationMs, artifacts (queue.js:195-206)
// ---------------------------------------------------------------------------

test('a successful export ends "done" with durationMs, the exact recorded command, and artifacts discovered from disk', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(SUCCESS_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const job = newJob(w);
        w.queue.enqueue(job.meta);
        await until(
            () => w.jobs.readMeta(w.dataDir, job.id)?.status === 'done',
            'job to finish as done',
            30000,
            () => {
                const m = w.jobs.readMeta(w.dataDir, job.id);
                return `last status: ${m?.status ?? 'no meta'}; error: ${m?.error ?? 'none'}; queue waiting: ${JSON.stringify(w.queue.waiting)}; runner logs: ${JSON.stringify(w.logs.slice(-3))}`;
            },
        );

        const meta = w.jobs.readMeta(w.dataDir, job.id)!;
        assert.equal(meta.error, undefined, 'no error on the done path');
        assert.ok(meta.startedAt, 'startedAt recorded');
        assert.ok(meta.finishedAt, 'finishedAt recorded');
        assert.equal(typeof meta.durationMs, 'number', 'durationMs is measured');
        assert.ok((meta.durationMs ?? -1) >= 0, 'durationMs is non-negative');
        // The command string is exactly what the lib builds: shim + the hard-coded args
        // of queue.js:125 with this job's real paths.
        const projectDir = path.join(job.dir, 'project');
        const outMp4 = path.join(job.dir, 'out', 'demo.mp4');
        assert.equal(meta.command, `${shim} tsx cli.ts export ${projectDir} -o ${outMp4}`, 'the exact spawn line is recorded');
        assert.deepEqual(meta.artifacts, {
            video: 'out/demo.mp4',
            subtitles: 'out/demo.vtt',
            guideHtml: 'project/guide/guide.html',
            guideJson: 'project/guide/guide.json',
            poster: 'project/guide/assets/poster.png',
        }, 'all five artifacts are discovered and job-dir-relative');
        // Artifacts are real files the shim wrote under this job's directory.
        assert.equal(fs.readFileSync(outMp4, 'utf8'), 'fake mp4 bytes', 'the mp4 the queue points at is the one on disk');
        assert.ok(
            w.logs.some((l) => l.includes(`job ${job.id}: done in`) && l.includes('out/demo.mp4')),
            'the done line names the artifact',
        );
        assert.equal(w.queue.depth, 0, 'the queue is empty again');
        assert.equal(w.queue.position(job.id), null, 'a done job has no position');
        // 'fake-npx: artifacts written for' is the shim's only stdout line (SUCCESS_BODY
        // above), so this is an identity assert on the real child output: a done
        // job.json keeps the CLI log tail exactly as every failure branch does.
        assert.ok(
            meta.log?.includes('fake-npx: artifacts written for'),
            'a done job.json keeps the CLI log tail like every failure branch does (finishFailure, queue.js:221) — set done.log = tail on the success path before jobs.writeMeta (queue.js:205)',
        );
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// Failure taxonomy (queue.js:179-198)
// ---------------------------------------------------------------------------

test('a non-zero exit fails the job with "export exited with code N" and keeps the CLI log tail', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(EXIT_3_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const job = newJob(w);
        w.queue.enqueue(job.meta);
        await until(() => w.jobs.readMeta(w.dataDir, job.id)?.status === 'failed', 'job to fail');

        const meta = w.jobs.readMeta(w.dataDir, job.id)!;
        assert.equal(meta.error, 'export exited with code 3', 'the exit code is named verbatim');
        assert.ok(meta.log?.includes('fake-npx: simulated CLI crash'), 'the CLI stderr tail is kept on failure');
        assert.equal(meta.durationMs != null, true, 'failure duration is measured');
        assert.ok(w.logs.some((l) => l.includes(`job ${job.id}: FAILED`) && l.includes('export exited with code 3')), 'the failure is logged');
        assert.equal(w.queue.depth, 0, 'a failed job leaves the queue');
    } finally {
        await destroyWorld(w);
    }
});

test('exit 0 without out/demo.mp4 fails the job: an empty success is not a success', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(EXIT_0_NO_VIDEO_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const job = newJob(w);
        w.queue.enqueue(job.meta);
        await until(() => w.jobs.readMeta(w.dataDir, job.id)?.status === 'failed', 'job to fail');

        const meta = w.jobs.readMeta(w.dataDir, job.id)!;
        assert.equal(meta.error, 'export exited 0 but no out/demo.mp4 was produced', 'the missing video is named verbatim');
        assert.equal(meta.artifacts, undefined, 'no artifacts are recorded for a video-less success');
    } finally {
        await destroyWorld(w);
    }
});

test('a spawn error fails the job with "could not spawn the CLI: …"', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const missing = path.join(w.tmp, 'no-such-npx');
        assert.equal(fs.existsSync(missing), false, 'precondition: the command does not exist');
        w.queue.spawnCommand = () => missing;

        const job = newJob(w);
        w.queue.enqueue(job.meta);
        await until(() => w.jobs.readMeta(w.dataDir, job.id)?.status === 'failed', 'job to fail');

        const meta = w.jobs.readMeta(w.dataDir, job.id)!;
        assert.match(
            meta.error ?? '',
            /^could not spawn the CLI: spawn .+ ENOENT$/,
            `the spawn error is wrapped verbatim, got: ${JSON.stringify(meta.error)}`,
        );
        assert.equal(w.queue.child, null, 'no child handle is left behind');
    } finally {
        await destroyWorld(w);
    }
});

test('a job exceeding timeoutMs is killed and fails with "export timed out after N ms and was killed"', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs, { timeoutMs: 300 });
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(HANG_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const job = newJob(w);
        const startedAt = Date.now();
        w.queue.enqueue(job.meta);
        await until(() => w.jobs.readMeta(w.dataDir, job.id)?.status === 'failed', 'job to be killed');

        const meta = w.jobs.readMeta(w.dataDir, job.id)!;
        assert.equal(meta.error, 'export timed out after 300 ms and was killed', 'the timeout message names the configured cap');
        assert.equal(w.queue.child, null, 'the child is cleared after the kill');
        assert.ok((meta.durationMs ?? 0) >= 250, 'the kill really waited for the cap, not for the shim');
        assert.ok(Date.now() - startedAt < 10000, 'SIGTERM ends the shim promptly — the 10 s SIGKILL escalation never has to fire');
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// Serial drain with recovery (queue.js:99-107)
// ---------------------------------------------------------------------------

test('the queue drains serially and RECOVERS: a second enqueued job runs after the first finishes (the finally re-drain)', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(SLOW_SUCCESS_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const a = newJob(w);
        const b = newJob(w);
        const outA = path.join(a.dir, 'out', 'demo.mp4');
        const outB = path.join(b.dir, 'out', 'demo.mp4');
        w.queue.enqueue(a.meta);
        w.queue.enqueue(b.meta);

        // Mid-flight: job 1 is running (so off the waiting list), job 2 waits behind it.
        await until(() => w.jobs.readMeta(w.dataDir, a.id)?.status === 'running', 'job 1 to start running');
        assert.equal(w.queue.position(a.id), null, 'a running job has no position');
        assert.equal(w.queue.position(b.id), 1, 'job 2 is next in line');
        assert.equal(w.queue.depth, 2, 'depth counts waiting + running');

        // The regression this guards (comment at queue.js:96-98): without the finally
        // clearing runningJob and re-draining, job 2 waits forever.
        await until(() => w.jobs.readMeta(w.dataDir, b.id)?.status === 'done', 'job 2 to finish as done');
        assert.equal(w.jobs.readMeta(w.dataDir, a.id)?.status, 'done', 'job 1 also finished done');

        const orderFile = path.join(w.repoRoot, 'shim-order.log');
        const order = fs.readFileSync(orderFile, 'utf8').split('\n').filter(Boolean);
        assert.deepEqual(
            order,
            [`start ${outA}`, `end ${outA}`, `start ${outB}`, `end ${outB}`],
            `the two children never overlapped, got: ${JSON.stringify(order)}`,
        );
        assert.equal(w.queue.depth, 0, 'both jobs drained');
        assert.equal(w.queue.position(b.id), null, 'no position once done');
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// shutdown (queue.js:240-249)
// ---------------------------------------------------------------------------

test('shutdown SIGTERMs the running child (killReason shutdown), empties waiting, and the waiting job is dropped, not started', { skip: POSIX_ONLY }, async () => {
    const libs = await libsP;
    const w = makeWorld(libs, { timeoutMs: 60000 });
    try {
        const shim = path.join(w.tmp, 'fake-npx');
        fs.writeFileSync(shim, shimSource(HANG_BODY));
        fs.chmodSync(shim, 0o755);
        w.queue.spawnCommand = () => shim;

        const a = newJob(w);
        const b = newJob(w);
        w.queue.enqueue(a.meta);
        await until(() => w.jobs.readMeta(w.dataDir, a.id)?.status === 'running', 'job 1 to start running');
        w.queue.enqueue(b.meta);
        await until(() => w.queue.waiting.length === 1, 'job 2 to sit in waiting');

        w.queue.shutdown();
        assert.equal(w.queue.stopped, true, 'the queue is stopped');
        assert.deepEqual(w.queue.waiting, [], 'waiting was emptied');
        assert.ok(w.logs.some((l) => l.includes('shutdown: killing running export')), 'the kill is logged');

        await until(() => w.jobs.readMeta(w.dataDir, a.id)?.status === 'failed', 'the running job to be aborted');
        const failed = w.jobs.readMeta(w.dataDir, a.id)!;
        assert.equal(failed.error, 'export aborted: server shut down while it was running', 'the abort message is verbatim');
        assert.equal(w.queue.child, null, 'the child handle is cleared');

        await delay(250); // long enough that a wrongly re-drained queue would have started job 2
        assert.equal(w.jobs.readMeta(w.dataDir, b.id)?.status, 'queued', 'the waiting job was never started');
        assert.equal(w.queue.runningJob, null, 'nothing runs after shutdown');
    } finally {
        await destroyWorld(w);
    }
});

// ---------------------------------------------------------------------------
// markInterruptedJobs (queue.js:227-238)
// ---------------------------------------------------------------------------

test('markInterruptedJobs flips queued/running metas to failed with the "submit again" message and leaves done/failed bytes untouched', async () => {
    const libs = await libsP;
    const w = makeWorld(libs);
    try {
        const queued = newJob(w, 'queued');
        const running = newJob(w, 'running');
        const done = newJob(w, 'done');
        const failed = newJob(w, 'failed');
        // Non-terminal-free jobs keep whatever a real run left behind.
        const doneMeta = w.jobs.readMeta(w.dataDir, done.id)!;
        doneMeta.finishedAt = new Date().toISOString();
        doneMeta.artifacts = { video: 'out/demo.mp4' };
        w.jobs.writeMeta(w.dataDir, doneMeta);
        const failedMeta = w.jobs.readMeta(w.dataDir, failed.id)!;
        failedMeta.error = 'export exited with code 3';
        w.jobs.writeMeta(w.dataDir, failedMeta);
        const doneBefore = fs.readFileSync(path.join(done.dir, 'job.json'), 'utf8');
        const failedBefore = fs.readFileSync(path.join(failed.dir, 'job.json'), 'utf8');

        w.queue.markInterruptedJobs();

        const q = w.jobs.readMeta(w.dataDir, queued.id)!;
        assert.equal(q.status, 'failed', 'queued is dead after a restart');
        assert.equal(
            q.error,
            'server restarted while the job was queued; the MVP queue is in-memory, submit again',
            'the queued message is verbatim',
        );
        assert.ok(q.finishedAt, 'the interrupted job gets a finishedAt');

        const r = w.jobs.readMeta(w.dataDir, running.id)!;
        assert.equal(r.status, 'failed', 'running is dead after a restart');
        assert.equal(
            r.error,
            'server restarted while the job was running; the MVP queue is in-memory, submit again',
            'the running message is verbatim',
        );

        assert.equal(fs.readFileSync(path.join(done.dir, 'job.json'), 'utf8'), doneBefore, 'done jobs are not rewritten');
        assert.equal(fs.readFileSync(path.join(failed.dir, 'job.json'), 'utf8'), failedBefore, 'failed jobs are not rewritten');
        assert.ok(
            w.logs.some((l) => l.includes('marked failed (interrupted by restart)')),
            'the recovery is logged',
        );
    } finally {
        await destroyWorld(w);
    }
});
