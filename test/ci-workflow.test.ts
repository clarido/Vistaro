import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Canary for the CI row of docs/testing-discipline.md ("CI runs `npm run docs:check`,
 * `npx tsc --noEmit` and `npm test` on every push", Contributor notes): the three steps live in
 * the repo's one GitHub workflow (.github/workflows/test.yml:39,42,47) behind an `on:` `push`
 * trigger (test.yml:7-9).
 *
 * Discovery reads every .yml/.yaml under <root>/.github/workflows -- the only place GitHub picks
 * workflows up from, so the walk is a flat readdir, not a recursive one. Unlike spawn-bounds'
 * KNOWN_SITES there is deliberately no literal filename list: the survey requires renaming
 * test.yml to survive, so the identity assert ("at least one workflow") is what turns deleting CI
 * entirely into a red, and every discovered file is audited on content alone. Each file must
 * itself carry all three commands and the push trigger -- a second workflow that skips them reds
 * this canary and must be looked at deliberately; loosening that per-file rule is JF's call
 * (docs/testing-discipline.md rule 8).
 *
 * Parsing: '#' comments are stripped line-wise, quote-aware, with offsets preserved so line
 * numbers stay true. This is mandatory, not cosmetic: a trailing comment can carry a command into
 * a run: value it does not belong to ("run: echo done # then npm test"), and test.yml:44-45 names
 * `npm test` in prose. The text is then split into step blocks on step-start lines (`- name:` /
 * `- uses:` / `- run:`). The step block is this canary's window, the analog of spawn-bounds' 3
 * lines around a spawn: each command must appear as a substring of a run: VALUE inside one block
 * (containment, not whole-value equality -- a step that chains the three still runs them), in a
 * block that carries no `if:` key (so `if: false` cannot satisfy the scan), and the file must
 * declare `on:` containing `push`. Reordering steps survives; a command drifting out of a run:
 * value -- into a comment, behind an `if:` -- reds. The `run.map(deepEqual CHECKS)` in the main
 * test is a ratchet, not a tolerance: a fourth occurrence (splitting the saas smoke out of
 * `npm test`, say) reds until the new shape is adopted deliberately.
 *
 * Rule-4 mutations run as planted workflow texts through the same audit the real scan calls --
 * the ask marks .github/ read-only, so test.yml itself is never mutated: the base plant audits
 * clean; deleting the docs:check step, guarding it with `if:`, reducing `on:` to
 * workflow_dispatch and leaving a command only in comments each go red naming the cause; zero
 * files and a missing directory red the identity. The same three mutations are then applied to
 * the discovered workflow's real text in memory, so the red is proven against the actual bytes.
 * Discovery is additionally proven red end-to-end through the real reader by reading a directory
 * that does not exist. Planted fragments are assembled at runtime by concatenation (the
 * spawn-bounds.test.ts precedent) so a mutation is exactly one removed fragment.
 */

const root = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(root, '.github', 'workflows');

// The three commands of the inventory row, verbatim. Exact substrings on purpose: 'npm test'
// does not substring-match 'npm run test:...' ('run ' intervenes), and containment rather than
// whole-value equality is deliberate -- a step that chains the three still runs them.
const CHECKS = ['npm run docs:check', 'npx tsc --noEmit', 'npm test'];

// The named identity failure: zero workflow files is "CI deleted", never "nothing to check".
const NO_CI = 'discovery found no CI workflow under .github/workflows -- CI was deleted or moved; the "docs:check, tsc --noEmit and npm test on every push" row is unguarded';

type WorkflowFile = { name: string; text: string };
type RunSite = { command: string; line: number };
type Verdict = { pushLine: number | null; run: RunSite[]; guarded: RunSite[] };
type StepBlock = { startLine: number; lines: string[] };

const STEP_START = /^\s*-\s+(?:name|uses|run)\s*:/;
const RUN_KEY = /^(\s*)(?:-\s+)?run:\s*(.*)$/;
const GUARD_KEY = /^\s*if\s*:/;
const BLOCK_SCALAR = /^[|>][+-]?$/;
const PUSH_KEY = /^\s*push\b/;

/** Strip '#' comments line-wise: a '#' at line start (or after whitespace), outside quotes,
 *  blanks the rest of the line with spaces. Offsets and newlines are preserved, so every line
 *  number an audit reports is the line number in the real file. */
function stripYamlComments(text: string): string {
    return text.split('\n').map(line => {
        let out = '';
        let quote: string | null = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (quote) {
                out += ch;
                // YAML escapes a quote inside a quote by doubling it: the toggle lands right.
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === "'" || ch === '"') {
                quote = ch;
                out += ch;
                continue;
            }
            if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
                out += ' '.repeat(line.length - i);
                break;
            }
            out += ch;
        }
        return out;
    }).join('\n');
}

