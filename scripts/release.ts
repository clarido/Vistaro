#!/usr/bin/env tsx
/**
 * One-command release: bump package.json, commit, tag, and push main and the tag together.
 *
 *   npm run release -- 3.0.1             # check, bump, commit, tag, push
 *   npm run release -- 3.0.1 --dry-run   # check everything and print the plan; change nothing
 *
 * The push is the whole release: on main it deploys vistaro.dev, and the v* tag makes CI publish the
 * version to npm once the test job passes (.github/workflows/test.yml, jobs deploy-website and
 * release; the release job also refuses a tag that does not match package.json). The full suite is
 * CI's job; this runs only the checks npm publish itself would run (prepublishOnly: tsc + docs:check),
 * so a release that cannot publish fails here rather than after the push.
 *
 * Everything that could refuse is checked before anything is written, and --atomic means main and
 * the tag reach the remote together or not at all: a deploy without its publish is never left behind.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';

/** A push or fetch that waits on credentials must fail rather than hang the terminal. */
const GIT_TIMEOUT_MS = 120_000;
/** prepublishOnly is tsc + docs:check: about a minute on a cold cache. */
const CHECK_TIMEOUT_MS = 600_000;

function git(args: string[]): string {
    return execFileSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fail(message: string): never {
    console.error(`release: ${message}`);
    process.exit(1);
}

function parse(v: string): number[] | null {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? m.slice(1).map(Number) : null;
}

function isNewer(a: number[], b: number[]): boolean {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

/** Rewrite one JSON file's version fields in place, keeping its two-space layout and final newline. */
function setVersion(file: string, version: string, lockfile: boolean): void {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    json.version = version;
    if (lockfile && json.packages && json.packages['']) json.packages[''].version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
}

export function main(argv: string[]): void {
    const dryRun = argv.includes('--dry-run');
    const version = argv.find(a => !a.startsWith('--'));
    const next = version ? parse(version) : null;
    if (!version || !next) fail('usage: npm run release -- <major.minor.patch> [--dry-run]');

    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const current = parse(String(pkg.version));
    if (!current || !isNewer(next, current)) fail(`${version} is not newer than package.json's ${pkg.version}`);
    const tag = `v${version}`;

    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== 'main') fail(`releases go out from main, and this is ${branch}`);
    if (git(['status', '--porcelain'])) fail('the working tree has uncommitted changes: commit or stash them first, so the release commit holds only the version bump');
    git(['fetch', '--quiet', 'origin', 'main']);
    const behind = git(['rev-list', '--count', 'HEAD..origin/main']);
    if (behind !== '0') fail(`main is ${behind} commit(s) behind origin/main: pull first`);
    if (git(['tag', '-l', tag])) fail(`tag ${tag} already exists here`);
    if (git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail(`tag ${tag} already exists on origin`);

    if (pkg.scripts && pkg.scripts.prepublishOnly) {
        console.log(`release: running the publish checks (prepublishOnly: ${pkg.scripts.prepublishOnly})`);
        try { execFileSync('npm', ['run', '--silent', 'prepublishOnly'], { stdio: 'inherit', timeout: CHECK_TIMEOUT_MS }); }
        catch { fail('the publish checks failed: fix them before releasing'); }
    }

    const hasLock = fs.existsSync('package-lock.json');
    const plan = [
        `bump package.json${hasLock ? ' and package-lock.json' : ''} ${pkg.version} → ${version}`,
        `commit "Vistaro ${version}"`,
        `tag ${tag}`,
        `git push --atomic origin main ${tag}   (main deploys vistaro.dev; the tag publishes ${version} to npm after CI's tests)`,
    ];
    if (dryRun) {
        console.log(`release --dry-run: every check passed; would:\n${plan.map(p => `  - ${p}`).join('\n')}`);
        return;
    }

    setVersion('package.json', version, false);
    const files = ['package.json'];
    if (hasLock) { setVersion('package-lock.json', version, true); files.push('package-lock.json'); }
    git(['add', '--', ...files]);
    git(['commit', '--quiet', '-m', `Vistaro ${version}`, '--', ...files]);
    git(['tag', '-a', tag, '-m', `Vistaro ${version}`]);
    git(['push', '--atomic', '--quiet', 'origin', 'main', tag]);
    console.log(`release: pushed main and ${tag}.\n${plan.map(p => `  - ${p}`).join('\n')}\nWatch it: https://github.com/clarido/Vistaro/actions`);
}

if (require.main === module) main(process.argv.slice(2));
