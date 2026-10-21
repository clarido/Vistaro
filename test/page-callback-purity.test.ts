import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { readFilesUnder, readRunnerGlob, stripComments, matchParens } from './scan-source';
import type { SourceFile } from './scan-source';

/**
 * Canary for the « Rule for page.evaluate callbacks » (AGENTS.md, Contributor notes; inventory
 * row in docs/testing-discipline.md): nothing inside a callback serialized into the page may
 * declare a function or assign one to a binding -- the two APIs the rule names are page.evaluate
 * and page.waitForFunction.
 *
 * Why: tsx/esbuild adds a __name(...) alias to every function it can infer a name for -- a named
 * declaration, or an arrow/function expression assigned to a binding. The helper exists in the
 * Node bundle but not inside the page, so the serialized callback throws silently: a demo that
 * plays as nothing, the failure mode this whole tool exists to prevent.
 *
 * Zero tolerance, no list to maintain: the baseline is zero violations across every file that
 * uses these APIs, so the expected findings list is literally empty and a new violating site
 * goes red by name, with the opener's window quoted. A 12th (then 13th) file joining the API
 * surface -- test/studio.test.ts did, with string-form callbacks -- needs no list edit here.
 *
 * Legal shapes, calibrated on the tree as it stands: an anonymous inline callback
 * (page.evaluate((sel) => ...)), an anonymous function expression nested inside one
 * (forEach(function (n) ...), tour.test.ts:638), casts ((rule as CSSMediaRule) carries no =>),
 * Node-side helpers OUTSIDE the callback span (driver.ts:257-264 -- the paren-matched span is
 * what kills the false positives a crude line window produced), and string-form callbacks
 * (page.evaluate('window.__seen.filter(function (m) ...)'), studio.test.ts:142 -- authored page
 * code that tsx/esbuild never compiles, so no __name hazard can live in it).
 *
 * Scope: every .ts under src/ (readFilesUnder) plus the runner's own flat glob (test/*.test.ts,
 * readRunnerGlob -- no recursion into test/fixtures/, which launches no page). addInitScript
 * shares the hazard and is deliberately out of this row's scope: the rule names the two APIs,
 * and widening a scan is a documented decision, not a test edit (rule 8).
 *
 * Ratchets, so a red reads as designed, not as flake: exactly one site in src/commands/check.ts
 * may contain "checkVisibility" (the target probe at :102, the longest real callback) and its
 * span must cross at least MIN_CALLBACK_LINES lines -- proof the matcher reads the whole body
 * instead of stopping at the (sel: string) parameter list, which also "closes". A reflow of
 * that callback, or a second deep callback, reds the window oracle and asks for a deliberate
 * revisit.
 *
 * The planted snippets of the self-tests assemble their openers at runtime by concatenation, so
 * this file's own text never contains one: the canary scans itself too (it is inside the runner
 * glob) and must classify as nothing, like every other non-calling file.
 */

const root = path.resolve(__dirname, '..');

// Assembled, never literal: '.evaluate(' and '.waitForFunction(' must not appear verbatim
// anywhere in this file's own text (see the header).
const EVALUATE_OPENER = ['.', 'evaluate('].join('');
const WAIT_FUNCTION_OPENER = ['.', 'waitFor', 'Function('].join('');
const OPENERS: { token: string; api: string }[] = [
    { token: EVALUATE_OPENER, api: 'page.evaluate' },
    { token: WAIT_FUNCTION_OPENER, api: 'page.waitForFunction' },
];

// The exact shapes tsx/esbuild gives an inferred name (and therefore a __name call): a named
// function declaration or expression, or an arrow / function expression assigned to a binding.
// Casts ("= (rule as CSSMediaRule)", "= ((Date.now()...") carry no => and never match.
const NAMED_FUNCTION = /\bfunction\s+[A-Za-z_$]/;
const ASSIGNED_FUNCTION = /=\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|=\s*function\b/;
const NAMED_WHY = 'declares a named function -- tsx/esbuild would alias it with a __name helper that does not exist in the page';
const ASSIGNED_WHY = 'assigns a function expression or arrow to a binding -- same __name hazard';