/** Step blocks delimited by the next step-start line; each block keeps its own lines (the
 *  step-start line included, so a bare `- run: npm ci` is seen) with absolute line numbers. */
function stepBlocks(lines: string[]): StepBlock[] {
    const blocks: StepBlock[] = [];
    let current: StepBlock | null = null;
    for (let i = 0; i < lines.length; i++) {
        if (STEP_START.test(lines[i])) {
            current = { startLine: i + 1, lines: [lines[i]] };
            blocks.push(current);
        } else if (current) {
            current.lines.push(lines[i]);
        }
    }
    return blocks;
}

function unquote(value: string): string {
    if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
        return value.slice(1, -1);
    }
    return value;
}

/** Every run: value in one block, inline (`run: npm test`) or block scalar (`run: |`). The line
 *  reported is the run: key's line. */
function runValues(block: StepBlock): { value: string; line: number }[] {
    const values: { value: string; line: number }[] = [];
    for (let i = 0; i < block.lines.length; i++) {
        const m = block.lines[i].match(RUN_KEY);
        if (!m) continue;
        const keyIndent = m[1].length;
        const rest = m[2].trim();
        if (rest !== '' && !BLOCK_SCALAR.test(rest)) {
            values.push({ value: unquote(rest), line: block.startLine + i });
            continue;
        }
        // A block scalar (or a bare `run:`): the value is the more-indented lines below.
        const parts: string[] = [];
        for (let j = i + 1; j < block.lines.length; j++) {
            const line = block.lines[j];
            if (line.trim() === '') {
                parts.push('');
                continue;
            }
            if (line.match(/^\s*/)![0].length <= keyIndent) break;
            parts.push(line.trim());
        }
        values.push({ value: parts.join('\n'), line: block.startLine + i });
    }
    return values;
}

/** The line of the `push` entry under the first top-level `on:`, flow (`on: [push]`) or block
 *  form; null when the trigger does not include push (workflow_dispatch only, or none). */
function pushTriggerLine(lines: string[]): number | null {
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)on:\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const rest = m[2].trim();
        if (rest.startsWith('[')) {
            let flow = rest;
            let j = i;
            while (!flow.includes(']') && j + 1 < lines.length) flow += ' ' + lines[++j].trim();
            return /\bpush\b/.test(flow) ? i + 1 : null;
        }
        if (rest !== '') return /\bpush\b/.test(rest) ? i + 1 : null;
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === '') continue;
            if (line.match(/^\s*/)![0].length <= indent) break;
            if (PUSH_KEY.test(line)) return j + 1;
        }
        return null;
    }
    return null;
}

/** The audit both the real scan and the planted self-tests run: where each check runs unguarded,
 *  where it runs only behind an `if:`, and whether the file triggers on push. */
function auditWorkflow(text: string): Verdict {
    const lines = stripYamlComments(text).split('\n');
    const run: RunSite[] = [];
    const guarded: RunSite[] = [];
    for (const block of stepBlocks(lines)) {
        const isGuarded = block.lines.some(line => GUARD_KEY.test(line));
        for (const site of runValues(block)) {
            for (const command of CHECKS.filter(c => site.value.includes(c))) {
                (isGuarded ? guarded : run).push({ command, line: site.line });
            }
        }
    }
    return { pushLine: pushTriggerLine(lines), run, guarded };
}

