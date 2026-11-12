import * as fs from 'fs';
import * as path from 'path';
import {
    ACTIONS, ACTION_DOCS, ACTION_DOC_ORDER, TARGET_REQUIRED, CURSOR_ACTIONS, STATE_ACTIONS,
    EASING_NAMES, EASING_DOCS, STEP_FIELD_DOCS, META_FIELD_DOCS, DEVICE_KINDS, SUBTITLE_PLACES,
    TIMELINE_KINDS, AUTOPLAY_MODES, CURSOR_STYLES, FieldDoc, MOTION_TOKEN_DOCS, BRAND_TOKEN_DOCS, MOTION_TOKENS, DEFAULT_MOTION_S, LOGO_PLACES,
} from '../engine/schema';

/**
 * `capabilities`: everything a timeline can say, rendered from the one registry in schema.ts plus
 * the studio's preset file. The same data renders the tables between the capabilities markers in
 * AGENTS.md (scripts/gen-cli-reference.ts), so the manual, the command and the validator agree by
 * construction. An agent reads `capabilities --json`; a person reads the plain output.
 */

export const PRESETS_PATH = path.join(__dirname, '..', 'studio', 'app', 'presets.json');

export interface PresetEntry { name: string; fields: Record<string, unknown> }
export type Presets = Record<string, PresetEntry[]>;