// The report window: the opener line plus the 2 following lines (spawn-bounds' window).
const WINDOW_LINES = 3;
// The check.ts probe oracle floor (see the header, "Ratchets").
const MIN_CALLBACK_LINES = 20;

const IDENTITY_MSG = 'discovery found no page.evaluate/page.waitForFunction call site -- the glob or the opener search broke';

type Site = { file: string; line: number; api: string; spanLines: number; maskedSpan: string };
type Violation = { file: string; line: number; api: string; why: string; window: string };
type Scan = { sites: Site[]; violations: Violation[]; unmatched: string[] };

/**
 * The violation oracle judges code, never literals: string and template bodies are blanked to
 * spaces (newlines survive) before the two patterns run. This is this canary's own oracle logic,
 * so it lives here rather than in the shared reader. Same states matchParens runs -- code,
 * 'string', "string", template, with a ${ } depth stack, so a nested template inside a ${ }
 * region (`total ${rows.map((r) => `${r.n}`)} units`) cannot end the string at the wrong quote.
 */
function blankStringBodies(span: string): string {
    type Mode = 'code' | 'single' | 'double' | 'template';
    const stack: { mode: Mode; braces: number }[] = [{ mode: 'code', braces: 0 }];
    let esc = false;
    const out: string[] = [];
    const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');
    for (let i = 0; i < span.length; i++) {
        const ch = span[i];
        const top = stack[stack.length - 1];
        if (esc) { esc = false; out.push(top.mode === 'code' ? ch : blank(ch)); continue; }
        if (ch === '\\') { esc = true; out.push(top.mode === 'code' ? ch : blank(ch)); continue; }
        if (top.mode === 'single') { out.push(blank(ch)); if (ch === "'") stack.pop(); continue; }
        if (top.mode === 'double') { out.push(blank(ch)); if (ch === '"') stack.pop(); continue; }
        if (top.mode === 'template') {
            if (ch === '`') { stack.pop(); out.push(blank(ch)); }
            else if (ch === '$' && span[i + 1] === '{') { stack.push({ mode: 'code', braces: 0 }); out.push(blank(ch)); i++; out.push(blank('{')); }
            else out.push(blank(ch));
            continue;
        }
        // code
        if (ch === "'") { stack.push({ mode: 'single', braces: 0 }); out.push(blank(ch)); continue; }
        if (ch === '"') { stack.push({ mode: 'double', braces: 0 }); out.push(blank(ch)); continue; }
        if (ch === '`') { stack.push({ mode: 'template', braces: 0 }); out.push(blank(ch)); continue; }
        if (ch === '{') { top.braces++; out.push(ch); continue; }
        if (ch === '}') { if (top.braces === 0 && stack.length > 1) stack.pop(); else top.braces--; out.push(ch); continue; }
        out.push(ch);
    }
    return out.join('');
}

function violationWhys(maskedSpan: string): string[] {
    const whys: string[] = [];
    if (NAMED_FUNCTION.test(maskedSpan)) whys.push(NAMED_WHY);
    if (ASSIGNED_FUNCTION.test(maskedSpan)) whys.push(ASSIGNED_WHY);
    return whys;
}

/** Every page.evaluate/page.waitForFunction call site in the given files, with the violations
 *  the two patterns find in each callback's code-only span. Deterministic: files in glob order,
 *  openers in index order; line numbers point at the opener, like spawn-bounds'. */