/** The per-file problems, each naming the file, the line and the cause. */
function auditProblems(w: WorkflowFile): string[] {
    const verdict = auditWorkflow(w.text);
    const problems: string[] = [];
    if (verdict.pushLine === null) {
        problems.push(`${w.name}: no 'on:' trigger containing 'push' -- the steps would not run on push`);
    }
    for (const command of CHECKS) {
        if (verdict.run.some(site => site.command === command)) continue;
        const behind = verdict.guarded.find(site => site.command === command);
        if (behind) {
            problems.push(`${w.name}:${behind.line}: '${command}' sits behind an 'if:' -- a conditional step cannot satisfy this canary`);
        } else {
            problems.push(`${w.name}: no step's run: value contains '${command}' (a '#' comment naming it does not count)`);
        }
    }
    return problems;
}

/** The real scan, one place, so the empty-discovery self-test exercises the exact identity. */
function scanAll(workflows: WorkflowFile[]): string[] {
    assert.ok(workflows.length >= 1, NO_CI);
    return workflows.flatMap(auditProblems);
}

function readWorkflows(dir: string): WorkflowFile[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => /\.ya?ml$/.test(f))
        .sort()
        .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

// -- planted workflows (self-tests) -----------------------------------------
// Fragments assembled at runtime by concatenation, so a mutation is exactly one removed fragment.

const ON_PUSH = ['on:', '  push:', "    branches: ['**']", '  pull_request:', ''];
const ON_DISPATCH_ONLY = ['on:', '  workflow_dispatch:', ''];
const JOBS = ['jobs:', '  checks:', '    runs-on: ubuntu-latest', '    steps:', ''];
const DOCS_STEP = ['      - name: CLI reference is up to date', '        run: npm run docs:check', ''];
const DOCS_STEP_GUARDED = ['      - name: CLI reference is up to date', '        if: false', '        run: npm run docs:check', ''];
const TSC_STEP = ['      - name: Typecheck', '        run: npx tsc --noEmit', ''];
const TEST_STEP = ['      - name: Test', '        run: npm test', ''];

const plant = (...parts: string[][]): string => parts.flat().join('\n') + '\n';

const BASE = plant(['name: ci', ''], ON_PUSH, JOBS, DOCS_STEP, TSC_STEP, TEST_STEP);

const problemsOf = (text: string): string[] => auditProblems({ name: 'planted.yml', text });

test('CI runs docs:check, tsc --noEmit and npm test on every push', () => {
    const workflows = readWorkflows(WORKFLOW_DIR);
    const problems = scanAll(workflows); // the identity assert lives inside: zero files red here
    assert.deepEqual(problems, [], 'CI no longer runs the three checks unguarded on every push');
    // The positive shape, so a parser that silently finds nothing cannot pass either: every
    // discovered workflow yields exactly the three checks (a ratchet -- a fourth occurrence reds
    // until the new shape is adopted deliberately) at a push trigger line.
    for (const w of workflows) {
        const verdict = auditWorkflow(w.text);
        assert.deepEqual(verdict.run.map(s => s.command), CHECKS, `${w.name}: the unguarded run values must be exactly the three checks`);
        assert.ok(verdict.pushLine !== null && verdict.pushLine >= 1, `${w.name}: no push trigger line found`);
    }
});

test('self-test: the base plant -- three unguarded checks on push -- audits clean', () => {
    assert.deepEqual(problemsOf(BASE), [], 'the base plant must audit clean');
    assert.deepEqual(auditWorkflow(BASE).run.map(s => s.command), CHECKS, 'the base plant must yield the three checks in order');
});

test('self-test: deleting the docs:check step reds, naming the missing command', () => {
    const deleted = plant(['name: ci', ''], ON_PUSH, JOBS, TSC_STEP, TEST_STEP);
    const problems = problemsOf(deleted);
    assert.equal(problems.length, 1, 'exactly the docs:check command must be missing');
    assert.match(problems[0], /npm run docs:check/, 'the red names the missing command');
});

test('self-test: an if: on the step reds even though the command is right there', () => {
    const guarded = plant(['name: ci', ''], ON_PUSH, JOBS, DOCS_STEP_GUARDED, TSC_STEP, TEST_STEP);
    const problems = problemsOf(guarded);
    assert.equal(problems.length, 1, 'exactly the guarded docs:check must be rejected');
    assert.match(problems[0], /npm run docs:check/, 'the red names the command');
    assert.match(problems[0], /if:/, 'the red says the command sits behind an if:');
});

