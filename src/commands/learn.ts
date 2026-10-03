import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'playwright';
import { Step, parseTimeline, validateTimeline, formatIssue, hasErrors } from '../engine/schema';
import { StepResult, errorMessage } from '../engine/driver';
import { sanitizeUrl } from '../browser';

/**
 * `record --learn <out.json>` (experimental): the capture -> timeline loop.
 *
 * While the recording pass drives the live page (runExport with a session), a collector hooked into
 * the driver's `afterStep` records every interaction the recording really performed
 * (click/type/press/navigate), re-resolving each target to the stablest selector the page can
 * offer -- the same preference order the manual tells app authors to design for:
 * `[data-help="..."]`, then `#id`, then `tag.class`, then a positional `tag:nth-of-type()` fallback.
 * Afterwards the observations are synthesized into a DRAFT anim.config.json (ids step-01..., times
 * in ms, no titles -- tool-written titles would leak English boilerplate into localized guides),
 * pushed through the same parse/validation the CLI uses, and written beside a short human note.
 *
 * The draft is a transcript for an author to clean up, never a finished timeline.
 */

/** The actions the learn pass records; everything else is choreography or chrome, not an interaction. */
const LEARNED_ACTIONS: ReadonlySet<string> = new Set(['click', 'type', 'press', 'navigate']);

/**
 * The re-resolve probe runs inside the recording pass, so it can never be allowed to hold it: a
 * page whose main thread is blocked would hang the recording forever (page.evaluate takes no
 * timeout of its own, and every evaluate the driver makes is bounded -- this one must be too).
 */
const LEARN_PROBE_TIMEOUT_MS = 5000;

function withTimeoutMs<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); });
    });
}

/** How a learned target was derived, in the manual's preference order; `authored` = could not re-resolve. */
export type TargetKind = 'data-help' | 'id' | 'class' | 'fallback' | 'authored';

export interface LearnedInteraction {
    action: 'click' | 'type' | 'press' | 'navigate';
    /** Observed interaction moment, in ms since the recording's t0 (the first navigation's start). */
    timeMs: number;
    /** Best stable selector for the element (click/type); absent for press/navigate. */
    target?: string;
    kind?: TargetKind;
    /** The learned selector matched exactly one element at capture time. */
    unique?: boolean;
    /** `type`: the text that was typed; `press`: the key. */
    value?: string;
    /** `navigate`: the URL that was opened. */
    url?: string;
    /** The timeline's own selector, when the learned one differs. */
    sourceTarget?: string;
    /** The interaction itself navigated: the element's document was gone at capture time. */
    navigated?: boolean;
}

export interface LearnRunInfo {
    /** The URL the recording drove (sanitized into the draft's meta.url). */
    url: string;
    /** Recording steps that failed (named in the notes; never in the draft). */
    failed: number;
    /** Recording steps that are not interactions (highlight/hover/focus/camera/wait/chrome). */
    skipped: number;
}

export interface LearnSummary {
    steps: number;
    /** Absolute path of the draft timeline; absent when nothing was captured. */
    output?: string;
    /** Absolute path of the human note (<out>.notes.md). */
    notes?: string;
}

export interface LearnCollector {
    captured: LearnedInteraction[];
    info: LearnRunInfo;
    /** The driver hook: never throws (a throwing afterStep would fail the recording), never blocks it. */
    afterStep: (step: Step, result: StepResult) => Promise<void>;
}

/**
 * The collector. Its hook runs right after each step's interaction, while the element is still in
 * the document -- unless the interaction navigated, in which case only the timeline's own selector
 * survives (recorded as `authored`, unverified). All failures degrade to a warning and a failed
 * count: learning must never turn a good recording into a failed one.
 */