function scan(files: SourceFile[]): Scan {
    const sites: Site[] = [];
    const violations: Violation[] = [];
    const unmatched: string[] = [];
    for (const file of files) {
        const stripped = stripComments(file.text);
        const lines = stripped.split('\n');
        // Opener search runs on string-blanked text: an API token that is string data (generated
        // code, a doc sentence) is not a call site, and a search hit can never land inside a
        // literal, where paren matching would read the wrong span.
        const masked = blankStringBodies(stripped);
        for (const opener of OPENERS) {
            let at = masked.indexOf(opener.token);
            while (at >= 0) {
                const openIdx = at + opener.token.length - 1;
                const line = stripped.slice(0, at).split('\n').length;
                const close = matchParens(stripped, openIdx);
                if (close < 0) {
                    unmatched.push(`${file.name}:${line}: the callback's argument span never closed`);
                } else {
                    const maskedSpan = blankStringBodies(stripped.slice(openIdx, close + 1));
                    sites.push({ file: file.name, line, api: opener.api, spanLines: maskedSpan.split('\n').length, maskedSpan });
                    for (const why of violationWhys(maskedSpan)) {
                        violations.push({ file: file.name, line, api: opener.api, why, window: lines.slice(line - 1, line - 1 + WINDOW_LINES).join('\n') });
                    }
                }
                at = masked.indexOf(opener.token, at + opener.token.length);
            }
        }
    }
    return { sites, violations, unmatched };
}

/** The scan scope: every .ts under src/ plus the runner's flat test glob, with readable names. */
function gather(): SourceFile[] {
    return [
        ...readFilesUnder(path.join(root, 'src')).map(f => ({ name: `src/${f.name}`, text: f.text })),
        ...readRunnerGlob(path.join(root, 'test')),
    ];
}

test('no inner function inside a page.evaluate/page.waitForFunction callback (src/ + test/)', () => {
    const result = scan(gather());
    assert.ok(result.sites.length >= 1, IDENTITY_MSG);
    assert.deepEqual(result.unmatched, [], 'a callback argument span never closed: the paren matcher lost balance');
    assert.deepEqual(result.violations, [], [
        'an evaluate/waitForFunction callback declares a named function or assigns a function/arrow to a binding.',
        'tsx/esbuild adds a __name helper that does not exist inside the page, so the callback throws silently.',
        'Hoist the helper beside the callback, or move the work into runtime.js and call it by name (__vistaro.*).',
    ].join(' '));
});

test('window oracle: the check.ts probe callback is read whole, not to its parameter list', () => {
    const result = scan(gather());
    const probe = result.sites.filter(s => s.file === 'src/commands/check.ts' && s.maskedSpan.includes('checkVisibility'));
    assert.equal(probe.length, 1, 'exactly one callback in src/commands/check.ts probes checkVisibility (the target probe at :102)');
    const spanLines = probe.map(s => s.spanLines)[0] ?? 0;
    assert.ok(spanLines >= MIN_CALLBACK_LINES, `the probe's span crossed ${spanLines} lines; reading the whole body (not stopping at the (sel: string) parameter list, which also "closes") means >= ${MIN_CALLBACK_LINES}`);
});