test('self-test: on: reduced to workflow_dispatch reds', () => {
    const dispatch = plant(['name: ci', ''], ON_DISPATCH_ONLY, JOBS, DOCS_STEP, TSC_STEP, TEST_STEP);
    const problems = problemsOf(dispatch);
    assert.equal(problems.length, 1, 'only the push trigger must be missing');
    assert.match(problems[0], /push/, 'the red names the push trigger');
});

test('self-test: a chained run value and a run: block scalar still run the three (containment)', () => {
    const chained = plant(['name: ci', ''], ON_PUSH, JOBS,
        ['      - name: All three', '        run: npm run docs:check && npx tsc --noEmit && npm test', '']);
    assert.deepEqual(problemsOf(chained), [], 'a step that chains the three still runs them');
    const blocked = plant(['name: ci', ''], ON_PUSH, JOBS,
        ['      - name: All three', '        run: |', '          npm run docs:check', '          npx tsc --noEmit', '          npm test', '']);
    assert.deepEqual(problemsOf(blocked), [], 'a run: block scalar is a run: value');
});

test('self-test: a command only in comments reds -- comments are not run values', () => {
    // The test.yml:44-45 shape (npm test named in a block comment) plus the sharper hazard: a
    // trailing comment carrying a command into a run: line that never runs it.
    const proseOnly = plant(['name: ci', ''], ON_PUSH, JOBS, DOCS_STEP, TSC_STEP,
        ['      # npm test chains the saas smoke script after the suite', ''],
        ['      - name: noop', '        run: echo suite done # not npm test itself', '']);
    const problems = problemsOf(proseOnly);
    assert.equal(problems.length, 1, 'exactly npm test must be missing');
    assert.match(problems[0], /npm test/, 'the red names the command that only comments mention');
});

test('self-test: no run: at all reds all three', () => {
    const nothing = plant(['name: ci', ''], ON_PUSH, JOBS,
        ['      - name: noop', '        run: echo "nothing to see"', '']);
    const problems = problemsOf(nothing);
    assert.equal(problems.length, CHECKS.length, 'all three must red');
    CHECKS.forEach((command, i) => assert.ok(problems[i].includes(command), `problem ${i} must name ${command}`));
});

test('self-test: the real workflow text, mutated in memory, reds through the same audit', () => {
    // The rule-4 proof against the real bytes: .github/ is read-only for this canary, so each
    // mutation is applied to the discovered file's actual text in memory, never on disk. A
    // reflow that makes a mutation a no-op reds the `must change` assert and forces a revisit.
    const workflows = readWorkflows(WORKFLOW_DIR);
    assert.ok(workflows.length >= 1, NO_CI);
    const real = workflows[0];
    assert.ok(real.text.includes('run: npm run docs:check'), 'the real workflow must carry the docs:check run for this proof');

    const deleted = real.text.replace(/^\s*run: npm run docs:check\s*$/m, '        run: echo docs look current');
    assert.notEqual(deleted, real.text, 'the deletion mutation must change the text');
    assert.match(auditProblems({ name: real.name, text: deleted })[0], /npm run docs:check/, 'the real text minus the docs:check run reds naming it');

    const guarded = real.text.replace('run: npm run docs:check', 'if: false\n        run: npm run docs:check');
    assert.notEqual(guarded, real.text, 'the guard mutation must change the text');
    assert.match(auditProblems({ name: real.name, text: guarded })[0], /if:/, 'the real text with the step guarded reds naming the if:');

    const dispatch = real.text.replace(/\n\s*push:[^\n]*\n(\s+[^\n]*\n)?/, '\n');
    assert.notEqual(dispatch, real.text, 'the trigger mutation must change the text');
    assert.equal(auditWorkflow(dispatch).pushLine, null, 'the real text without its push entry must lose the trigger');
    assert.match(auditProblems({ name: real.name, text: dispatch })[0], /push/, 'the real text without push reds naming the trigger');
});

test('self-test: zero workflow files and a missing directory red the identity', () => {
    assert.throws(() => scanAll([]), /discovery found no CI workflow/);
    // The real reader, end-to-end, in its failing direction: a moved workflows directory.
    assert.throws(() => scanAll(readWorkflows(path.join(root, '.github', 'workflows-does-not-exist'))), /discovery found no CI workflow/);
});
