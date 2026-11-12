#!/usr/bin/env tsx
/**
 * Render the CLI reference from the commander definitions in cli.ts and write it between
 * `<!-- cli-reference:start -->` and `<!-- cli-reference:end -->` in README.md and AGENTS.md, and the
 * capability tables (actions, step fields, meta fields, easings) from the registry in
 * src/engine/schema.ts between `<!-- capabilities:start -->` and `<!-- capabilities:end -->` in AGENTS.md.
 *
 *   npx tsx scripts/gen-cli-reference.ts          # rewrite the blocks (npm run docs)
 *   npx tsx scripts/gen-cli-reference.ts --check  # exit 1 when a block is stale (npm run docs:check)
 *
 * test/docs.test.ts runs the same comparison, so a stale block fails `npm test` too.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Command, Option, Argument } from 'commander';
import { buildProgram } from '../cli';
import { renderCapabilitiesMarkdown } from '../src/commands/capabilities';

export const START = '<!-- cli-reference:start -->';
export const END = '<!-- cli-reference:end -->';
export const DOC_FILES = ['README.md', 'AGENTS.md'];
export const CAP_START = '<!-- capabilities:start -->';
export const CAP_END = '<!-- capabilities:end -->';
export const CAP_FILES = ['AGENTS.md'];

function argumentSyntax(a: Argument): string {
    const name = a.variadic ? `${a.name()}...` : a.name();
    return a.required ? `<${name}>` : `[${name}]`;
}

function optionRow(o: Option): string {
    const flags = o.flags.replace(/\|/g, '\\|');
    let desc = (o.description || '').replace(/\|/g, '\\|');
    if (o.defaultValue !== undefined && o.defaultValue !== false && !/\(default/.test(desc)) desc += ` (default: \`${String(o.defaultValue)}\`)`;
    return `| \`${flags}\` | ${desc} |`;
}

/** Markdown for one command: heading, usage line, description, arguments, options. */
export function renderCommand(cmd: Command): string {
    const args = cmd.registeredArguments;
    const usage = ['npx vistaro', cmd.name(), ...args.map(argumentSyntax), cmd.options.length ? '[options]' : ''].filter(Boolean).join(' ');
    const lines: string[] = [`### \`${cmd.name()}\``, '', '```bash', usage, '```', '', cmd.description(), ''];
    if (args.length) {
        lines.push('| Argument | Description |', '|---|---|');
        for (const a of args) lines.push(`| \`${argumentSyntax(a)}\` | ${(a.description || '').replace(/\|/g, '\\|')}${a.defaultValue !== undefined ? ` (default: \`${String(a.defaultValue)}\`)` : ''} |`);
        lines.push('');
    }
    if (cmd.options.length) {
        lines.push('| Option | Description |', '|---|---|');
        for (const o of cmd.options) lines.push(optionRow(o));
        lines.push('');
    }
    return lines.join('\n');
}

/** The whole reference block (without the markers). */
export function renderReference(program: Command = buildProgram()): string {
    const commands = program.commands.filter(c => !c.name().startsWith('help'));
    const toc = commands.map(c => `[\`${c.name()}\`](#${c.name().replace(/[^a-z0-9-]/g, '')})`).join(' · ');
    const head = [
        `Generated from \`cli.ts\` by \`npm run docs\`; do not edit by hand. \`npx vistaro <command> --help\` prints the same, plus the usage guide (\`--help\`) and the catalog schema (\`build-all --help\`).`,
        '',
        toc,
        '',
    ];
    return [...head, ...commands.map(renderCommand)].join('\n').trimEnd() + '\n';
}

/** Replace the block between the markers; throws when a marker is missing. */
export function replaceBlock(content: string, block: string, file: string, start = START, end = END): string {
    const s = content.indexOf(start);
    const e = content.indexOf(end);
    if (s < 0 || e < 0 || e < s) throw new Error(`${file}: markers ${start} / ${end} not found`);
    return content.slice(0, s + start.length) + '\n' + block + content.slice(e);
}

export function currentBlock(content: string, file: string, start = START, end = END): string {
    const s = content.indexOf(start);
    const e = content.indexOf(end);
    if (s < 0 || e < 0 || e < s) throw new Error(`${file}: markers ${start} / ${end} not found`);
    return content.slice(s + start.length + 1, e);
}

/** Every generated block: its markers, the files that carry it, and what renders it. */
export function generatedBlocks(): { label: string; start: string; end: string; files: string[]; block: string }[] {
    return [
        { label: 'CLI reference', start: START, end: END, files: DOC_FILES, block: renderReference() },
        { label: 'capability tables', start: CAP_START, end: CAP_END, files: CAP_FILES, block: renderCapabilitiesMarkdown() },
    ];
}

export function run(check: boolean, root = path.resolve(__dirname, '..')): { stale: string[]; written: string[] } {
    const stale: string[] = [];
    const written: string[] = [];
    const contents = new Map<string, string>();
    const read = (name: string) => contents.get(name) ?? fs.readFileSync(path.join(root, name), 'utf8');
    for (const g of generatedBlocks()) {
        for (const name of g.files) {
            const content = read(name);
            if (currentBlock(content, name, g.start, g.end) === g.block) { contents.set(name, content); continue; }
            if (check) { stale.push(`${name} (${g.label})`); continue; }
            contents.set(name, replaceBlock(content, g.block, name, g.start, g.end));
            if (!written.includes(name)) written.push(name);
        }
    }
    for (const name of written) fs.writeFileSync(path.join(root, name), contents.get(name)!);
    return { stale, written };
}

if (require.main === module) {
    const check = process.argv.includes('--check');
    const { stale, written } = run(check);
    if (check) {
        if (stale.length) {
            console.error(`Generated docs are stale in ${stale.join(', ')}: run \`npm run docs\` and commit the result.`);
            process.exit(1);
        }
        console.log(`CLI reference up to date in ${DOC_FILES.join(', ')}; capability tables up to date in ${CAP_FILES.join(', ')}.`);
    } else {
        console.log(written.length ? `Updated the generated docs in ${written.join(', ')}.` : `Generated docs already up to date in ${DOC_FILES.join(', ')}.`);
    }
}