export function readPresets(file = PRESETS_PATH): Presets {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface Capabilities {
    version: 1;
    actions: { name: string; targetRequired: boolean; cursor: boolean; capture: 'interaction' | 'completion'; description: string; guideFrame: string }[];
    stepFields: { names: string[]; description: string }[];
    metaFields: { names: string[]; description: string }[];
    motionTokens: { names: string[]; description: string }[];
    brandTokens: { names: string[]; description: string }[];
    motionDefaults: Record<string, number>;
    logoPlaces: string[];
    easings: { name: string; description: string }[];
    presets: Record<string, { name: string; fields: Record<string, unknown> }[]>;
    devices: string[];
    subtitlePlaces: string[];
    kinds: string[];
    autoplay: string[];
    cursors: string[];
}

const fields = (docs: readonly FieldDoc[]) => docs.map(f => ({ names: [...f.names], description: f.description }));

/** The registry as data. Throws when an action or easing has no description: a capability nobody can discover is a bug. */
export function capabilities(presets: Presets = readPresets()): Capabilities {
    const missing = ACTIONS.filter(a => !ACTION_DOCS[a] || !ACTION_DOCS[a].description);
    if (missing.length) throw new Error(`capability registry: no description for action(s) ${missing.join(', ')} (add them to ACTION_DOCS in src/engine/schema.ts)`);
    const missingEase = EASING_NAMES.filter(e => !EASING_DOCS[e]);
    if (missingEase.length) throw new Error(`capability registry: no description for easing(s) ${missingEase.join(', ')} (add them to EASING_DOCS in src/engine/schema.ts)`);
    const ordered = [...ACTION_DOC_ORDER, ...ACTIONS.filter(a => !ACTION_DOC_ORDER.includes(a))];
    return {
        version: 1,
        actions: ordered.map(a => ({
            name: a,
            targetRequired: TARGET_REQUIRED.has(a),
            cursor: CURSOR_ACTIONS.has(a),
            capture: STATE_ACTIONS.has(a) ? 'completion' : 'interaction',
            description: ACTION_DOCS[a].description,
            guideFrame: ACTION_DOCS[a].guideFrame,
        })),
        stepFields: fields(STEP_FIELD_DOCS),
        metaFields: fields(META_FIELD_DOCS),
        motionTokens: fields(MOTION_TOKEN_DOCS),
        brandTokens: fields(BRAND_TOKEN_DOCS),
        motionDefaults: Object.fromEntries(MOTION_TOKENS.map(t => [t, DEFAULT_MOTION_S[t]])),
        logoPlaces: [...LOGO_PLACES],
        easings: EASING_NAMES.map(e => ({ name: e, description: EASING_DOCS[e] })),
        presets,
        devices: [...DEVICE_KINDS],
        subtitlePlaces: [...SUBTITLE_PLACES],
        kinds: [...TIMELINE_KINDS],
        autoplay: [...AUTOPLAY_MODES],
        cursors: [...CURSOR_STYLES],
    };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const names = (ns: string[]) => ns.map(n => `\`${n}\``).join(' / ');

/** The markdown block written between the capabilities markers in AGENTS.md (without the markers). */
export function renderCapabilitiesMarkdown(c: Capabilities = capabilities()): string {
    const out: string[] = [
        'Generated from the capability registry in `src/engine/schema.ts` by `npm run docs`; do not edit by hand. `npx tsx cli.ts capabilities --json` prints the same data for an agent.',
        '',
        '### `meta`',
        '',
        '| Field | Meaning |',
        '|---|---|',
        ...c.metaFields.map(f => `| ${names(f.names)} | ${cell(f.description)} |`),
        '',
        '### Steps',
        '',
        '| Field | Meaning |',
        '|---|---|',
        ...c.stepFields.map(f => `| ${names(f.names)} | ${cell(f.description)} |`),
        '',
        '### Actions and the guide capture rule',
        '',
        '| Action | What happens | Guide frame taken |',
        '|---|---|---|',
        ...c.actions.map(a => `| \`${a.name}\` | ${cell(a.description)} | ${cell(a.guideFrame)} |`),
        '',
        '### Motion tokens (`meta.motion`)',
        '',
        '| Token | Meaning |',
        '|---|---|',
        ...c.motionTokens.map(f => `| ${names(f.names)} | ${cell(f.description)} |`),
        '',
        '### Brand tokens (`meta.brand`)',
        '',
        '| Token | Meaning |',
        '|---|---|',
        ...c.brandTokens.map(f => `| ${names(f.names)} | ${cell(f.description)} |`),
        '',
        '### Easings',
        '',
        '| Name | Feel |',
        '|---|---|',
        ...c.easings.map(e => `| \`${e.name}\` | ${cell(e.description)} |`),
        '',
    ];
    return out.join('\n');
}

/** Plain, terminal-width output for a person. */
export function renderCapabilitiesText(c: Capabilities): string {
    const lines: string[] = [];
    const section = (t: string) => { lines.push('', t, '-'.repeat(t.length)); };
    section('Actions');
    for (const a of c.actions) {
        const tags = [a.targetRequired ? 'target required' : 'no target needed', `guide frame at ${a.capture}`].join(', ');
        lines.push(`  ${a.name.padEnd(17)} ${tags}`);
    }
    section('Step fields');
    lines.push('  ' + c.stepFields.flatMap(f => f.names).join(', '));
    section('Meta fields');
    lines.push('  ' + c.metaFields.flatMap(f => f.names).join(', '));
    section('Motion tokens (meta.motion)');
    lines.push('  ' + c.motionTokens.flatMap(f => f.names).join(', '));
    section('Brand tokens (meta.brand)');
    lines.push('  ' + c.brandTokens.flatMap(f => f.names).join(', '));
    section('Easings');
    for (const e of c.easings) lines.push(`  ${e.name.padEnd(17)} ${e.description}`);
    for (const [group, list] of Object.entries(c.presets)) {
        section(`Studio presets: ${group}`);
        for (const p of list) lines.push(`  ${p.name}`);
    }
    section('Enumerations');
    lines.push(`  devices          ${c.devices.join(', ')}`);
    lines.push(`  subtitlePlace    ${c.subtitlePlaces.join(', ')}`);
    lines.push(`  meta.kind        ${c.kinds.join(', ')}`);
    lines.push(`  meta.cursor      ${c.cursors.join(', ')}`);
    lines.push(`  reel.autoplay    ${c.autoplay.join(', ')}`);
    lines.push('', 'Full descriptions: capabilities --json, or the tables in AGENTS.md.');
    return lines.join('\n').replace(/^\n/, '') + '\n';
}

export function capabilitiesCommand(options: { json?: boolean } = {}): void {
    const c = capabilities();
    process.stdout.write(options.json ? JSON.stringify(c, null, 2) + '\n' : renderCapabilitiesText(c));
}
