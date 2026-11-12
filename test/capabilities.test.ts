import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
    ACTIONS, ACTION_DOCS, EASING_NAMES, EASING_DOCS, SUBTITLE_PLACES, documentedStepFields, META_FIELD_DOCS,
} from '../src/engine/schema';
import { capabilities, renderCapabilitiesMarkdown, Capabilities, readPresets } from '../src/commands/capabilities';
import { currentBlock, CAP_START, CAP_END } from '../scripts/gen-cli-reference';
import { runtimeSource } from '../src/engine/inject';
import { CLI_TIMEOUT_MS, assertRan } from './assert-ran';

/**
 * Canary for « the manual knows every capability » (docs/testing-discipline.md, inventory row
 * « Every action, easing and step field is described in the capability registry »). The registry
 * in schema.ts is the single source; what this file guards is that nothing the engine ACCEPTS or
 * READS escapes it:
 *   - every ACTIONS / EASING_NAMES member is described, rendered into the AGENTS.md block, and
 *     printed by the real `capabilities --json`;
 *   - every step field the validator (schema.ts validateTimeline) or the runtime (runtime.js
 *     `step.<field>`) reads is a documented field -- a new field cannot ship undocumented;
 *   - the studio's own copies (ACTIONS, SUBTITLE_PLACES, EASINGS, the inspector's field keys)
 *     agree with the schema, so the editor cannot offer a different vocabulary.
 * When it goes red: add the missing entry to ACTION_DOCS / EASING_DOCS / STEP_FIELD_DOCS /
 * META_FIELD_DOCS in src/engine/schema.ts (or to the studio registry), then run `npm run docs`.
 */

const root = path.resolve(__dirname, '..');

/** Fields a step carries that the PARSER computes, never an author: exempt from documentation. */
const COMPUTED_STEP_FIELDS = ['index', 'timeMs', 'subtitleMs', 'deprecatedAction'];

/** Problems between the registry data and the rendered block. Empty discovery is a problem too. */
function auditRegistry(c: Capabilities, block: string, actions: readonly string[], easings: readonly string[]): string[] {
    const problems: string[] = [];
    if (!actions.length) problems.push('no actions discovered -- ACTIONS is empty or failed to import');
    if (!easings.length) problems.push('no easings discovered -- EASING_NAMES is empty or failed to import');
    if (!c.stepFields.length) problems.push('the step-field registry is empty');
    if (!c.metaFields.length) problems.push('the meta-field registry is empty');
    for (const a of actions) {
        const entry = c.actions.find(x => x.name === a);
        if (!entry) problems.push(`action ${a} missing from capabilities()`);
        else if (!entry.description.trim()) problems.push(`action ${a} has an empty description`);
        if (!block.includes(`| \`${a}\` |`)) problems.push(`action ${a} missing from the generated AGENTS.md block`);
    }
    for (const e of easings) {
        if (!c.easings.some(x => x.name === e && x.description.trim())) problems.push(`easing ${e} missing or undescribed in capabilities()`);
        if (!block.includes(`| \`${e}\` |`)) problems.push(`easing ${e} missing from the generated block`);
    }
    for (const f of c.stepFields.flatMap(x => x.names)) if (!block.includes(`\`${f}\``)) problems.push(`step field ${f} missing from the generated block`);
    return problems;
}

/** `step.<field>` / `s.<field>` reads in a source text. */
function fieldReads(text: string, receiver: string): Set<string> {
    const re = new RegExp(`\\b${receiver}\\.([A-Za-z_]\\w*)\\b(?!\\s*\\()`, 'g');
    return new Set([...text.matchAll(re)].map(m => m[1]));
}

test('every action, easing and step field is described, rendered into AGENTS.md and printed by capabilities()', () => {
    const block = renderCapabilitiesMarkdown();
    assert.deepEqual(auditRegistry(capabilities(), block, ACTIONS, EASING_NAMES), []);
    // The block AGENTS.md carries -- the file the hub serves byte for byte at /agents.md
    // (test/studio.test.ts) -- is this rendering, not a stale copy.
    const manual = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.equal(currentBlock(manual, 'AGENTS.md', CAP_START, CAP_END), block, 'AGENTS.md capability tables are stale: run `npm run docs`');
});

test('the real `capabilities --json` prints the same registry (every action, easing and field)', () => {
    const args = ['capabilities', '--json'];
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
    assertRan(res, args);
    assert.equal(res.status, 0, res.stderr);
    const printed = JSON.parse(res.stdout) as Capabilities;
    assert.deepEqual(printed, capabilities());
    assert.deepEqual(printed.actions.map(a => a.name).sort(), [...ACTIONS].sort());
    assert.deepEqual(printed.easings.map(e => e.name), [...EASING_NAMES]);
    assert.deepEqual(printed.presets, readPresets(), 'the studio palette is part of the capability list');
});

