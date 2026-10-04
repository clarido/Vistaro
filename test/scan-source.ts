/**
 * The one shared reader behind the scanning canaries (the src/ spawn-bound canaries, and the lot's
 * text-scanning canaries that need comment-blind or paren-aware reads). Not a test file (no
 * `.test.` in the name): the runner's test/*.test.ts glob never picks it up; it only ever runs as
 * an import -- the precedent test/assert-ran.ts documents in its own header.
 *
 * Scopes (docs/testing-discipline.md rule 8: these scopes are allowlists, widening one is a
 * documented decision, not a test edit):
 *   - readFilesUnder walks one source tree recursively, reading every .ts under it -- no
 *     node_modules, no dot-entries, no fixtures/ directory anywhere on the way down;
 *   - readRunnerGlob is the runner's own flat test glob (the *.test.ts siblings, per the
 *     package.json "test" script), so
 *     test/fixtures/ is out by construction -- it does not recurse.
 * Both return {name, text} with `name` relative to the scanned root, forward-slashed and sorted,
 * so a canary's identity list is written against stable names ('commands/build-all.ts',
 * 'tour.test.ts').
 *
 * stripComments and matchParens are single-pass state machines over the JavaScript family (code,
 * 'string', "string", template literals with a ${ } depth stack -- brace-bearing strings and long
 * callbacks exist in scan range). One documented approximation: a regex literal whose body carries
 * a quote or an unbalanced bracket can desync either machine (no scanned file does this); another:
 * stripComments blanks comment characters to spaces instead of deleting them, so string length,
 * offsets and line numbers all stay true.
 */

import * as fs from 'fs';
import * as path from 'path';

export type SourceFile = { name: string; text: string };

const SKIP_DIRS = new Set(['node_modules', 'fixtures']);

/** Every .ts file under `dir`, recursively, as {name, text} with root-relative forward-slashed
 *  sorted names ('commands/build-all.ts'). Deterministic order: readdirSync is not. */
export function readFilesUnder(dir: string): SourceFile[] {
    const out: SourceFile[] = [];
    const walk = (abs: string, rel: string): void => {
        const entries = fs.readdirSync(abs, { withFileTypes: true })
            .filter(e => !e.name.startsWith('.'))
            .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const relName = rel ? `${rel}/${entry.name}` : entry.name;
            const absPath = path.join(abs, entry.name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(absPath, relName);
            } else if (entry.isFile() && /\.ts$/.test(entry.name)) {
                out.push({ name: relName, text: fs.readFileSync(absPath, 'utf8') });
            }
        }
    };
    walk(dir, '');
    return out;
}

/** The runner's glob, as text: every top-level *.test.ts sibling of the canaries, sorted. Flat on
 *  purpose -- the same glob package.json's "test" script feeds the runner, so test/fixtures/ (and
 *  this helper itself) are never scanned. */
export function readRunnerGlob(dir: string): SourceFile[] {
    return fs.readdirSync(dir)
        .filter(f => /\.test\.ts$/.test(f))
        .sort()
        .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

type Mode = 'code' | 'single' | 'double' | 'template';
type Frame = { mode: Mode; braces: number };

/** Index of the ')' matching the '(' at `openIdx`, or -1. One pass; strings and template `${ }`
 *  regions are skipped as units, so a ')' inside either never closes a paren of the code. */
export function matchParens(text: string, openIdx: number): number {
    if (text[openIdx] !== '(') return -1;
    const stack: Frame[] = [{ mode: 'code', braces: 0 }];
    let esc = false;
    let parens = 0;
    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        const top = stack[stack.length - 1];
        if (top.mode === 'single') { if (ch === "'") stack.pop(); continue; }
        if (top.mode === 'double') { if (ch === '"') stack.pop(); continue; }
        if (top.mode === 'template') {
            if (ch === '`') stack.pop();
            else if (ch === '$' && text[i + 1] === '{') { stack.push({ mode: 'code', braces: 0 }); i++; }
            continue;
        }
        // code
        if (ch === "'") stack.push({ mode: 'single', braces: 0 });
        else if (ch === '"') stack.push({ mode: 'double', braces: 0 });
        else if (ch === '`') stack.push({ mode: 'template', braces: 0 });
        else if (ch === '{') top.braces++;
        else if (ch === '}' && top.braces === 0 && stack.length > 1) stack.pop(); // closes the ${
        else if (ch === '}') top.braces--;
        else if (ch === '(') parens++;
        else if (ch === ')') { parens--; if (parens === 0 && stack.length === 1) return i; }
    }
    return -1;
}

/** The text with every comment blanked to spaces: line comments to end of line, block comments
 *  across lines (newlines kept), strings and templates untouched. Same length as the input, so
 *  offsets -- and therefore line numbers -- stay true for a scanner working on the result. */
export function stripComments(text: string): string {
    const stack: (Frame | { mode: 'line' | 'block'; braces: number })[] = [{ mode: 'code', braces: 0 }];
    let esc = false;
    const out: string[] = [];
    const top = () => stack[stack.length - 1];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (top().mode === 'line') {
            if (ch === '\n') { stack.pop(); out.push('\n'); } else out.push(' ');
            continue;
        }
        if (top().mode === 'block') {
            if (ch === '*' && text[i + 1] === '/') { stack.pop(); out.push('  '); i++; }
            else out.push(ch === '\n' ? '\n' : ' ');
            continue;
        }
        if (esc) { esc = false; out.push(ch); continue; }
        if (ch === '\\') { esc = true; out.push(ch); continue; }
        const frame = top() as Frame;
        if (frame.mode === 'single') { out.push(ch); if (ch === "'") stack.pop(); continue; }
        if (frame.mode === 'double') { out.push(ch); if (ch === '"') stack.pop(); continue; }
        if (frame.mode === 'template') {
            if (ch === '`') { stack.pop(); out.push(ch); }
            else if (ch === '$' && text[i + 1] === '{') { stack.push({ mode: 'code', braces: 0 }); out.push('${'); i++; }
            else out.push(ch);
            continue;
        }
        // code
        if (ch === '/' && text[i + 1] === '/') { stack.push({ mode: 'line', braces: 0 }); out.push('  '); i++; continue; }
        if (ch === '/' && text[i + 1] === '*') { stack.push({ mode: 'block', braces: 0 }); out.push('  '); i++; continue; }
        if (ch === "'") { stack.push({ mode: 'single', braces: 0 }); out.push(ch); continue; }
        if (ch === '"') { stack.push({ mode: 'double', braces: 0 }); out.push(ch); continue; }
        if (ch === '`') { stack.push({ mode: 'template', braces: 0 }); out.push(ch); continue; }
        if (ch === '{') { frame.braces++; out.push(ch); continue; }
        if (ch === '}') {
            if (frame.braces === 0 && stack.length > 1) stack.pop(); // closes the ${ -- back to template text
            else frame.braces--;
            out.push(ch);
            continue;
        }
        out.push(ch);
    }
    return out.join('');
}
