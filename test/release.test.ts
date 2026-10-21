import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { assertRan, CLI_TIMEOUT_MS } from './assert-ran';

// `npm run release` bumps, commits, tags and pushes main + the tag in one --atomic push. It is run
// here against a throwaway clone whose origin is a local bare repository, never the real remote.
const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'release.ts');
// --import resolves from the child's cwd, a throwaway folder with no node_modules: use the repo's tsx.
const tsx = pathToFileURL(require.resolve('tsx')).href;
let tmp: string;
let origin: string;
let work: string;

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 }).trim();
const release = (args: string[]) => {
    const res = spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: work, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    return res;
};
const version = () => JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version;

before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-release-'));
    origin = path.join(tmp, 'origin.git');
    work = path.join(tmp, 'work');
    git(tmp, ['init', '--quiet', '--bare', '-b', 'main', origin]);
    git(tmp, ['init', '--quiet', '-b', 'main', work]);
    git(work, ['config', 'user.name', 'Release Test']);
    git(work, ['config', 'user.email', 'release@test.invalid']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    git(work, ['config', 'tag.gpgsign', 'false']);
    git(work, ['remote', 'add', 'origin', origin]);
    // No prepublishOnly script: the release's fast checks are skipped, as for any package without one.
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }, null, 2) + '\n');
    fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({ name: 'demo', version: '1.2.3', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.2.3' } } }, null, 2) + '\n');
    git(work, ['add', '.']);
    git(work, ['commit', '--quiet', '-m', 'start']);
    git(work, ['push', '--quiet', '-u', 'origin', 'main']);
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test('release refuses a malformed or non-increasing version, and a dirty tree, before writing anything', () => {
    let res = release(['3.1']);
    assert.equal(res.status, 1); assert.match(res.stderr, /usage: npm run release -- <major\.minor\.patch>/);
    res = release(['1.2.3']);
    assert.equal(res.status, 1); assert.match(res.stderr, /1\.2\.3 is not newer than package\.json's 1\.2\.3/);
    fs.writeFileSync(path.join(work, 'stray.txt'), 'x');
    try {
        res = release(['1.2.4']);
        assert.equal(res.status, 1); assert.match(res.stderr, /uncommitted changes/);
    } finally { fs.rmSync(path.join(work, 'stray.txt')); }
    assert.equal(version(), '1.2.3', 'nothing was bumped');
    assert.equal(git(work, ['tag', '-l']), '', 'nothing was tagged');
});

test('release --dry-run checks everything, prints the plan, and changes nothing', () => {
    const head = git(work, ['rev-parse', 'HEAD']);
    const res = release(['1.2.4', '--dry-run']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /would:[\s\S]*1\.2\.3 → 1\.2\.4[\s\S]*tag v1\.2\.4[\s\S]*git push --atomic origin main v1\.2\.4/);
    assert.equal(version(), '1.2.3');
    assert.equal(git(work, ['rev-parse', 'HEAD']), head, 'no commit');
    assert.equal(git(work, ['tag', '-l']), '', 'no tag');
});

test('release bumps package.json and the lockfile, commits, tags, and pushes main and the tag together', () => {
    const res = release(['1.2.4']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(version(), '1.2.4');
    const lock = JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8'));
    assert.deepEqual([lock.version, lock.packages[''].version], ['1.2.4', '1.2.4'], 'the lockfile root follows');
    assert.equal(git(work, ['log', '-1', '--format=%s']), 'Vistaro 1.2.4');
    const head = git(work, ['rev-parse', 'HEAD']);
    assert.equal(git(origin, ['rev-parse', 'main']), head, 'origin main is the release commit');
    assert.equal(git(origin, ['rev-parse', 'v1.2.4^{commit}']), head, 'origin has the tag, on that commit');
    // The same version again: the tag exists now, so it is refused rather than re-pushed.
    const again = release(['1.2.4']);
    assert.equal(again.status, 1);
});
