import * as fs from 'fs';
import * as path from 'path';
import type { Timeline, Step } from './schema';

/**
 * Localization strings: a flat map `strings.<locale>.json` next to anim.config.json.
 *
 *   { "meta.title": "…", "steps.<id>.title": "…", "steps.<id>.subtitle": "…",
 *     "steps.<id>.narration": "…", "steps.<id>.note": "…", "steps.<id>.value": "…" }
 *
 * `value` is only extracted/applied for steps marked `translatable: true` (typed text that is
 * language-specific). Missing or empty keys fall back to the inline text in anim.config.json.
 */

export type StringMap = Record<string, string>;

export const STEP_STRING_FIELDS = ['title', 'subtitle', 'narration', 'note'] as const;

export function stringsFileName(locale: string): string {
    return `strings.${locale}.json`;
}

export function stringsPath(dir: string, locale: string): string {
    return path.join(dir, stringsFileName(locale));
}

/** Every translatable string of a timeline, keyed as documented above (inline values). */
export function extractStrings(timeline: Timeline): StringMap {
    const out: StringMap = {};
    if (typeof timeline.meta.title === 'string' && timeline.meta.title.trim()) out['meta.title'] = timeline.meta.title;
    for (const step of timeline.steps) {
        for (const field of STEP_STRING_FIELDS) {
            const v = step[field];
            if (typeof v === 'string' && v.trim()) out[`steps.${step.id}.${field}`] = v;
        }
        if (step.translatable && typeof step.value === 'string' && step.value) out[`steps.${step.id}.value`] = step.value;
    }
    return out;
}

export interface ApplyReport {
    /** Keys that were applied. */
    applied: string[];
    /** Keys present in the strings file that match no step/field. */
    unknown: string[];
    /** Extractable keys with no (non-empty) translation: inline text was used. */
    missing: string[];
    /** Keys whose translation is still identical to the inline (source) text. */
    untranslated: string[];
}

/** Overlay `strings` on the timeline in place; empty/missing keys keep the inline text. */
export function applyStrings(timeline: Timeline, strings: StringMap): ApplyReport {
    const report: ApplyReport = { applied: [], unknown: [], missing: [], untranslated: [] };
    const known = new Set<string>();
    const use = (key: string, current: string, set: (v: string) => void) => {
        known.add(key);
        const v = strings[key];
        if (typeof v === 'string' && v.trim()) {
            set(v);
            report.applied.push(key);
            if (v === current) report.untranslated.push(key);
        } else report.missing.push(key);
    };
    if (typeof timeline.meta.title === 'string' && timeline.meta.title.trim()) use('meta.title', timeline.meta.title, v => { timeline.meta.title = v; });
    const byId = new Map<string, Step>(timeline.steps.map(s => [s.id, s]));
    for (const step of timeline.steps) {
        for (const field of STEP_STRING_FIELDS) {
            if (typeof step[field] === 'string' && (step[field] as string).trim()) use(`steps.${step.id}.${field}`, step[field] as string, v => { (step as any)[field] = v; });
        }
        if (step.translatable && typeof step.value === 'string' && step.value) use(`steps.${step.id}.value`, step.value, v => { step.value = v; });
    }
    for (const key of Object.keys(strings)) {
        if (known.has(key)) continue;
        // A key for a real step/field that has no inline text is still "unknown" for reporting: nothing to override.
        const m = /^steps\.(.+)\.(title|subtitle|narration|note|value)$/.exec(key);
        if (m && byId.has(m[1]) && strings[key] && strings[key].trim()) {
            const step = byId.get(m[1])!;
            if (m[2] === 'value' && !step.translatable) { report.unknown.push(key); continue; }
            (step as any)[m[2]] = strings[key];
            report.applied.push(key);
            continue;
        }
        if (key !== 'meta.title') report.unknown.push(key);
        else if (strings[key] && strings[key].trim()) { timeline.meta.title = strings[key]; report.applied.push(key); }
    }
    return report;
}

export function readStrings(file: string): StringMap {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file}: expected a JSON object of "key": "text"`);
    const out: StringMap = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== 'string') throw new Error(`${file}: value of "${k}" must be a string`);
        out[k] = v;
    }
    return out;
}

export function writeStrings(file: string, strings: StringMap): void {
    fs.writeFileSync(file, JSON.stringify(strings, null, 2) + '\n');
}

/**
 * Resolve the locale a directory should render in: an explicit request wins, then the manifest
 * (set by `localize`), then the timeline's own meta.locale.
 */
export function resolveLocale(requested: string | undefined, manifestLocale: string | undefined, metaLocale: string | undefined): string | undefined {
    return requested || manifestLocale || metaLocale || undefined;
}
