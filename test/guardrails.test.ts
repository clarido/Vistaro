import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Canary for the agent-guardrails lot (docs/testing-discipline.md, Known gap 2 — the gap this
 * lot closed: "no hook that type-checks the files an agent edits; no guard against commits
 * without a pathspec...; no pre-push check"). Four blocks, and per rule 3 every assertion runs
 * through the same oracle its self-tests call — the oracles below take their inputs as
 * parameters, so the planted self-tests exercise exactly what the real assertions run.
 *
 *   A. SHIPPED-HOOK INTEGRITY — every hook the wiring names exists, is executable and starts
 *      with a #!/usr/bin/env node shebang (the bin/screenshot-animator.mjs precedent); the
 *      typecheck hook checks types and never edits them; every spawning script names its own
 *      timeout budget (AGENTS.md, «Nothing in a run may wait forever», made greppable);
 *      package.json grows no npm-install-time hook wiring.
 *   B. LIVE-FILE EQUALITY — if JF activated the guardrails (cp example → settings.json), the
 *      live file must equal the example; absent is a legitimate shipped state.
 *   C. DOCS-REFS REALITY — every path-like token the three docs quote either exists on disk
 *      (KNOWN_DOCS_REFS) or is a deliberately classified output/illustration (NOT_REPO_REFS);
 *      both directions red, and empty discovery reds instead of passing vacuously. Every
 *      command token (npm run <key>, npx tsx <file>, node <file>) resolves live against
 *      package.json and the working tree.
 *   D. SELF-TESTS + GUARD SELF-TESTS — planted shapes through the same oracles, then the real
 *      guards spawned end-to-end with planted stdin (deny / allow / ask / fail-open matrix)
 *      and the pre-push hook's --dry-run, pinning the fast tier and the suite's absence.
 *
 * Rule-4 mutation proofs were run at implementation time against the shipped scripts (drop the
 * commit pathspec check → the deny test reds; unwrap the guard's try/catch → the garbage-stdin
 * test reds; remove a hook file → integrity reds; plant a full-suite stage → the dry-run test
 * reds), each restored from a cp backup.
 *
 * Shipped home: `.githooks/claude/`, not `.claude/` — `.claude/` is gitignored (Claude Code's
 * local-data directory: commands, skills, the activated settings.json), so scripts and the
 * example parked there never reach a clone while this canary and CI still assert them. The
 * example is copied INTO `.claude/` only at activation time (the gitignored live file). The
 * discipline doc's guardrails rows name these shipped paths, and the C ratchet reded exactly as
 * designed until they were classified — the five shipped files joined KNOWN_DOCS_REFS below,
 * and `.claude/settings.json` joined NOT_REPO_REFS (the shipped repo must NOT contain it:
 * «nothing is live», discipline.md; block B audits it only once JF's activation creates it).
 */

const root = path.resolve(__dirname, '..');
const EXAMPLE = path.join(root, '.githooks', 'claude', 'settings.example.json');
const LIVE_SETTINGS = path.join(root, '.claude', 'settings.json'); // the activated copy: gitignored, absent until JF activates
const GUARD = path.join(root, '.githooks', 'claude', 'pre-tool-use-guard.mjs');
const TYPECHECK = path.join(root, '.githooks', 'claude', 'post-tool-use-typecheck.mjs');
const PRE_PUSH = path.join(root, '.githooks', 'pre-push');
const PACKAGE = path.join(root, 'package.json');
const DOCS: ReadonlyArray<string> = ['CLAUDE.md', 'AGENTS.md', 'docs/testing-discipline.md'];

// Per spawned hook run. These windows name .githooks/claude/… and .githooks/pre-push, never
// cli.ts, so they classify as nothing in spawn-bounds' KNOWN_SITES — the same
// classify-as-nothing rule as its ffmpeg probes (the count there drifts; its list carries it).
const HOOK_TIMEOUT_MS = 30000;

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };
type SettingsShape = { hooks?: Record<string, HookEntry[]> };
type Doc = { name: string; text: string };
type KnownRef = { token: string; at: string; why: string };
type NotRepoRef = { token: string; why: string };

// ---------------------------------------------------------------------------
// Block A oracles
// ---------------------------------------------------------------------------

function readExampleSettings(): SettingsShape {
    assert.ok(fs.existsSync(EXAMPLE), 'the guardrails lot shipped .githooks/claude/settings.example.json; without it the hooks have no wiring — restore it');
    return JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as SettingsShape;
}

/** Every hooks[].command in the wiring, and red when there is none (rule 3: an emptied or
 *  reshaped wiring must not pass as "nothing to check"). */
function hookCommands(settings: SettingsShape): string[] {
    const commands: string[] = [];
    for (const entries of Object.values(settings.hooks ?? {})) {
        for (const entry of Array.isArray(entries) ? entries : []) {
            for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
                if (typeof hook?.command === 'string' && hook.command.length > 0) commands.push(hook.command);
            }
        }
    }
    assert.ok(commands.length >= 1, 'discovery found no hook commands in the wiring — hooks was emptied or the shape changed; an empty scan must not pass');
    return commands;
}

function firstLineOf(abs: string): string {
    return fs.readFileSync(abs, 'utf8').split('\n')[0] ?? '';
}

/** Integrity of every wired hook, against `base` so the self-tests can plant a tree. */
function integrityProblems(base: string, settings: SettingsShape): string[] {
    const problems: string[] = [];
    for (const command of hookCommands(settings)) {
        const rel = command.replace(/^\$CLAUDE_PROJECT_DIR\/?/, '');
        const abs = path.resolve(base, rel);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(abs);
        } catch {
            problems.push(`${rel}: named by the wiring but not on disk — restore the file the example ships`);
            continue;
        }
        if (!stat.isFile()) problems.push(`${rel}: not a regular file`);
        if (!(stat.mode & 0o100)) problems.push(`${rel}: not executable — chmod +x it, the harness cannot run a hook without its exec bit`);
        if (stat.isFile() && firstLineOf(abs) !== '#!/usr/bin/env node') {
            problems.push(`${rel}: first line is not "#!/usr/bin/env node" — hooks ship a node shebang (bin/screenshot-animator.mjs precedent)`);
        }
    }
    return problems;
}

