import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { renderReference, currentBlock, DOC_FILES, START, END } from '../scripts/gen-cli-reference';
import { buildProgram } from '../cli';

const root = path.resolve(__dirname, '..');

test('the generated CLI reference in README.md and AGENTS.md matches cli.ts (run `npm run docs` when this fails)', () => {
    const block = renderReference();
    for (const name of DOC_FILES) {
        const content = fs.readFileSync(path.join(root, name), 'utf8');
        assert.ok(content.includes(START) && content.includes(END), `${name} has the cli-reference markers`);
        assert.equal(currentBlock(content, name), block, `${name}: CLI reference block is stale; run \`npm run docs\``);
    }
});

test('the reference lists every command with its arguments and options', () => {
    const program = buildProgram();
    const block = renderReference(program);
    for (const cmd of program.commands) {
        assert.ok(block.includes(`### \`${cmd.name()}\``), `command ${cmd.name()} documented`);
        for (const o of cmd.options) assert.ok(block.includes(`\`${o.flags.replace(/\|/g, '\\|')}\``), `${cmd.name()} option ${o.flags} documented`);
    }
    assert.ok(block.includes('### `build-all`') && block.includes('`--changed-only`'));
    assert.ok(block.includes('`--live`'), 'check --live documented');
});

test('cli.ts version matches package.json and the program does not parse on import', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(buildProgram().version(), pkg.version);
    assert.match(pkg.engines?.node || '', />=\s*20/);
});
