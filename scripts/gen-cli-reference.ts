#!/usr/bin/env tsx
/**
 * Render the CLI reference from the commander definitions in cli.ts and write it between
 * `<!-- cli-reference:start -->` and `<!-- cli-reference:end -->` in README.md and AGENTS.md.
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

export const START = '<!-- cli-reference:start -->';
export const END = '<!-- cli-reference:end -->';
export const DOC_FILES = ['README.md', 'AGENTS.md'];

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
    const usage = ['npx tsx cli.ts', cmd.name(), ...args.map(argumentSyntax), cmd.options.length ? '[options]' : ''].filter(Boolean).join(' ');
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
        `Generated from \`cli.ts\` by \`npm run docs\`; do not edit by hand. \`npx tsx cli.ts <command> --help\` prints the same, plus the usage guide (\`--help\`) and the catalog schema (\`build-all --help\`).`,
        '',
        toc,
        '',
    ];
    return [...head, ...commands.map(renderCommand)].join('\n').trimEnd() + '\n';
}

/** Replace the block between the markers; throws when a marker is missing. */
export function replaceBlock(content: string, block: string, file: string): string {
    const s = content.indexOf(START);
    const e = content.indexOf(END);
    if (s < 0 || e < 0 || e < s) throw new Error(`${file}: markers ${START} / ${END} not found`);
    return content.slice(0, s + START.length) + '\n' + block + content.slice(e);
}

export function currentBlock(content: string, file: string): string {
    const s = content.indexOf(START);
    const e = content.indexOf(END);
    if (s < 0 || e < 0 || e < s) throw new Error(`${file}: markers ${START} / ${END} not found`);
    return content.slice(s + START.length + 1, e);
}

export function run(check: boolean, root = path.resolve(__dirname, '..')): { stale: string[]; written: string[] } {
    const block = renderReference();
    const stale: string[] = [];
    const written: string[] = [];
    for (const name of DOC_FILES) {
        const file = path.join(root, name);
        const content = fs.readFileSync(file, 'utf8');
        if (currentBlock(content, name) === block) continue;
        if (check) { stale.push(name); continue; }
        fs.writeFileSync(file, replaceBlock(content, block, name));
        written.push(name);
    }
    return { stale, written };
}

if (require.main === module) {
    const check = process.argv.includes('--check');
    const { stale, written } = run(check);
    if (check) {
        if (stale.length) {
            console.error(`CLI reference is stale in ${stale.join(', ')}: run \`npm run docs\` and commit the result.`);
            process.exit(1);
        }
        console.log(`CLI reference up to date in ${DOC_FILES.join(', ')}.`);
    } else {
        console.log(written.length ? `Updated the CLI reference in ${written.join(', ')}.` : `CLI reference already up to date in ${DOC_FILES.join(', ')}.`);
    }
}