test('every step field the validator or the runtime reads is a documented field', () => {
    const documented = new Set([...documentedStepFields(), ...COMPUTED_STEP_FIELDS]);
    const schemaText = fs.readFileSync(path.join(root, 'src/engine/schema.ts'), 'utf8');
    const validator = schemaText.slice(schemaText.indexOf('export function validateTimeline('), schemaText.indexOf('export function hasErrors('));
    const fromValidator = fieldReads(validator, 's');
    const fromRuntime = fieldReads(runtimeSource(), 'step');
    assert.ok(fromValidator.size > 10, `validator scan found ${fromValidator.size} field reads -- the slice markers moved`);
    assert.ok(fromRuntime.size > 10, `runtime scan found ${fromRuntime.size} field reads -- the receiver name changed`);
    const undocumented = [...fromValidator, ...fromRuntime].filter(f => !documented.has(f));
    assert.deepEqual([...new Set(undocumented)].sort(), [], 'fields read by the engine but absent from STEP_FIELD_DOCS: describe them in src/engine/schema.ts');
});

test('every meta field the validator reads is a documented meta field', () => {
    const documented = new Set(META_FIELD_DOCS.flatMap(f => [...f.names]));
    const schemaText = fs.readFileSync(path.join(root, 'src/engine/schema.ts'), 'utf8');
    const validator = schemaText.slice(schemaText.indexOf('export function validateTimeline('), schemaText.indexOf('export function hasErrors('));
    const reads = fieldReads(validator, 'meta');
    assert.ok(reads.size >= 3, 'validator meta scan found nothing -- the receiver name changed');
    assert.deepEqual([...reads].filter(f => !documented.has(f)).sort(), [], 'meta fields validated but absent from META_FIELD_DOCS');
});

test('the studio registry agrees with the schema registry (actions, placements, easings, field keys)', () => {
    const studio = fs.readFileSync(path.join(root, 'src/studio/app/studio.js'), 'utf8');
    const arr = (name: string) => {
        const m = new RegExp(`var ${name} = \\[([^\\]]*)\\];`).exec(studio);
        assert.ok(m, `studio.js defines ${name}`);
        return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    };
    assert.deepEqual(arr('ACTIONS'), [...ACTIONS], 'studio ACTIONS differs from schema ACTIONS');
    assert.deepEqual(arr('SUBTITLE_PLACES'), [...SUBTITLE_PLACES]);
    // Easings: the studio previews the real curve, so names AND beziers must equal runtime.js.
    const curves = (text: string) => {
        const m = /var EASINGS = \{([\s\S]*?)\};/.exec(text);
        assert.ok(m, 'EASINGS block found');
        return Object.fromEntries([...m![1].matchAll(/^\s*([A-Za-z]+):\s*'([^']+)'/gm)].map(x => [x[1], x[2]]));
    };
    assert.deepEqual(curves(studio), curves(runtimeSource()), 'studio EASINGS differ from runtime.js EASINGS');
    // Inspector widgets: every key it edits is a documented step field, and every action has a row set.
    const keys = new Set([...studio.matchAll(/\{\s*k:\s*'([A-Za-z]+)'/g)].map(m => m[1]));
    assert.ok(keys.size > 15, `studio field scan found ${keys.size} keys -- the registry shape changed`);
    const documented = new Set(documentedStepFields());
    assert.deepEqual([...keys].filter(k => !documented.has(k)).sort(), [], 'studio edits fields the schema registry does not describe');
    const fAction = /var F_ACTION = \{([\s\S]*?)\n {2}\};/.exec(studio);
    assert.ok(fAction, 'studio.js defines F_ACTION');
    const rows = new Set([...fAction![1].matchAll(/^ {4}([A-Za-z]+):/gm)].map(m => m[1]));
    assert.deepEqual([...ACTIONS].filter(a => !rows.has(a)), [], 'an action has no inspector row set in F_ACTION');
});

test('self-test: a planted undescribed action, an undescribed easing and an empty registry all go red', () => {
    // Planted action: capabilities() refuses to render a capability nobody can discover.
    (ACTIONS as unknown as string[]).push('planted');
    try {
        assert.throws(() => capabilities(), /no description for action\(s\) planted/);
    } finally {
        (ACTIONS as unknown as string[]).pop();
    }
    const saved = ACTION_DOCS.wait;
    delete (ACTION_DOCS as any).wait;
    try { assert.throws(() => capabilities(), /wait/); } finally { (ACTION_DOCS as any).wait = saved; }
    const savedEase = EASING_DOCS.spring;
    delete (EASING_DOCS as any).spring;
    try { assert.throws(() => capabilities(), /spring/); } finally { (EASING_DOCS as any).spring = savedEase; }

    // The audit itself: an action the block does not carry is named, and empty discovery is red.
    const c = capabilities();
    const block = renderCapabilitiesMarkdown(c);
    assert.match(auditRegistry(c, block, [...ACTIONS, 'ghost'], EASING_NAMES).join('\n'), /ghost missing from capabilities\(\)/);
    assert.match(auditRegistry(c, block.replace('| `spring` |', '| spring |'), ACTIONS, EASING_NAMES).join('\n'), /easing spring missing from the generated block/);
    const empty = auditRegistry({ ...c, stepFields: [], metaFields: [] }, '', [], []);
    assert.ok(empty.some(p => /no actions discovered/.test(p)) && empty.some(p => /step-field registry is empty/.test(p)), empty.join('\n'));

    // The field scan sees a planted read.
    assert.ok(fieldReads('if (step.plantedField) x();', 'step').has('plantedField'));
    assert.ok(!fieldReads('step.markStep(1)', 'step').has('markStep'), 'a method call is not a field read');
});
