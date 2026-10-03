import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { assertRan, CLI_TIMEOUT_MS, CliSpawnResult } from './assert-ran';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'test', 'fixtures', 'basic');

async function cli(args: string[]): Promise<CliSpawnResult> {
    const res = await new Promise<CliSpawnResult>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        // signal is carried out, or a timeout kill would be indistinguishable from a crash.
        child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
        // An ENOENT emits 'error' and never 'close': resolve it too, or the awaited promise would hang.
        child.on('error', (error) => resolve({ status: null, signal: null, stdout, stderr, error }));
    });
    assertRan(res, args);
    return res;
}

interface VerifyStepRow {
    index: number;
    id: string;
    action: string;
    actualMs: number | null;
    completedMs: number | null;
    error?: string;
}

interface VerifyJson {
    ok: boolean;
    durationMs: number;
    chapters: number;
    issues: string[];
    steps: VerifyStepRow[];
}

let work: string;

before(() => {
    if (skip) return;
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-verify-'));
    fs.cpSync(fixture, path.join(work, 'basic'), { recursive: true });
});
after(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

test('verify: builds the demo and audits it (verify.json contract, strip beside the video, exit 0)', { skip }, async () => {
    const dir = path.join(work, 'basic');
    const r = await cli(['verify', dir]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /OK: every step ran/);

    const report: VerifyJson = JSON.parse(fs.readFileSync(path.join(dir, 'verify.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.ok(report.durationMs > 0, 'durationMs recorded');
    assert.ok(report.steps.length > 0, 'one row per timeline step');
    for (const s of report.steps) {
        assert.equal(s.error, undefined, `step ${s.id} unexpectedly failed: ${s.error}`);
        assert.ok(typeof s.actualMs === 'number', `step ${s.id} carries its measured actualMs`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'verify.mp4')), 'video written');
    assert.ok(fs.existsSync(path.join(dir, 'verify.vtt')), 'subtitles written');
    assert.ok(fs.existsSync(path.join(dir, 'verify.strip.png')), 'filmstrip written');
});

test('verify: a failed step lands in verify.json with its error and exits 1', { skip }, async () => {
    const dir = path.join(work, 'failing');
    fs.cpSync(fixture, dir, { recursive: true });
    const configPath = path.join(dir, 'anim.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const open = config.steps.find((s: { id: string }) => s.id === 'open');
    assert.ok(open, 'fixture carries the open click step this test breaks');
    open.target = '#does-not-exist';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const r = await cli(['verify', dir]);
    assert.equal(r.status, 1, 'a failed step fails the audit');
    assert.match(r.stdout, /FAILED/);

    const report: VerifyJson = JSON.parse(fs.readFileSync(path.join(dir, 'verify.json'), 'utf8'));
    assert.equal(report.ok, false);
    const failed = report.steps.find(s => s.error);
    assert.ok(failed, 'the failed step is recorded with its error');
    assert.ok(typeof failed!.error === 'string' && failed!.error.length > 0, 'the error names the problem');
    assert.equal(failed!.id, 'open');
});