/** npm lifecycle scripts that would wire hooks behind JF's back. */
const WIRING_SCRIPTS: ReadonlyArray<string> = ['prepare', 'preprepare', 'postprepare', 'preinstall', 'install', 'postinstall', 'prepush', 'postpush'];

function hookWiringProblems(pkg: { scripts?: Record<string, unknown> }): string[] {
    assert.ok(pkg.scripts && typeof pkg.scripts === 'object', 'package.json carries no scripts object — it was deleted or corrupted');
    return WIRING_SCRIPTS.filter((key) => typeof pkg.scripts?.[key] === 'string').map((key) =>
        `package.json has a "${key}" script — npm install must never wire hooks on its own; activation is JF's "git config core.hooksPath .githooks" one-liner`);
}

/** The add-a-spawn-add-a-bound rule, greppable: each budget constant declared once as a number
 *  and used at least once more (on the spawn it bounds). */
function budgetProblems(file: string, text: string, constants: ReadonlyArray<string>): string[] {
    return constants.flatMap((name) => {
        if (!new RegExp(`const\\s+${name}\\s*=\\s*\\d+`).test(text)) {
            return [`${file}: budget constant ${name} is not declared as a number — every spawn carries its bound by name (AGENTS.md, «Nothing in a run may wait forever»)`];
        }
        if (text.split(name).length - 1 < 2) {
            return [`${file}: budget constant ${name} is declared but never used — a bound that bounds nothing`];
        }
        return [];
    });
}

// ---------------------------------------------------------------------------
// Block B oracle
// ---------------------------------------------------------------------------

function liveEqualityProblems(base: string): string[] {
    const livePath = path.join(base, '.claude', 'settings.json');
    if (!fs.existsSync(livePath)) return []; // not activated: a legitimate shipped state
    let example: unknown;
    let live: unknown;
    try {
        example = JSON.parse(fs.readFileSync(path.join(base, '.githooks', 'claude', 'settings.example.json'), 'utf8'));
        live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
    } catch (err) {
        return [`reading .claude/settings.json or the shipped example failed: ${(err as Error).message}`];
    }
    try {
        assert.deepStrictEqual(live, example);
        return [];
    } catch {
        return ['a live .claude/settings.json must equal the example: edit the example and copy again; a diverging live file is how guardrails quietly switch off'];
    }
}

// ---------------------------------------------------------------------------
// Block C oracles
// ---------------------------------------------------------------------------

function inlineCode(text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
        const token = m[1].trim();
        if (token) out.push(token);
    }
    return out;
}

const REPO_EXT = /\.(?:ts|js|mjs|cjs|json|md|html|css|yml|yaml|png|gif|webm|vtt|mp3|mp4|aiff)$/;
const REPO_PREFIX = /^(?:src|test|scripts|docs|saas|bin|demo|reels|\.github|\.claude|\.githooks)\//;

/** A backticked token is a path candidate when it names a file shape: a repo extension, a
 *  slash-path under a repo tree, a directory or glob mention, a dotfile, or a URL. Placeholders
 *  (<dir>), selectors (#id, [data-help]) and multi-word prose are out by shape. A trailing
 *  :12-34 line reference is stripped — it names the file. */