test('self-test: planted violations are discovered, by opener and by shape', () => {
    const arrow = [
        `const r = await page${EVALUATE_OPENER}() => {`,
        `  const inner = () => 1;`,
        `  return inner();`,
        `});`,
    ].join('\n');
    const arrowScan = scan([{ name: 'planted.test.ts', text: arrow }]);
    assert.deepEqual(arrowScan.violations.map(v => [v.line, v.api]), [[1, 'page.evaluate']], 'an arrow assigned to a const inside the callback is discovered');
    assert.match(arrowScan.violations[0].why, /assigns a function expression or arrow/, 'the assigned-binding shape is named');

    const named = [
        `await page${WAIT_FUNCTION_OPENER}() => {`,
        `  function named() { return 2; }`,
        `  return named();`,
        `}, null, { timeout: 15000 });`,
    ].join('\n');
    const namedScan = scan([{ name: 'planted.test.ts', text: named }]);
    assert.deepEqual(namedScan.violations.map(v => [v.api, v.line]), [['page.waitForFunction', 1]], 'a named function in a waitForFunction callback is discovered');
    assert.match(namedScan.violations[0].why, /named function/, 'the named-declaration shape is named');

    const both = [
        `await page${EVALUATE_OPENER}() => {`,
        `  function named() { return 1; }`,
        `  const arrow = () => 2;`,
        `  return named() + arrow();`,
        `});`,
    ].join('\n');
    assert.deepEqual(scan([{ name: 'planted.test.ts', text: both }]).violations.length, 2, 'both patterns fire on one callback');

    const multi = [
        `const value = await page${EVALUATE_OPENER}`,
        `    (token: string) => {`,
        `      const done = (t: string) => t === token;`,
        `      return done(token);`,
        `    },`,
        `    'tok-1');`,
    ].join('\n');
    const multiScan = scan([{ name: 'planted.test.ts', text: multi }]);
    assert.deepEqual(multiScan.violations.map(v => v.line), [1], 'a violation lines below the opener is still found, reported at the opener line');
    assert.ok(multiScan.sites[0].spanLines >= 2, 'the span crosses lines');
});

