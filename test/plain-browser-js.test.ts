import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSource, tourBridgeSource } from '../src/engine/inject';

/**
 * Canary for the inventory row « runtime.js and tour-bridge.js stay import-free plain browser
 * JavaScript » (docs/testing-discipline.md): both files are injected as text, so they cannot
 * import anything and must tolerate document-start injection (Contributor notes, AGENTS.md).
 *
 * Both sources are read through the same accessors their consumer uses -- `runtimeSource()` and
 * `tourBridgeSource()` from src/engine/inject.ts, the exact strings interpolated into
 * animated.html and every tour scenario page. A moved or renamed file makes the accessor's
 * readFileSync throw, which reds the test before any scanning happens (never vacuous); an emptied
 * file fails the identity assert instead of scanning nothing and passing for free.
 *
 * The only import/require tokens in these sources today sit inside comments (runtime.js:18 "Must
 * not use require/import/TypeScript", :35 "(it cannot import this file)", :1724
 * "module/importmap/JSON" -- tour-bridge.js has none anywhere), so the scan runs on
 * comment-stripped text: a naive token grep is red today, and the stripper is what makes the
 * zero-tolerance honest. There are no windows to ratchet here (unlike spawn-bounds): any single
 * match of a module-token pattern reds.
 *
 * The stripper lives in this file because this canary ships self-contained; the shared
 * test/scan-source.ts helper landed in the same lot, and its stripComments must keep these semantics:
 * length-, offset- and newline-preserving (line numbers stay true), string- and template-aware.
 * Rule 4's mutation proof runs in memory -- src/ is read-only for this lot -- so the self-tests
 * plant the breaks into the real accessor output (prepend, append, strip the identity token) and
 * watch the oracle red and green, which exercises the same code path a disk edit would.
 * This file never scans itself (it reads two sources through accessors, never a directory), but
 * the planted snippets are still assembled by concatenation, following the spawn-bounds precedent.
 */

/** The literal site list: the two injected sources, each with the identity token proving the
 *  accessor handed back the real file and not an empty string that would scan clean for free.
 *  A third injected source must join this list; a rename reds inside the accessor first. */
const SOURCES = [
    {
        name: 'runtime.js',
        read: runtimeSource,
        // runtime.js:1908 -- the exported api object, plain code at the IIFE's end.
        identity: 'window.__vistaro = api',
    },
    {
        name: 'tour-bridge.js',
        read: tourBridgeSource,
        // tour-bridge.js:42 -- the post() helper's message tag, plain code.
        identity: "source: 'vistaro-tour'",
    },
];

/** Zero matches allowed, on the comment-stripped source. The import class covers the dynamic form
 *  (import('x')), the side-effect form (import 'x'), the named (import {...}) and namespace
 *  (import *) forms; the second pattern catches the bare default form (import x from 'y') whose
 *  module specifier is the first quote in reach. Both stay anchored against prose: "import this
 *  file" (runtime.js:35) matches neither -- no brace, quote or paren follows the word. The export
 *  alternatives are the survey's list plus `\*` (export * from). */
