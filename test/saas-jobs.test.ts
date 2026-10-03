import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// saas/lib/jobs.js is plain JavaScript: the repo has neither allowJs nor a
// declaration file for it, so a static import would fail `npx tsc --noEmit`
// with TS7016. The workaround stays inside this file: resolve the module at
// runtime through a NON-LITERAL dynamic import (TypeScript does not resolve
// non-literal specifiers, so it stays silent) and pin the shape locally.
interface JobMeta {
  id: string;
  createdAt?: string;
  status?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface JobsModule {
  JOB_ID_RE: RegExp;
  LOG_TAIL_BYTES: number;
  createJobDirs(dataDir: string): { id: string; dir: string };
  deleteJob(dataDir: string, id: string): void;
  jobDir(dataDir: string, id: string): string;
  jobsRoot(dataDir: string): string;
  listJobs(dataDir: string): JobMeta[];
  newJobId(): string;
  readMeta(dataDir: string, id: string): JobMeta | null;
  tailString(buf: Buffer | string | null | undefined, maxBytes?: number): string;
  writeMeta(dataDir: string, meta: JobMeta): void;
}

async function loadJobs(): Promise<JobsModule> {
    const specifier = '../saas/lib/jobs.js';
    const mod = (await import(specifier)) as { default?: JobsModule } & Partial<JobsModule>;
    return mod.default ?? (mod as JobsModule);
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saas-jobs-'));
}

test('newJobId returns "bld_" + 16 lowercase hex chars, passes its own JOB_ID_RE, and is unique', async () => {
    const jobs = await loadJobs();
    const id = jobs.newJobId();
    assert.match(id, /^bld_[0-9a-f]{16}$/, `id should be bld_ + 16 lowercase hex, got ${id}`);
    assert.ok(jobs.JOB_ID_RE.test(id), 'the store must accept the very ids newJobId mints');
    const ids = new Set(Array.from({ length: 200 }, () => jobs.newJobId()));
    assert.equal(ids.size, 200, '8 random bytes per id: 200 draws never collide');
});

test('JOB_ID_RE admits exactly the id alphabet [A-Za-z0-9_-] up to 64 chars', async () => {
    const jobs = await loadJobs();
    assert.ok(jobs.JOB_ID_RE.test('bld_ABC_-99'), 'uppercase, dash and underscore are legal');
    assert.ok(jobs.JOB_ID_RE.test('x'.repeat(64)), 'exactly 64 chars is legal');
    assert.ok(!jobs.JOB_ID_RE.test(''), 'the empty string is not an id');
    assert.ok(!jobs.JOB_ID_RE.test('x'.repeat(65)), '65 chars is over the cap');
    assert.ok(!jobs.JOB_ID_RE.test('../etc'), 'no slashes, no dots: the id is a path segment');
});

test('writeMeta writes <dataDir>/jobs/<id>/job.json, stamps updatedAt, leaves no tmp behind', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        const { id } = jobs.createJobDirs(d);
        const before = Date.now();
        jobs.writeMeta(d, { id, status: 'queued', createdAt: '2026-10-03T10:00:00.000Z' });
        const file = path.join(d, 'jobs', id, 'job.json');
        assert.ok(fs.existsSync(file), 'job.json sits at the documented place');
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(onDisk.status, 'queued', 'the fields survive the round-trip');
        assert.equal(onDisk.createdAt, '2026-10-03T10:00:00.000Z', 'caller-provided fields are kept verbatim');
        const ts = Date.parse(onDisk.updatedAt);
        assert.ok(!Number.isNaN(ts) && ts >= before - 1000 && ts <= Date.now() + 1000,
            `updatedAt is a fresh ISO stamp, got ${onDisk.updatedAt}`);
        const meta = jobs.readMeta(d, id);
        assert.ok(meta, 'readMeta parses back what writeMeta wrote');
        assert.deepEqual(meta, onDisk, 'readMeta returns exactly what the file holds');
        const leftovers = fs.readdirSync(path.join(d, 'jobs', id)).filter(n => n.endsWith('.tmp'));
        assert.equal(leftovers.length, 0, 'the tmp file is renamed away, never left beside job.json');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('readMeta returns null — never throws — for a missing id, a missing file, and torn/corrupt JSON', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        assert.equal(jobs.readMeta(d, 'no-such-job'), null, 'a wholly missing id');
        const { id } = jobs.createJobDirs(d);
        assert.equal(jobs.readMeta(d, id), null, 'the dir exists but job.json was not written yet');
        fs.writeFileSync(path.join(d, 'jobs', id, 'job.json'), '{"status": "queu');
        assert.equal(jobs.readMeta(d, id), null, 'a torn (mid-write) JSON');
        fs.writeFileSync(path.join(d, 'jobs', id, 'job.json'), 'not json at all');
        assert.equal(jobs.readMeta(d, id), null, 'plain garbage');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('listJobs returns [] when the jobs root does not exist', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        assert.deepEqual(jobs.listJobs(d), [], 'no <dataDir>/jobs yet');
        assert.deepEqual(jobs.listJobs(path.join(d, 'deeper', 'missing')), [], 'a nested missing root too');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('listJobs sorts newest createdAt first and skips stray dirs, overlong names and unreadable metas', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        const root = path.join(d, 'jobs');
        // Written oldest-first so the sort has real work to do. The job
        // directories pre-exist, as createJobDirs (server.js) leaves them.
        for (const id of ['bld_oldest', 'bld_newest']) fs.mkdirSync(path.join(root, id), { recursive: true });
        jobs.writeMeta(d, { id: 'bld_oldest', createdAt: '2026-01-01T00:00:00.000Z', status: 'done' });
        jobs.writeMeta(d, { id: 'bld_newest', createdAt: '2026-05-01T00:00:00.000Z', status: 'done' });
        // A directory whose NAME fails JOB_ID_RE, even one carrying a plausible job.json.
        fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
        fs.writeFileSync(path.join(root, '.hidden', 'job.json'),
            JSON.stringify({ id: '.hidden', createdAt: '2026-12-31T00:00:00.000Z' }));
        fs.mkdirSync(path.join(root, 'a'.repeat(65)), { recursive: true }); // over the 64-char cap
        // A valid-shaped id whose job.json is unreadable is skipped too.
        fs.mkdirSync(path.join(root, 'bld_broken'), { recursive: true });
        fs.writeFileSync(path.join(root, 'bld_broken', 'job.json'), '{oops');
        const list = jobs.listJobs(d);
        assert.deepEqual(list.map(m => m.id), ['bld_newest', 'bld_oldest'],
            'newest createdAt first; the stray, the overlong and the broken are invisible');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('createJobDirs builds <id>/project and <id>/out, returns {id, dir}, and never reuses an id', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        assert.equal(jobs.jobsRoot(d), path.join(d, 'jobs'), 'jobsRoot is <dataDir>/jobs');
        const { id, dir } = jobs.createJobDirs(d);
        assert.match(id, /^bld_[0-9a-f]{16}$/, 'createJobDirs mints a well-shaped id');
        assert.equal(jobs.jobDir(d, id), path.join(d, 'jobs', id), 'jobDir is <dataDir>/jobs/<id>');
        assert.equal(dir, jobs.jobDir(d, id), 'the returned dir is the job directory itself');
        assert.ok(fs.statSync(path.join(dir, 'project')).isDirectory(), 'project/ exists');
        assert.ok(fs.statSync(path.join(dir, 'out')).isDirectory(), 'out/ exists');
        const second = jobs.createJobDirs(d);
        assert.notEqual(second.id, id, 'two jobs never share an id');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('tailString keeps the LAST 8000 characters, prefixes an ellipsis only when it cuts', async () => {
    const jobs = await loadJobs();
    assert.equal(jobs.LOG_TAIL_BYTES, 8000, 'the documented tail size');
    const short = 'build ok\nstep 2 done\n';
    assert.equal(jobs.tailString(short), short, 'short strings pass through untouched, no ellipsis');
    const exact = 'x'.repeat(jobs.LOG_TAIL_BYTES);
    assert.equal(jobs.tailString(exact), exact, 'exactly LOG_TAIL_BYTES chars is not a cut');
    const head = 'HEAD-MARKER';
    const long = head + 'a'.repeat(jobs.LOG_TAIL_BYTES - head.length) + 'TAILZ'; // 8005 chars
    const kept = jobs.tailString(long);
    assert.equal(kept.length, jobs.LOG_TAIL_BYTES + 1, 'ellipsis + LOG_TAIL_BYTES chars');
    assert.ok(kept.startsWith('…'), 'the cut is marked with a leading ellipsis');
    assert.ok(kept.endsWith('TAILZ'), 'the tail end survives');
    assert.ok(!kept.includes(head), 'the head is what gets dropped');
    assert.equal(kept.slice(1), long.slice(-jobs.LOG_TAIL_BYTES), 'kept is exactly the ellipsis + last LOG_TAIL_BYTES chars');
    assert.equal(jobs.tailString('abcdef', 3), '…def', 'the window size is a parameter');
    assert.equal(jobs.tailString(''), '', 'empty in, empty out');
    assert.equal(jobs.tailString(null), '', 'null coerces to the empty string');
});

test('tailString accepts a Buffer and counts characters, not bytes', async () => {
    const jobs = await loadJobs();
    const short = 'log line\n';
    assert.equal(jobs.tailString(Buffer.from(short, 'utf8')), short, 'a short Buffer is decoded as utf8');
    const long = 'HEAD-MARKER' + 'a'.repeat(jobs.LOG_TAIL_BYTES + 100);
    assert.equal(jobs.tailString(Buffer.from(long, 'utf8')), jobs.tailString(long),
        'a long Buffer truncates exactly like its decoded string');
    const accents = 'é'.repeat(jobs.LOG_TAIL_BYTES); // 16000 utf8 bytes but 8000 characters
    assert.equal(jobs.tailString(Buffer.from(accents, 'utf8')), accents,
        'LOG_TAIL_BYTES names bytes but the window is measured in characters');
});

test('deleteJob removes the job directory recursively; an unknown id is a silent no-op', async () => {
    const jobs = await loadJobs();
    const d = makeTempDir();
    try {
        const { id, dir } = jobs.createJobDirs(d);
        jobs.writeMeta(d, { id, status: 'done' });
        fs.writeFileSync(path.join(dir, 'out', 'demo.mp4'), 'not really an mp4');
        jobs.deleteJob(d, id);
        assert.equal(fs.existsSync(dir), false, 'job.json, out/ and everything under <id>/ is gone');
        jobs.deleteJob(d, id); // run the state-changing call twice (discipline rule 5): force makes it idempotent
        assert.equal(fs.existsSync(dir), false, 'deleting a second time stays a no-op');
        const survivor = jobs.createJobDirs(d);
        jobs.deleteJob(d, 'bld_missing');
        assert.ok(fs.statSync(survivor.dir).isDirectory(), 'an unknown id removes nothing that exists');
        jobs.deleteJob(path.join(d, 'no-jobs-root'), 'bld_missing'); // even the jobs root itself is absent
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