test('self-test: the legal shapes classify as nothing', () => {
    // check.ts:102-180's shape: a long body of plain value declarations and casts.
    const longBody = [
        `const probe = await page${EVALUATE_OPENER}(sel: string) => {`,
        `  let all: NodeListOf<Element>;`,
        `  try { all = document.querySelectorAll(sel); } catch (e: any) { return { error: e.message, count: 0 }; }`,
        `  const el = all[0];`,
        `  const r = el.getBoundingClientRect();`,
        `  var runtime = (window as any).__vistaro;`,
        `  var effOpacity = parseFloat(getComputedStyle(el).opacity);`,
        `  var opAnc = el.parentElement;`,
        `  while (opAnc && opAnc !== document.documentElement && effOpacity > 0) {`,
        `    var op = parseFloat(getComputedStyle(opAnc).opacity);`,
        `    if (Number.isFinite(op) && op >= 0 && op < effOpacity) effOpacity = op;`,
        `    opAnc = opAnc.parentElement;`,
        `  }`,
        `  const cond = (rule as CSSMediaRule).conditionText;`,
        `  const rules = (sheet as CSSStyleSheet).cssRules;`,
        `  const t0 = ((Date.now()) - (window as any).__t0);`,
        `  return { count: all.length, rendered: !!r.width && effOpacity > 0, cond, t0 };`,
        `});`,
    ].join('\n');
    const longScan = scan([{ name: 'planted.test.ts', text: longBody }]);
    assert.deepEqual(longScan.violations, [], 'a long body of plain value declarations and casts is clean');
    assert.equal(longScan.sites.length, 1, 'the call itself is still a site');

    // A violation-shaped text inside a template literal, one of them nested in a ${ } region:
    // string data, not code -- this is the ${ }-aware part of the oracle.
    const template = [
        `const s = await page${EVALUATE_OPENER}() => {`,
        '  const css = `@keyframes spin { from { function notAReveal() {} } }`;',
        '  const label = `total ${rows.map((r) => `${r.n}`).join(\', \')} units`;',
        `  return css.length + label.length;`,
        `});`,
    ].join('\n');
    const templateScan = scan([{ name: 'planted.test.ts', text: template }]);
    assert.deepEqual(templateScan.violations, [], 'a violation hidden inside a template literal (nested template in ${ } included) is string data, not code');
    assert.equal(templateScan.sites.length, 1, 'the call itself is still a site');

    // check.ts:131's real comment, planted: rule prose inside a callback is documentation.
    const commented = [
        `await page${EVALUATE_OPENER}() => {`,
        `  // No inner function declarations here: a __name helper would not exist inside the page.`,
        `  return (window as any).__vistaro.getState();`,
        `});`,
    ].join('\n');
    assert.deepEqual(scan([{ name: 'planted.test.ts', text: commented }]).violations, [], 'a rule-shaped sentence in a comment is documentation, not code');

    // driver.ts:254-264's shape: Node-side helpers just below an evaluate -- outside the span.
    const nodeSide = [
        `state.t0Wall = await page${EVALUATE_OPENER}() => { const a = (window as any).__vistaro; a.start(); return a.getState().t0; });`,
        `const onNavigated = (frame: Frame) => { state.needsReboot = true; };`,
        'const label = (step: Step) => `step ${step.index}`;',
        `const prepare = async (i: number): Promise<StepResult> => { return steps[i]; };`,
    ].join('\n');
    const nodeSideScan = scan([{ name: 'planted.test.ts', text: nodeSide }]);
    assert.deepEqual(nodeSideScan.violations, [], 'Node-side helpers beside an evaluate sit outside its callback span (the line-window false positive)');
    assert.equal(nodeSideScan.sites.length, 1, 'the call itself is still a site');

    // tour.test.ts:638's shape: anonymous function expressions nested in a callback stay legal.
    const anonymous = [
        `await page${EVALUATE_OPENER}() => {`,
        `  ['tourstep', 'tourend'].forEach(function (n) { seen.push(n); });`,
        `  el.addEventListener('tourerror', function (e) { seen.push(e); });`,
        `});`,
    ].join('\n');
    assert.deepEqual(scan([{ name: 'planted.test.ts', text: anonymous }]).violations, [], 'anonymous inline callbacks and nested anonymous function( expressions get no inferred name');

    // tour.test.ts:628-644's shape: page-context code in a template string, whose assigned
    // function (__make = function ...) is string data, and the evaluate below it is still found.
    const hostPage = [
        'fs.writeFileSync(host, `<!doctype html><script>',
        '  window.__make = function (scenario) {',
        '    ["tourstep", "tourend"].forEach(function (n) { window.__ev.push(n); });',
        '  };',
        '</script>`);',
        `await page${EVALUATE_OPENER}() => { (window as any).__make('basic'); });`,
    ].join('\n');
    const hostScan = scan([{ name: 'planted.test.ts', text: hostPage }]);
    assert.deepEqual(hostScan.violations, [], 'the host-page shapes of tour.test.ts:633/638 are page-context string data, not callback code');
    assert.equal(hostScan.sites.length, 1, 'the evaluate below the template is still a site');

    // studio.test.ts:133-150's shape: string-form callbacks -- authored page code, never
    // compiled by tsx/esbuild, so their shapes are no hazard (but they are still sites).
    const stringForm = [
        `const booted = await page${EVALUATE_OPENER}'({ runtime: !!window.__vistaro })') as { runtime: boolean };`,
        `await page${WAIT_FUNCTION_OPENER}'window.__seen.some(function (m) { return m.type === "picked"; })', null, { timeout: 8000 });`,
    ].join('\n');
    const stringScan = scan([{ name: 'planted.test.ts', text: stringForm }]);
    assert.deepEqual(stringScan.violations, [], 'a string-form callback is authored page code; its inner shapes are no hazard');
    assert.equal(stringScan.sites.length, 2, 'both string-form calls are still sites');

    // An opener that is string data is not a call site at all.
    const stringData = [
        `'Read page${EVALUATE_OPENER}fn) in the docs.'`,
        `const doc = 'x';`,
    ].join('\n');
    assert.deepEqual(scan([{ name: 'planted.test.ts', text: stringData }]).sites, [], 'an opener that is string data never becomes a site (opener search runs on string-blanked text)');
});

test('self-test: an empty glob fails instead of passing vacuously', () => {
    assert.throws(() => {
        // A renamed glob or a broken opener search scans nothing; the identity assert must go red.
        const result = scan([]);
        assert.ok(result.sites.length >= 1, IDENTITY_MSG);
        assert.deepEqual(result.violations, []);
    }, /discovery found no page\.evaluate/);
});