export function learnCollector(page: Page, warn: (message: string) => void): LearnCollector {
    const captured: LearnedInteraction[] = [];
    const info: LearnRunInfo = { url: '', failed: 0, skipped: 0 };
    const afterStep = async (step: Step, result: StepResult): Promise<void> => {
        if (!LEARNED_ACTIONS.has(step.action)) { info.skipped++; return; }
        // A failed step is not an observed interaction (no draft entry, one line in the notes).
        if (result.error || !(result.actualMs >= 0)) { info.failed++; return; }
        // An empty typed value cannot be learned: the schema rejects empty type values, and the
        // draft must stay valid -- skip the step rather than abort a successful recording.
        if (step.action === 'type' && String(step.value ?? '') === '') {
            info.skipped++;
            warn(`--learn: step ${step.index} typed an empty value; it is left out of the draft (the schema rejects empty type values)`);
            return;
        }
        try {
            const rec: LearnedInteraction = { action: step.action as LearnedInteraction['action'], timeMs: Math.round(result.actualMs) };
            if (step.action === 'navigate') {
                rec.url = String(step.url ?? '');
            } else if (step.action === 'press') {
                rec.value = String(step.value ?? '');
            } else {
                rec.sourceTarget = step.target;
                if (result.navigated) {
                    rec.target = step.target; rec.kind = 'authored'; rec.navigated = true;
                } else {
                    // RULES FOR page.evaluate CALLBACKS: no inner functions (see driver.ts) -- the
                    // selector walk below is straight-line on purpose; helpers cannot live here and
                    // the runtime is not told about --learn.
                    let probe: { found: boolean; selector?: string; kind?: string; unique?: boolean } | null = null;
                    try {
                        probe = await withTimeoutMs(page.evaluate((sel: string) => {
                        var el = document.querySelector(sel);
                        if (!el) return { found: false };
                        var node = el;
                        var kind = 'fallback';
                        var selector = '';
                        var dataHelp = node.getAttribute('data-help');
                        if (dataHelp !== null && dataHelp !== '') {
                            kind = 'data-help';
                            selector = '[data-help=' + JSON.stringify(dataHelp) + ']';
                        } else if (node.id) {
                            kind = 'id';
                            selector = '#' + CSS.escape(node.id);
                        } else {
                            var tag = node.tagName.toLowerCase();
                            var classes = '';
                            for (var i = 0; i < node.classList.length; i++) classes += '.' + CSS.escape(node.classList[i]);
                            var nth = '';
                            var parent = node.parentElement;
                            if (parent) {
                                var same = 0, mine = 0;
                                for (var j = 0; j < parent.children.length; j++) {
                                    if (parent.children[j].tagName === node.tagName) {
                                        same++;
                                        if (parent.children[j] === node) mine = same;
                                    }
                                }
                                if (same > 1) nth = ':nth-of-type(' + mine + ')';
                            }
                            kind = classes ? 'class' : 'fallback';
                            selector = tag + classes + nth;
                        }
                        return { found: true, selector: selector, kind: kind, unique: document.querySelectorAll(selector).length === 1 };
                    }, String(step.target)), LEARN_PROBE_TIMEOUT_MS, '--learn target probe');
                    } catch (e: any) {
                        // Most often "execution context was destroyed": the interaction navigated
                        // after runStep resolved but before the probe ran, so the re-resolve never
                        // had a page to ask. The authored selector is still the best known fact
                        // about the element -- record it, never drop the interaction.
                        warn(`--learn: could not re-resolve step ${step.index}'s target in the page (${errorMessage(e)}); keeping the authored selector`);
                    }
                    if (probe && probe.found && probe.selector) {
                        rec.target = probe.selector;
                        rec.kind = probe.kind as TargetKind;
                        rec.unique = probe.unique;
                    } else {
                        // The app removed (or never kept) the element: the authored selector is all
                        // that is known about it.
                        rec.target = step.target; rec.kind = 'authored';
                    }
                }
                if (step.action === 'type') rec.value = String(step.value ?? '');
            }
            captured.push(rec);
        } catch (e: any) {
            info.failed++;
            warn(`--learn: could not record step ${step.index} (${step.action}${step.target ? ' ' + step.target : ''}): ${errorMessage(e)}`);
        }
    };
    return { captured, info, afterStep };
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

/** Captures in observed order (stable: equal times keep capture order). */
function orderedCaptures(captured: LearnedInteraction[]): LearnedInteraction[] {
    return [...captured].sort((a, b) => a.timeMs - b.timeMs);
}

/** Object form of the draft timeline: observed time order, `step-NN` ids, times in ms, no titles. */
export function synthesizeLearnedTimeline(captured: LearnedInteraction[], meta: { url?: string }): { meta: Record<string, any>; steps: Record<string, any>[] } {
    const steps = orderedCaptures(captured).map((c, i) => {
        const step: Record<string, any> = { id: `step-${pad2(i + 1)}`, time: `${Math.max(0, Math.round(c.timeMs))}ms`, action: c.action };
        if (c.target) step.target = c.target;
        if ((c.action === 'type' || c.action === 'press') && c.value !== undefined) step.value = c.value;
        if (c.action === 'navigate' && c.url !== undefined) step.url = c.url;
        return step;
    });
    const timelineMeta: Record<string, any> = {};
    if (meta.url) timelineMeta.url = meta.url;
    return { meta: timelineMeta, steps };
}

const KIND_NOTE: Record<TargetKind, string> = {
    'data-help': 'a [data-help] attribute -- the stable kind the manual asks app authors to provide',
    'id': 'an #id -- stable while the app keeps the id',
    'class': 'tag.class -- class names are often generated; confirm the app owns this one',
    'fallback': 'positional (bare tag / :nth-of-type) -- breaks on any DOM change around the element',
    'authored': 'kept as authored -- the element could not be re-resolved at capture time; verify it by hand',
};

/** A target worth a line in the notes: positional, unverifiable, ambiguous, or a bare class. */
function isFragile(c: LearnedInteraction): boolean {
    return c.kind === 'fallback' || c.kind === 'authored' || c.unique === false || c.kind === 'class';
}

function quoted(v: string | undefined): string {
    if (v === undefined) return '--';
    return '`' + String(v).replace(/`/g, "'") + '`';
}

function notesMarkdown(draftName: string, draft: { meta: Record<string, any>; steps: Record<string, any>[] }, captured: LearnedInteraction[], info: LearnRunInfo): string {
    const ordered = orderedCaptures(captured);
    const rows = draft.steps.map((s, i) => {
        const c = ordered[i];
        const kind = c.kind && isFragile(c) ? ` (${c.kind})` : '';
        return `| ${i + 1} | ${s.time} | ${s.action} | ${s.target ? quoted(s.target) + kind : '--'} | ${quoted(s.value)} |`;
    });
    const lines: string[] = [
        '# Learned timeline (draft)',
        '',
        `Written by \`record --learn\` from a recording of ${info.url}.`,
        `\`${draftName}\`, the draft timeline beside this note, holds ${draft.steps.length} interaction(s) the recording performed, in observed order. It is a transcript to clean up, not a finished timeline.`,
        '',
        '## What was captured',
        '',
        '| # | at | action | target | value |',
        '|---|----|--------|--------|-------|',
        ...rows,
        '',
        'Times are the observed interaction moments in ms since the recording started; the draft replays them in that order. Only click / type / press / navigate are learned: '
            + (info.skipped ? `${info.skipped} other recording step(s) (highlight, hover, camera, ...) are not interactions and are not in the draft` : 'the recording ran no other kind of step')
            + (info.failed ? `, and ${info.failed} step(s) failed and are left out` : '') + '.',
        '',
        '## Selectors to check',
        '',
    ];
    const fragile = ordered.filter(isFragile);
    if (fragile.length) {
        ordered.forEach((c, i) => {
            if (!isFragile(c)) return;
            lines.push(`- step ${i + 1} -- ${quoted(c.target)}: ${KIND_NOTE[c.kind!]}${c.unique === false ? '; it matched more than one element at capture time' : ''}.`);
        });
    } else {
        lines.push('Every target resolved to a `data-help` attribute or an id and matched exactly one element -- nothing fragile.');
    }
    lines.push(
        '',
        'Learned targets follow the manual\'s preference order: `[data-help="..."]`, then `#id`, then `tag.class`, then a positional `tag:nth-of-type()` fallback.',
        '',
        '## What to title',
        '',
        'The draft carries no titles on purpose: tool-written titles would leak English boilerplate into localized guides. Before a guide can be built (`check --guide` errors; `export --guide` / `record --guide` refuse without them):',
        '',
        '- give every numbered step a `title`, and a `subtitle` / `narration` when the video should speak;',
        '- set `meta.title` (the guide\'s H1);',
        '- hide pure choreography with `"guide": false`;',
        '- probe the draft against the app first: `npx tsx cli.ts check <dir> --live --url <url>`.',
        '',
    );
    return lines.join('\n');
}

/**
 * Synthesize, validate through the same parse the CLI uses, and write the draft timeline plus its
 * human note. Throws when called with nothing captured (the caller turns that into exit 1) or when
 * the synthesized draft fails its own validation (an internal invariant -- the shapes written above
 * are the schema's own).
 */
export function writeLearnDraft(outPath: string, captured: LearnedInteraction[], info: LearnRunInfo): LearnSummary {
    if (!captured.length) throw new Error('--learn: nothing was captured (no successful click/type/press/navigate step during the recording)');
    const draft = synthesizeLearnedTimeline(captured, { url: sanitizeUrl(info.url) });
    const issues = validateTimeline(parseTimeline(draft), { live: true });
    if (hasErrors(issues)) {
        throw new Error(`--learn: the synthesized draft does not validate: ${issues.filter(i => i.level === 'error').map(formatIssue).join('; ')}`);
    }
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(draft, null, 2) + '\n');
    // The file on disk must clear the same parse an author's tools will run on it.
    const reread = parseTimeline(JSON.parse(fs.readFileSync(abs, 'utf8')));
    const rereadIssues = validateTimeline(reread, { live: true });
    if (hasErrors(rereadIssues)) {
        throw new Error(`--learn: the written draft does not re-validate: ${rereadIssues.filter(i => i.level === 'error').map(formatIssue).join('; ')}`);
    }
    const notesPath = abs + '.notes.md';
    fs.writeFileSync(notesPath, notesMarkdown(path.basename(abs), draft, captured, info));
    return { steps: draft.steps.length, output: abs, notes: notesPath };
}