const MODULE_TOKENS: Array<[RegExp, string]> = [
    [/\bimport\s*[(\/'"{*]/, 'import statement or dynamic import()'],
    [/\bimport\s+[^;'"`]*?\bfrom\s*['"`]/, 'import ... from ...'],
    [/\bexport\s+(default|async|function|class|const|let|var|\{|\*)/, 'export statement'],
    [/\brequire\s*\(/, 'require()'],
];

/**
 * Blank out every comment by replacing its characters with spaces: the output has exactly the
 * input's length and newlines, so an offset -- and therefore a line number -- in the stripped text
 * is the same offset in the real file. String-literal aware, so a `//` inside '…' or a template
 * keeps the rest of its line; template literals are tracked through ${…} interpolations (one
 * frame per open template: null while scanning template text, else the brace depth of the
 * interpolation entered from it -- templates nest through interpolations), which the CSS
 * constants of runtime.js need: they span lines and carry double quotes. Regex literals are not
 * parsed: a quote inside one can skew the state machine, but every such error only leaves MORE
 * text unblanked (a comment read as code), which shows up as a red on clean code -- never as a
 * silent pass, the safe direction for a zero-tolerance canary.
 */
function stripComments(source: string): string {
    const out = source.split('');
    const blank = (i: number) => { if (out[i] !== '\n') out[i] = ' '; };
    const templates: Array<number | null> = [];
    let mode: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const d = source[i + 1];
        if (mode === 'code') {
            if (c === '/' && d === '/') { mode = 'line'; blank(i); blank(i + 1); i += 2; continue; }
            if (c === '/' && d === '*') { mode = 'block'; blank(i); blank(i + 1); i += 2; continue; }
            if (c === "'" || c === '"') { mode = c; i += 1; continue; }
            if (c === '`') { templates.push(null); mode = '`'; i += 1; continue; }
            if (c === '\\') { i += 2; continue; }
            if (templates.length && templates[templates.length - 1] !== null) {
                const depth = templates[templates.length - 1] as number;
                if (c === '{') templates[templates.length - 1] = depth + 1;
                else if (c === '}') {
                    if (depth === 0) { templates[templates.length - 1] = null; mode = '`'; }
                    else templates[templates.length - 1] = depth - 1;
                }
            }
            i += 1; continue;
        }
        if (mode === 'line') {
            if (c === '\n') { mode = 'code'; i += 1; continue; }
            blank(i); i += 1; continue;
        }
        if (mode === 'block') {
            if (c === '*' && d === '/') { blank(i); blank(i + 1); mode = 'code'; i += 2; continue; }
            blank(i); i += 1; continue;
        }
        if (mode === "'" || mode === '"') {
            if (c === '\\') { i += 2; continue; }
            if (c === mode) mode = 'code';
            i += 1; continue;
        }
        // Template text: quotes and comment openers are plain characters here.
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { templates.pop(); mode = 'code'; i += 1; continue; }
        if (c === '$' && d === '{') { templates[templates.length - 1] = 0; mode = 'code'; i += 2; continue; }
        i += 1; continue;
    }
    return out.join('');
}

/** 1-based line number of an offset (stripping preserved offsets, so this is true of the file). */
function lineAt(text: string, offset: number): number {
    return text.slice(0, offset).split('\n').length;
}

/** The oracle: identity ratchet first (a wrong accessor must not pass by scanning nothing, and the
 *  token is code, so it must survive stripping too), then the zero-token scan on comment-stripped
 *  text. Throws naming the file, line and matched token; silent when import-free. */
function assertImportFree(name: string, source: string, identity: string): void {
    assert.ok(
        source.includes(identity),
        `${name}: identity token ${JSON.stringify(identity)} missing -- the accessor returned something other than the real file (moved, renamed or emptied), and scanning nothing would pass for free`,
    );
    const stripped = stripComments(source);
    assert.ok(
        stripped.includes(identity),
        `${name}: the identity token did not survive comment stripping -- the stripper ate code, so the scan below would be blind`,
    );
    const problems: string[] = [];
    for (const [rx, label] of MODULE_TOKENS) {
        const m = rx.exec(stripped);
        if (m) problems.push(`${label} at line ${lineAt(stripped, m.index)} (${JSON.stringify(m[0])})`);
    }
    if (problems.length) throw new Error(`${name}: module token found after comment stripping -- ${problems.join('; ')}`);
}

/** The naive scan: the same patterns with no stripping -- what a token grep would see. */
function rawTokenProblems(source: string): string[] {
    const problems: string[] = [];
    for (const [rx] of MODULE_TOKENS) {
        const m = rx.exec(source);
        if (m) problems.push(`${m[0]} at line ${lineAt(source, m.index)}`);
    }
    return problems;
}

test('runtime.js and tour-bridge.js are import-free plain browser JavaScript', () => {
    assert.ok(SOURCES.length >= 1, 'discovery found no injected source -- the SOURCES list broke');
    for (const s of SOURCES) assertImportFree(s.name, s.read(), s.identity);
});

test('self-test: the stripper is load-bearing -- the raw runtime source trips, the stripped one is clean', () => {
    // runtime.js:18 carries "Must not use require/import/TypeScript" in a comment: the raw text
    // must trip (a token grep is red today -- that is WHY the stripper is mandatory), and the
    // stripped text must not. If the raw scan goes clean, this proof went vacuous.
    const raw = runtimeSource();
    assert.ok(rawTokenProblems(raw).length >= 1, 'the raw runtime.js scan no longer trips on its comment tokens (runtime.js:18 "require/import") -- the stripper proof below went vacuous');
    assertImportFree('runtime.js', raw, 'window.__vistaro = api');
    // The stripper's contract: same length, same newlines -- offsets and line numbers stay true.
    const stripped = stripComments(raw);
    assert.equal(stripped.length, raw.length, 'stripping changed the length -- offsets would lie');
    assert.equal(stripped.split('\n').length, raw.split('\n').length, 'stripping lost a newline -- line numbers would lie');
});

test('self-test: planted module statements go red; the untouched sources and a commented token stay clean', () => {
    // Assembled at runtime by concatenation (spawn-bounds.test.ts precedent) so a scanning canary
    // never classifies its own text -- moot here (this file is never scanned) but kept uniform.
    const IMPORT_NAMED = ['import', " { x } from './y';"].join('');
    const IMPORT_DEFAULT = ['import', " x from './y';"].join('');
    const REQUIRE = ['require', "('fs')"].join('');
    const EXPORT = ['export', ' const a = 1;'].join('');
    for (const s of SOURCES) {
        const source = s.read();
        assertImportFree(s.name, source, s.identity); // unmodified: clean
        assert.throws(() => assertImportFree(s.name, IMPORT_NAMED + '\n' + source, s.identity), /module token/, 'a prepended named import must go red');
        assert.throws(() => assertImportFree(s.name, IMPORT_DEFAULT + '\n' + source, s.identity), /module token/, 'a prepended default import must go red');
        assert.throws(() => assertImportFree(s.name, source + REQUIRE, s.identity), /module token/, 'an appended require() must go red');
        assert.throws(() => assertImportFree(s.name, source + '\n' + EXPORT, s.identity), /module token/, 'an appended export must go red');
        // Comment-only additions: the survey's plant, plus the stronger shape (a dynamic import()
        // inside a comment, kin to runtime.js:1724's "module/importmap" prose). The raw scan must
        // trip on them -- else the plant proves nothing -- and the stripped scan must stay clean.
        const commented = source + '\n// import x from y\n/* ' + ['import', '("synthetic") */'].join('');
        assert.ok(rawTokenProblems(commented).length >= 1, 'the commented plant must trip the raw scan (else the plant proves nothing)');
        assertImportFree(s.name, commented, s.identity); // clean: the stripper removed both comments
    }
});

test('self-test: a source missing its identity token goes red before the zero-scan', () => {
    for (const s of SOURCES) {
        // The unmodified source is module-token-free, so the only thing that can red here is the
        // identity assert -- and the /identity token/ match below proves that is the one that
        // fired: a wrong accessor cannot pass by scanning nothing.
        const blind = s.read().split(s.identity).join('');
        assert.throws(() => assertImportFree(s.name, blind, s.identity), /identity token/, 'a source without its identity token must red on the identity assert, not pass silently');
    }
});