function pathCandidate(raw: string): string | null {
    const token = raw.replace(/:\d+(?:-\d+)?$/, '');
    if (/[<>"\s(){}[\]]/.test(token)) return null;
    if (/^https?:\/\//.test(token)) return token;
    if (/^\.[\w.-]+$/.test(token)) return token;
    if (token.endsWith('/')) return token;
    if (token.includes('*')) return token;
    if (REPO_EXT.test(token)) return token;
    if (REPO_PREFIX.test(token)) return token;
    return null;
}

function readDocs(): Doc[] {
    return DOCS.map((name) => ({ name, text: fs.readFileSync(path.join(root, name), 'utf8') }));
}

function discoverDocRefs(docs: ReadonlyArray<Doc>): string[] {
    return [...new Set(docs.flatMap((d) => inlineCode(d.text)).map(pathCandidate).filter((t): t is string => t !== null))].sort();
}

// Every repo file the docs quote, with the AGENTS.md/discipline line that names it. The `at`
// path is what must exist; bare names (schema.ts, media/ffmpeg.ts) resolve where the docs' own
// context puts them (Layout for engine files, the src-sync row for media/).
const KNOWN_DOCS_REFS: ReadonlyArray<KnownRef> = [
    { token: '.github/workflows', at: '.github/workflows', why: 'discipline.md CI row: «reads every .yml under .github/workflows»' },
    { token: '.github/workflows/test.yml', at: '.github/workflows/test.yml', why: 'AGENTS.md contributor notes: CI runs the three checks on every push' },
    { token: '.githooks/claude/', at: '.githooks/claude', why: 'discipline.md known gap 2: the shipped home of the Claude Code tier — .claude/ is gitignored local data' },
    { token: '.githooks/claude/post-tool-use-typecheck.mjs', at: '.githooks/claude/post-tool-use-typecheck.mjs', why: 'discipline.md guardrails row: the whole-project `npx tsc --noEmit` after a TypeScript edit' },
    { token: '.githooks/claude/pre-tool-use-guard.mjs', at: '.githooks/claude/pre-tool-use-guard.mjs', why: 'discipline.md guardrails row: the Bash guard — denies a bare commit and stash, asks before push/merge/branch, fails open' },
    { token: '.githooks/claude/settings.example.json', at: '.githooks/claude/settings.example.json', why: 'discipline.md canary + guardrails + ACTIVATION rows: the shipped hook wiring the guardrails canary audits' },
    { token: '.githooks/pre-push', at: '.githooks/pre-push', why: 'discipline.md guardrails row: the pre-push tier (tsc + docs:check + the twelve static canaries, never the suite)' },
    { token: 'anim-tour.js', at: 'src/tour/app/anim-tour.js', why: 'AGENTS.md Layout / Tours: the <anim-tour> custom element shipped by tour --embed' },
    { token: 'app.css', at: 'src/tour/app/app.css', why: 'AGENTS.md Tours output: the tour shell assets copied verbatim' },
    { token: 'app.js', at: 'src/tour/app/app.js', why: 'AGENTS.md Tours output: the tour shell assets copied verbatim' },
    { token: 'build-all.ts', at: 'src/commands/build-all.ts', why: 'AGENTS.md bounds note: CHILD_TIMEOUT_MS lives there' },
    { token: 'buildall.test.ts', at: 'test/buildall.test.ts', why: 'discipline.md OUTPUT_REVISION row: buildKeyFor assertions' },
    { token: 'cli.ts', at: 'cli.ts', why: 'AGENTS.md Layout: the commander program' },
    { token: 'commands/build-all.ts', at: 'src/commands/build-all.ts', why: 'discipline.md async-spawn row: the single known runCli site' },
    { token: 'docs/testing-discipline.md', at: 'docs/testing-discipline.md', why: 'CLAUDE.md import + AGENTS.md contributor notes' },
    { token: 'driver.ts', at: 'src/engine/driver.ts', why: 'AGENTS.md Layout: drives a Playwright page (stepTimeoutMs note)' },
    { token: 'embed.html', at: 'src/tour/app/embed.html', why: 'AGENTS.md Layout: the solo-mode page template shipped by --embed' },
    { token: 'fixtures/', at: 'test/fixtures', why: 'discipline.md/plain-browser-js: the scan never recurses into fixtures/' },
    { token: 'help.catalog.json', at: 'help.catalog.json', why: 'AGENTS.md Catalog and build-all section' },
    { token: 'inject.ts', at: 'src/engine/inject.ts', why: 'AGENTS.md Layout: builds animated.html' },
    { token: 'jobs.js', at: 'saas/lib/jobs.js', why: 'discipline.md SaaS row: unit-tested by saas-jobs.test.ts' },
    { token: 'learn.test.ts', at: 'test/learn.test.ts', why: 'discipline.md spawn-bounds row: one of the CLI-spawn files' },
    { token: 'media/ffmpeg.ts', at: 'src/media/ffmpeg.ts', why: 'AGENTS.md bounds note: FFMPEG_TIMEOUT_MS (10 min)' },
    { token: 'media/tts.ts', at: 'src/media/tts.ts', why: 'AGENTS.md bounds note: SAY_TIMEOUT_MS (60 s)' },
    { token: 'project.js', at: 'saas/lib/project.js', why: 'discipline.md known gaps: no dedicated unit test yet' },
    { token: 'queue.js', at: 'saas/lib/queue.js', why: 'discipline.md SaaS row: unit-tested by saas-queue.test.ts' },
    { token: 'record.test.ts', at: 'test/record.test.ts', why: 'discipline.md orphan row: the wrapped Chromium owner' },
    { token: 'reels/ask-anything/locales/fr', at: 'reels/ask-anything/locales/fr', why: 'AGENTS.md Localization: the worked reel-locale example' },
    { token: 'reset.ts', at: 'src/reset.ts', why: 'discipline.md src-sync row: one of the 3 bounded sync-spawn sites' },
    { token: 'runtime.js', at: 'src/engine/runtime.js', why: 'AGENTS.md Layout: the in-page engine injected as text' },
    { token: 'saas/lib', at: 'saas/lib', why: 'discipline.md SaaS row: the lib modules' },
    { token: 'saas/lib/auth.js', at: 'saas/lib/auth.js', why: 'discipline.md SaaS row: unit-tested by saas-auth.test.ts' },
    { token: 'saas/lib/httputil.js', at: 'saas/lib/httputil.js', why: 'discipline.md known gaps: no dedicated unit test yet' },
    { token: 'saas/server.js', at: 'saas/server.js', why: 'discipline.md rule 5: a real HTTP call to saas/server.js' },
    { token: 'saas/smoke.mjs', at: 'saas/smoke.mjs', why: 'discipline.md commands table: the SaaS HTTP contract' },
    { token: 'schema.ts', at: 'src/engine/schema.ts', why: 'AGENTS.md Layout: parsing/validation, source of the mirrored timing constants' },
    { token: 'src/', at: 'src', why: 'discipline.md src-sync row: walks src/ recursively' },
    { token: 'src/browser.ts', at: 'src/browser.ts', why: 'AGENTS.md Layout' },
    { token: 'src/catalog.ts', at: 'src/catalog.ts', why: 'AGENTS.md Layout' },
    { token: 'src/commands/', at: 'src/commands', why: 'AGENTS.md Layout' },
    { token: 'src/engine/', at: 'src/engine', why: 'AGENTS.md Layout' },
    { token: 'src/guide/', at: 'src/guide', why: 'AGENTS.md Layout: capture, render, diff' },
    { token: 'src/manifest.ts', at: 'src/manifest.ts', why: 'AGENTS.md Layout' },
    { token: 'src/media/', at: 'src/media', why: 'AGENTS.md Layout: ffmpeg, tts, vtt, chapters, contact sheet' },
    { token: 'src/tour/app/', at: 'src/tour/app', why: 'AGENTS.md Layout: the tour shell copied verbatim' },
    { token: 'stripe.js', at: 'saas/lib/stripe.js', why: 'discipline.md SaaS row: billing answers 501 without Stripe' },
    { token: 'studio.test.ts', at: 'test/studio.test.ts', why: 'discipline.md spawn-bounds row: one of the CLI-spawn files' },
    { token: 'test/', at: 'test', why: 'scan-source.ts header: the runner glob, siblings of the canaries' },
    { token: 'test/assert-ran.ts', at: 'test/assert-ran.ts', why: 'discipline.md spawn-bounds row: the one shared spawn helper' },
    { token: 'test/browser.test.ts', at: 'test/browser.test.ts', why: 'discipline.md overflow-clip row: the behavioral pin at :1136-1145' },
    { token: 'test/buildall.test.ts', at: 'test/buildall.test.ts', why: 'discipline.md: :113-115 pins OUTPUT_REVISION in the build key' },
    { token: 'test/ci-workflow.test.ts', at: 'test/ci-workflow.test.ts', why: 'discipline.md CI row' },
    { token: 'test/cli-force-exit.test.ts', at: 'test/cli-force-exit.test.ts', why: 'discipline.md force-exit row' },
    { token: 'test/constants.test.ts', at: 'test/constants.test.ts', why: 'AGENTS.md contributor notes: the mirrored timing constants' },
    { token: 'test/docs.test.ts', at: 'test/docs.test.ts', why: 'discipline.md CLI-reference row' },
    { token: 'test/fixtures/basic/', at: 'test/fixtures/basic', why: 'AGENTS.md Tests: the mockup fixture with every action' },
    { token: 'test/fixtures/controlled/', at: 'test/fixtures/controlled', why: 'AGENTS.md Tests: the controlled-input fixture, served at /controlled' },
    { token: 'test/fixtures/live-app/server.ts', at: 'test/fixtures/live-app/server.ts', why: 'AGENTS.md Tests: the record fixture with /once' },
    { token: 'test/guardrails.test.ts', at: 'test/guardrails.test.ts', why: 'discipline.md canary + guardrails rows: this lot’s canary, watched before and after activation' },
    { token: 'test/orphans.test.ts', at: 'test/orphans.test.ts', why: 'discipline.md orphan row: the counter self-test' },
    { token: 'test/orphans.ts', at: 'test/orphans.ts', why: 'discipline.md orphan row: countOrphans/assertNoNewOrphans' },
    { token: 'test/page-callback-purity.test.ts', at: 'test/page-callback-purity.test.ts', why: 'discipline.md page.evaluate row' },
    { token: 'test/plain-browser-js.test.ts', at: 'test/plain-browser-js.test.ts', why: 'discipline.md plain-browser-JS row' },
    { token: 'test/saas-auth.test.ts', at: 'test/saas-auth.test.ts', why: 'discipline.md SaaS row' },
    { token: 'test/saas-jobs.test.ts', at: 'test/saas-jobs.test.ts', why: 'discipline.md SaaS row' },
    { token: 'test/saas-queue.test.ts', at: 'test/saas-queue.test.ts', why: 'discipline.md SaaS row' },
    { token: 'test/saas-stripe.test.ts', at: 'test/saas-stripe.test.ts', why: 'discipline.md SaaS row' },
    { token: 'test/scan-source.ts', at: 'test/scan-source.ts', why: 'discipline.md rows: the shared comment-stripping reader' },
    { token: 'test/serial-suite.test.ts', at: 'test/serial-suite.test.ts', why: 'discipline.md serial-suite row' },
    { token: 'test/spawn-bounds.test.ts', at: 'test/spawn-bounds.test.ts', why: 'discipline.md spawn-bounds row: the site-list identity' },
    { token: 'test/spotlight-rect.test.ts', at: 'test/spotlight-rect.test.ts', why: 'discipline.md spotlight-rect row' },
    { token: 'test/src-async-spawn-bound.test.ts', at: 'test/src-async-spawn-bound.test.ts', why: 'discipline.md async-spawn row' },
    { token: 'test/src-spawn-bounds.test.ts', at: 'test/src-spawn-bounds.test.ts', why: 'discipline.md src-sync row' },
    { token: 'tour-bridge.js', at: 'src/engine/tour-bridge.js', why: 'AGENTS.md Layout: the message-driven tour scheduler' },
    { token: 'tour.catalog.json', at: 'tour.catalog.json', why: 'AGENTS.md Tours section' },
    { token: 'verify.test.ts', at: 'test/verify.test.ts', why: 'discipline.md spawn-bounds row: one of the CLI-spawn files' },
    { token: 'zip.js', at: 'saas/lib/zip.js', why: 'discipline.md known gaps: no dedicated unit test yet' },
];

// Every quoted token that is an output or an illustration rather than a repo file, each with
// its reason. A new unclassified token reds the ratchet until it is placed here deliberately.
const NOT_REPO_REFS: ReadonlyArray<NotRepoRef> = [
    { token: '*', why: 'a bare wildcard fragment (guide.* context), not a path' },
    { token: '../demo-step-02.mp4', why: 'guide.json example: a clip path relative to the guide/ output tree' },
    { token: '.aiff', why: 'a file-extension illustration (macOS say narration), not a file' },
    { token: '.btn-primary', why: 'a CSS selector from the mockup docs (resetFocusStyles), not a path' },
    { token: '.catch', why: 'a JavaScript method fragment quoted in prose, not a path' },
    { token: '.claude', why: 'the gitignored local-data directory itself (.gitignore:17 — settings.local.json, commands, skills) — nothing in it ships; absent on a fresh clone' },
    { token: '.claude/', why: 'the gitignored local-data directory, named as a directory in known gap 2 — nothing in it ships; the example lands in .githooks/claude/ instead and is copied here only at activation' },
    { token: '.claude/settings.json', why: 'the activated wiring — must NOT exist in the shipped repo («nothing is live», discipline.md); block B audits it only once JF’s activation creates it' },
    { token: '.env', why: 'the dotenv secrets file — lives outside the repo by design (.gitignore)' },
    { token: '.finally', why: 'a JavaScript method fragment quoted in prose, not a path' },
    { token: '.gif', why: 'a file-extension illustration, not a file' },
    { token: '.input', why: 'a CSS selector from the mockup docs (resetFocusStyles), not a path' },
    { token: '.vtt', why: 'a file-extension illustration, not a file' },
    { token: '/', why: 'the path-separator literal (outputDir may not be /), not a path' },
    { token: '/v1/*', why: 'the SaaS API path pattern, a URL illustration' },
    { token: 'anim.config.json', why: 'an authored per-demo timeline — lives inside demo/fixture dirs, never at the repo root' },
    { token: 'anim.manifest.json', why: 'generated: the per-demo manifest every command appends to' },
    { token: 'animated.html', why: 'generated: build output (a full copy of runtime.js each time)' },
    { token: 'ask-anything-en-mobile.mp4', why: 'illustration: a device-expanded reel filename from the catalog docs' },
    { token: 'assets/', why: 'generated: the guide assets directory' },
    { token: 'assets/step-NN.mp3', why: 'generated: per-step narration audio under guide assets/' },
    { token: 'clip.gif', why: 'generated: a reel output beside the video' },
    { token: 'clip.poster.png', why: 'generated: a reel output beside the video' },
    { token: 'clip.webm', why: 'generated: a reel output beside the video' },
    { token: 'demo.strip.png', why: 'generated: the filmstrip contact sheet' },
    { token: 'demo.vtt', why: 'generated: the exported subtitles' },
    { token: 'embed-mobile.html', why: 'generated: a build --embed page (device-suffixed by design)' },
    { token: 'file://', why: 'a URL scheme illustration, not a path' },
    { token: 'guide.*', why: 'generated: the guide outputs, named as a glob' },
    { token: 'guide.html', why: 'generated: a guide output' },
    { token: 'guide.json', why: 'generated: a guide output' },
    { token: 'guide.md', why: 'generated: a guide output' },
    { token: 'guide/.previous/', why: 'generated: the --diff previous-frames directory' },
    { token: 'index-desktop.html', why: 'generated: a tour device page' },
    { token: 'index-mobile.html', why: 'generated: a tour device page' },
    { token: 'index.html', why: 'the authored demo screen — one per demo/fixture/locale directory; the tour shell has its own src/tour/app/index.html that no doc names' },
    { token: 'index.json', why: 'generated: the build-all merged index' },
    { token: 'index.md', why: 'generated: the build-all merged index' },
    { token: 'locales/fr/index.html', why: 'illustration: the localized screen scaffold path' },
    { token: 'output.mp4', why: 'generated: the default -o video' },
    { token: 'preview-motion.png', why: 'generated: the preview --motion sheet' },
    { token: 'preview-step-N.png', why: 'generated: a preview --step frame' },
    { token: 'scenarios/export-word.json', why: 'illustration: a tour scenario timeline from the catalog example' },
    { token: 'scenarios/export-word.strings.fr.json', why: 'illustration: that scenario\'s strings file' },
    { token: 'step-NN.diff.png', why: 'generated: a --diff frame image' },
    { token: 'strings.*.json', why: 'locale strings files — authored inside demo dirs, named as a glob' },
    { token: 'strings.fr.json', why: 'locale strings files — authored inside demo dirs' },
    { token: 'test/*.test.ts', why: 'the runner glob notation, not a file' },
    { token: 'tours.json', why: 'generated: the tour build data the shell fetches' },
];

// Repo files the docs do not quote (named bare, or named only by this lot) that must exist
// anyway. The new guardrail files themselves are pinned harder by block A (exec bit + shebang).
const REPO_INFRA: ReadonlyArray<{ at: string; why: string }> = [
    { at: 'scripts/gen-cli-reference.ts', why: 'the file behind the docs / docs:check scripts the command oracle resolves' },
    { at: 'bin/screenshot-animator.mjs', why: 'the repo precedent for node-shebang executables, cited by the hooks' },
    { at: 'demo', why: 'AGENTS.md tours: «demo is the worked example» — named bare, so the path scan never sees it' },
];

/** The ratchet direction: every token the given docs quote must be classified. Plant-able —
 *  the self-tests pass synthetic docs, so nothing here may consult the real lists' coverage. */
function unclassifiedRefs(docs: ReadonlyArray<Doc>): string[] {
    const found = discoverDocRefs(docs);
    assert.ok(found.length >= 1, 'discovery found no path-like refs in the docs — the extractor or the docs broke; an empty scan must not pass vacuously');
    const known = new Map(KNOWN_DOCS_REFS.map((e) => [e.token, e]));
    const not = new Map(NOT_REPO_REFS.map((e) => [e.token, e]));
    return found
        .filter((token) => !known.has(token) && !not.has(token))
        .map((token) => `'${token}' is quoted in the docs but classified nowhere: add it to KNOWN_DOCS_REFS (a repo file that must exist, with the doc line that names it) or to NOT_REPO_REFS (an output or illustration, with a reason) — a new unclassified ref reds the ratchet until placed deliberately`);
}

/** The identity direction: every classified token is still quoted by the real docs. Only
 *  meaningful against the full real docs (a plant would flag all 100+ entries). */
function staleListEntries(docs: ReadonlyArray<Doc>): string[] {
    const found = new Set(discoverDocRefs(docs));
    return [
        ...KNOWN_DOCS_REFS.filter((e) => !found.has(e.token)).map((e) => `KNOWN_DOCS_REFS lists '${e.token}' but no doc quotes it any more — drop the entry or restore the doc mention (the lists are an identity, not a quota)`),
        ...NOT_REPO_REFS.filter((e) => !found.has(e.token)).map((e) => `NOT_REPO_REFS lists '${e.token}' but no doc quotes it any more — drop the entry or restore the doc mention`),
    ];
}

/** Existence, independent of any doc text: every KNOWN target and every infra file on disk. */
function missingRefTargets(): string[] {
    return [
        ...KNOWN_DOCS_REFS.filter((entry) => !fs.existsSync(path.join(root, entry.at)))
            .map((entry) => `${entry.at} — the docs name it (${entry.why}) but it is not on disk: add the file or fix the doc`),
        ...REPO_INFRA.filter((entry) => !fs.existsSync(path.join(root, entry.at)))
            .map((entry) => `${entry.at} — repo infrastructure missing: ${entry.why}`),
    ];
}

/** The whole block-C path oracle, as the real test runs it. */
function docsRefProblems(docs: ReadonlyArray<Doc>): string[] {
    return [...unclassifiedRefs(docs), ...staleListEntries(docs), ...missingRefTargets()];
}

/** Every command token the given docs quote, resolved live. Plant-able: no identity counts
 *  here — those live in commandIdentityGuards, run against the real docs only. */
function resolveCommands(docs: ReadonlyArray<Doc>, pkg: { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown> }): string[] {
    assert.ok(pkg.scripts && typeof pkg.scripts === 'object', 'package.json carries no scripts object');
    const joined = docs.map((d) => d.text).join('\n');
    const problems: string[] = [];
    for (const key of new Set([...joined.matchAll(/`npm run ([a-z0-9:@_.-]+)/g)].map((m) => m[1]))) {
        if (typeof pkg.scripts[key] !== 'string') problems.push(`the docs run \`npm run ${key}\` — package.json has no such script`);
    }
    if (/`npm test\b/.test(joined) && typeof pkg.scripts['test'] !== 'string') {
        problems.push('the docs run `npm test` — package.json has no test script');
    }
    if (/`npx tsc\b/.test(joined) && !(pkg.devDependencies && typeof pkg.devDependencies['typescript'] === 'string')) {
        problems.push('the docs run `npx tsc --noEmit` — typescript is not a devDependency');
    }
    for (const target of new Set([
        ...[...joined.matchAll(/`npx tsx ([^\s`<]+)/g)].map((m) => m[1]),
        ...[...joined.matchAll(/`node ([^\s`<]+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('-')),
    ])) {
        if (!fs.existsSync(path.join(root, target))) problems.push(`the docs run it against ${target} — not on disk`);
    }
    return problems;
}

/** Rule-3 guard on the command extractor itself: a doc rewrite that drops a whole command
 *  family reds instead of passing vacuously. Real docs only. */
function commandIdentityGuards(docs: ReadonlyArray<Doc>): void {
    const joined = docs.map((d) => d.text).join('\n');
    assert.ok(/`npm run [a-z0-9:@_.-]+/.test(joined), 'no `npm run <key>` command found in the docs — the command extractor or the docs broke');
    assert.ok(/`npx tsx [^\s`<]+/.test(joined), 'no `npx tsx <file>` command found in the docs');
    assert.ok(/`node [^\s`<]+/.test(joined), 'no `node <file>` command found in the docs');
}

// ---------------------------------------------------------------------------
// Block D oracles: spawn the real guards (every spawn bounded, SIGKILL)
// ---------------------------------------------------------------------------

function runHook(script: string, stdin: string): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync(script, [], {
        input: stdin,
        encoding: 'utf8',
        timeout: HOOK_TIMEOUT_MS,
        killSignal: 'SIGKILL',
    });
    assert.ok(!res.error && !res.signal, `${path.relative(root, script)} did not run to completion (error: ${res.error?.message}, signal: ${res.signal}) — it must answer instantly or fail open`);
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const bashEvent = (command: string): string => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

function withTempDir(fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-canary-'));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const wiringWith = (command: string): SettingsShape => ({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
});

// ---------------------------------------------------------------------------
// Block A — shipped-hook integrity
// ---------------------------------------------------------------------------

test('block A: the wiring references existing, executable, node-shebang hooks', () => {
    const example = readExampleSettings();
    assert.deepEqual(integrityProblems(root, example), [], 'a wired hook is missing, non-executable, or lacks the node shebang');
    // The wiring shape itself: Bash only before a tool runs; Edit/Write/MultiEdit after.
    assert.deepEqual(Object.keys(example.hooks ?? {}).sort(), ['PostToolUse', 'PreToolUse'], 'the example wires exactly PreToolUse and PostToolUse');
    assert.deepEqual((example.hooks?.PreToolUse ?? []).map((e) => e.matcher), ['Bash'], 'PreToolUse matches Bash only — that is the guard\'s whole surface');
    assert.deepEqual((example.hooks?.PostToolUse ?? []).map((e) => e.matcher), ['Edit|Write|MultiEdit'], 'PostToolUse matches the file-editing tools');
    // The pre-push hook ships too, with the same guarantees.
    const prePushStat = fs.statSync(PRE_PUSH);
    assert.ok(prePushStat.isFile() && prePushStat.mode & 0o100, '.githooks/pre-push must exist and be executable (git runs it directly)');
    assert.equal(firstLineOf(PRE_PUSH), '#!/usr/bin/env node', '.githooks/pre-push ships a node shebang');
    // The guard spawns nothing — a pure text analysis needs no budget of its own.
    const guardText = fs.readFileSync(GUARD, 'utf8');
    assert.ok(!guardText.includes('child_process'), 'the guard must not spawn children — it is a pure analysis of the command string');
});

test('block A: the typecheck hook checks types and never edits them', () => {
    const text = fs.readFileSync(TYPECHECK, 'utf8');
    assert.match(text, /--noEmit/, 'the typecheck hook must run tsc in check-only mode');
    assert.ok(!text.includes('--fix'), 'the typecheck hook must never carry an auto-fix flag: it audits, it does not rewrite');
});

test('block A: every spawning script names its own timeout budget', () => {
    const problems = [
        ...budgetProblems('.githooks/claude/post-tool-use-typecheck.mjs', fs.readFileSync(TYPECHECK, 'utf8'), ['TSC_HOOK_TIMEOUT_MS']),
        ...budgetProblems('.githooks/pre-push', fs.readFileSync(PRE_PUSH, 'utf8'), ['STAGE_TSC_MS', 'STAGE_DOCS_MS', 'STAGE_CANARIES_MS']),
    ];
    assert.deepEqual(problems, [], 'a spawn is missing its named bound');
});

test('block A: npm install never wires hooks on its own', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as { scripts?: Record<string, unknown> };
    assert.deepEqual(hookWiringProblems(pkg), [], 'an npm lifecycle script would activate the hooks for everyone on install');
});

// ---------------------------------------------------------------------------
// Block B — live-file equality
// ---------------------------------------------------------------------------

test('block B: an activated .claude/settings.json must equal the example', () => {
    assert.deepEqual(liveEqualityProblems(root), [], 'the live wiring diverged from the shipped example');
});

// ---------------------------------------------------------------------------
// Block C — docs-refs reality
// ---------------------------------------------------------------------------

test('block C: CLAUDE.md is exactly the two @-imports, and both exist', () => {
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    const imports = [...claude.matchAll(/^@(\S+)\s*$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ['AGENTS.md', 'docs/testing-discipline.md'], 'CLAUDE.md is two @-imports (AGENTS.md, docs/testing-discipline.md) — a change re-scopes what every agent reads');
    for (const rel of imports) {
        assert.ok(fs.existsSync(path.join(root, rel)), `CLAUDE.md imports @${rel} — not on disk`);
    }
});

test('block C: every path the docs quote exists, or is a classified output', () => {
    assert.deepEqual(docsRefProblems(readDocs()), [], 'the docs and the repo disagree about what exists');
});

test('block C: every command the docs quote resolves live', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    commandIdentityGuards(readDocs());
    assert.deepEqual(resolveCommands(readDocs(), pkg), [], 'a command the docs quote does not resolve');
});

// ---------------------------------------------------------------------------
// Block D — self-tests through the same oracles (rule 3)
// ---------------------------------------------------------------------------

test('self-test: a planted wiring naming a missing hook reds, naming the path', () => {
    const problems = integrityProblems(root, wiringWith('$CLAUDE_PROJECT_DIR/.githooks/claude/no-such.mjs'));
    assert.equal(problems.length, 1, 'exactly the missing hook must red');
    assert.match(problems[0], /no-such\.mjs/, 'the red names the missing path');
});

test('self-test: a planted empty hooks map reds instead of passing vacuously', () => {
    assert.throws(() => integrityProblems(root, { hooks: {} }), /discovery found no hook commands/);
});

test('self-test: a planted non-executable hook reds; so does a wrong shebang', () => {
    withTempDir((dir) => {
        const hookDir = path.join(dir, '.githooks', 'claude');
        fs.mkdirSync(hookDir, { recursive: true });
        const hookPath = path.join(hookDir, 'fake.mjs');
        fs.writeFileSync(hookPath, '#!/usr/bin/env node\n');
        fs.chmodSync(hookPath, 0o644);
        const problems = integrityProblems(dir, wiringWith('$CLAUDE_PROJECT_DIR/.githooks/claude/fake.mjs'));
        assert.match(problems[0] ?? '', /not executable/, 'a missing exec bit reds by name');

        fs.writeFileSync(path.join(hookDir, 'shy.mjs'), 'console.log(1)\n');
        fs.chmodSync(path.join(hookDir, 'shy.mjs'), 0o755);
        const shy = integrityProblems(dir, wiringWith('$CLAUDE_PROJECT_DIR/.githooks/claude/shy.mjs'));
        assert.match(shy[0] ?? '', /shebang/, 'a missing node shebang reds by name');
    });
});

test('self-test: a planted live file equal passes; one tweaked command reds', () => {
    withTempDir((dir) => {
        const shippedDir = path.join(dir, '.githooks', 'claude');
        const claudeDir = path.join(dir, '.claude');
        fs.mkdirSync(shippedDir, { recursive: true });
        fs.mkdirSync(claudeDir, { recursive: true });
        const example = wiringWith('/opt/hooks/one.mjs');
        fs.writeFileSync(path.join(shippedDir, 'settings.example.json'), JSON.stringify(example));
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(example));
        assert.deepEqual(liveEqualityProblems(dir), [], 'an equal live file is clean');
        fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(wiringWith('/opt/hooks/two.mjs')));
        assert.match(liveEqualityProblems(dir)[0] ?? '', /must equal the example/, 'a diverging live file reds');
    });
});

test('self-test: a planted doc naming a missing src file reds the ratchet; an empty doc reds the identity', () => {
    const problems = unclassifiedRefs([{ name: 'planted.md', text: 'see `src/no-such-file.ts` for details' }]);
    assert.equal(problems.length, 1, 'exactly the unclassified ref must red');
    assert.match(problems[0] ?? '', /src\/no-such-file\.ts/, 'the red names the token');
    assert.match(problems[0] ?? '', /classified nowhere/, 'the red says how to place it');
    assert.throws(() => unclassifiedRefs([]), /discovery found no path-like refs/, 'empty discovery fails instead of passing vacuously');
    assert.ok(staleListEntries([{ name: 'planted-empty.md', text: 'nothing path-like here' }]).length >= 1, 'the identity direction is live: docs that stop quoting a listed token red it');
    assert.deepEqual(staleListEntries(readDocs()), [], 'the real docs quote every classified token');
});

test('self-test: a planted doc naming a real repo file audits clean', () => {
    assert.deepEqual(unclassifiedRefs([{ name: 'planted.md', text: 'edit `cli.ts` and read `docs/testing-discipline.md`' }]), [], 'known tokens classify clean');
});

test('self-test: a planted unresolvable command reds, naming the key or file', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8')) as { scripts?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    const problems = resolveCommands([{ name: 'planted.md', text: 'run `npm run no-such-script` and `npx tsx src/no-such.ts`' }], pkg);
    assert.equal(problems.length, 2, 'exactly the two planted commands must red');
    assert.match(problems[0] ?? '', /no-such-script/, 'the red names the missing script key');
    assert.match(problems[1] ?? '', /src\/no-such\.ts/, 'the red names the missing file');
});

// ---------------------------------------------------------------------------
// Block D — the real guards, end to end (rule 5: the actual thing, spawned)
// ---------------------------------------------------------------------------

test('guard end-to-end: the hard denies and the allows', () => {
    // git commit without a pathspec sweeps in unrelated work → deny.
    assert.equal(runHook(GUARD, bashEvent('git commit -m x')).status, 2, 'a pathspec-less commit is denied');
    assert.equal(runHook(GUARD, bashEvent('git commit -m "two words"')).status, 2, 'quoting does not hide a pathspec-less commit');
    assert.equal(runHook(GUARD, bashEvent('GIT_EDITOR=vim git -C /tmp commit --amend -m y')).status, 2, 'env prefixes and global options do not hide it');
    assert.equal(runHook(GUARD, bashEvent('cd demo && git stash')).status, 2, 'a stash behind a separator is still denied');
    // A pathspec scopes the commit → allow.
    assert.equal(runHook(GUARD, bashEvent('git commit -m x -- src/engine/schema.ts')).status, 0, 'a commit with a pathspec is allowed');
    assert.equal(runHook(GUARD, bashEvent('echo hi')).status, 0, 'anything not git allows immediately');
    // git stash in any form → deny, even the read-only list.
    assert.equal(runHook(GUARD, bashEvent('git stash list')).status, 2, 'stash is denied in any form, list included');
    // Value-taking global options and shell grouping must not hide the subcommand.
    assert.equal(runHook(GUARD, bashEvent('git --git-dir .git commit -m y')).status, 2, '--git-dir does not hide a pathspec-less commit');
    assert.equal(runHook(GUARD, bashEvent('(git stash)')).status, 2, 'paren grouping does not hide a stash');
});

test('guard end-to-end: the ask-JF family surfaces a permissionDecision, not a denial', () => {
    const asks = ['git push', 'git push --force origin main', 'git merge main', 'git pull', 'git checkout -b x', 'git checkout -B x', 'git checkout --orphan x', 'git switch -c x', 'git branch x', 'git reset --hard', 'git clean -fd', 'git restore src/a.ts', 'git checkout -- src/a.ts', 'git checkout .'];
    for (const command of asks) {
        const run = runHook(GUARD, bashEvent(command));
        assert.equal(run.status, 0, `\`${command}\` must not be denied — the ask-JF group asks, it never blocks`);
        assert.match(run.stdout, /"permissionDecision"\s*:\s*"ask"/, `\`${command}\` must surface an ask decision for JF`);
    }
    // The allows inside the ask families: listings and non-destructive forms stay silent.
    for (const command of ['git branch', 'git branch --show-current', 'git reset HEAD~1', 'git checkout main']) {
        const run = runHook(GUARD, bashEvent(command));
        assert.equal(run.status, 0, `\`${command}\` allows`);
        assert.equal(run.stdout, '', `\`${command}\` allows silently — it is not in the ask group`);
    }
});

test('guard end-to-end: garbage stdin fails open, loudly', () => {
    const run = runHook(GUARD, 'not json');
    assert.equal(run.status, 1, 'an unreadable event exits 1 — non-blocking, the command runs');
    assert.match(run.stderr, /FAILING OPEN/, 'the red says the command was NOT checked');
});

test('pre-push dry run: the fast tier, never the suite', () => {
    const dry = spawnSync(process.execPath, [PRE_PUSH, '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
        timeout: HOOK_TIMEOUT_MS,
        killSignal: 'SIGKILL',
    });
    assert.ok(!dry.error && !dry.signal, 'the dry run must answer instantly');
    assert.equal(dry.status, 0, 'the dry run succeeds without running anything');
    const out = dry.stdout ?? '';
    assert.match(out, /npx tsc --noEmit/, 'stage 1 is the typecheck');
    assert.match(out, /docs:check/, 'stage 2 is the CLI-reference drift check');
    for (const canary of [
        'test/constants.test.ts', 'test/docs.test.ts', 'test/spawn-bounds.test.ts', 'test/src-spawn-bounds.test.ts',
        'test/src-async-spawn-bound.test.ts', 'test/cli-force-exit.test.ts', 'test/page-callback-purity.test.ts',
        'test/plain-browser-js.test.ts', 'test/spotlight-rect.test.ts', 'test/serial-suite.test.ts',
        'test/ci-workflow.test.ts', 'test/guardrails.test.ts',
    ]) {
        assert.ok(out.includes(canary), `stage 3 must list the twelve static canaries, including ${canary}`);
    }
    assert.ok(!out.includes('npm test'), 'the pre-push tier must never run the full 10–15 min suite: CI is its landing gate (.github/workflows/test.yml)');
});
