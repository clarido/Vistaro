import * as fs from 'fs';
import * as path from 'path';
import { Issue, Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, CURSOR_ACTIONS, TARGET_REQUIRED } from '../engine/schema';
import { runTimeline, ensureRuntime } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions } from '../browser';

export interface CheckOptions extends ViewportOptions {
    static?: boolean;
    json?: boolean;
    locale?: string;
}

interface TargetProbe {
    error?: string;
    count: number;
    rendered?: boolean;
    width?: number;
    height?: number;
    display?: string;
    visibility?: string;
    opacity?: number;
    inViewport?: boolean;
}

function issueFor(step: Step, level: Issue['level'], message: string, field = 'target'): Issue {
    return { level, step: step.index, id: step.id, field, message, time: step.time, action: step.action, target: step.target };
}

/** Run the timeline in a headless page (step mode, instant) and probe each target right before its step. */
export async function browserCheck(dir: string, timeline: Timeline, opts: ViewportOptions): Promise<Issue[]> {
    const issues: Issue[] = [];
    const htmlPath = path.resolve(dir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        issues.push({ level: 'error', message: `${htmlPath} not found` });
        return issues;
    }
    const launched = await launchPage({ ...opts, deviceScaleFactor: 1 });
    const { page } = launched;
    const pageErrors: string[] = [];
    const reportedMissing = new Set<number>();
    page.on('pageerror', e => pageErrors.push(e.message));
    try {
        await page.goto(fileUrl(htmlPath), { waitUntil: 'load' });
        await ensureRuntime(page, timeline, { drift: false });
        await runTimeline(page, timeline, {
            mode: 'step',
            instant: true,
            settleMs: 0,
            beforeStep: async (step) => {
                if (typeof step.target !== 'string' || !step.target.trim()) return;
                const probe: TargetProbe = await page.evaluate((sel: string) => {
                    let all: NodeListOf<Element>;
                    try { all = document.querySelectorAll(sel); } catch (e: any) { return { error: e.message, count: 0 }; }
                    if (!all.length) return { count: 0 };
                    const el = all[0];
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    // checkVisibility() is false when the element or an ancestor is display:none / visibility:hidden.
                    const rendered = typeof (el as any).checkVisibility === 'function'
                        ? (el as any).checkVisibility({ visibilityProperty: true })
                        : cs.display !== 'none' && cs.visibility !== 'hidden';
                    return {
                        count: all.length, width: r.width, height: r.height, rendered,
                        display: cs.display, visibility: cs.visibility, opacity: parseFloat(cs.opacity),
                        inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
                    };
                }, step.target);
                if (probe.error) {
                    issues.push(issueFor(step, 'error', `invalid selector ${JSON.stringify(step.target)}: ${probe.error}`));
                    return;
                }
                if (probe.count === 0) {
                    issues.push(issueFor(step, TARGET_REQUIRED.has(step.action) ? 'error' : 'warning', `target ${JSON.stringify(step.target)} matches nothing in index.html at this point of the timeline`));
                    reportedMissing.add(step.index);
                    return;
                }
                if (probe.count > 1) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} matches ${probe.count} elements; the first one is used`));
                }
                const revealsTarget = step.action === 'fadeIn' || step.action === 'transitionScreen';
                if (!revealsTarget && probe.rendered === false) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is hidden when this step runs (display: ${probe.display}, visibility: ${probe.visibility}, or an ancestor is hidden)`));
                } else if (!revealsTarget && step.action !== 'type' && (!probe.width || !probe.height)) {
                    // An empty span/input being typed into is legitimately 0x0; anything else 0x0 is suspicious.
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has zero size when this step runs (${Math.round(probe.width || 0)}x${Math.round(probe.height || 0)}px)`));
                } else if (!revealsTarget && probe.opacity === 0) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has opacity 0 when this step runs`));
                } else if (!revealsTarget && step.action !== 'scroll' && CURSOR_ACTIONS.has(step.action) && probe.inViewport === false) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is outside the viewport when this step runs (add a "scroll" step first)`));
                }
            },
            afterStep: (step, result) => {
                // A missing target was already reported by the probe above; don't list it twice.
                if (result.error && !reportedMissing.has(step.index)) {
                    issues.push(issueFor(step, 'error', `step failed in the browser: ${result.error}`, 'action'));
                }
            },
        });
    } finally {
        await launched.close();
    }
    for (const msg of pageErrors) issues.push({ level: 'warning', message: `page error while running the timeline: ${msg}` });
    return issues;
}

export async function checkCommand(dir: string, options: CheckOptions = {}): Promise<void> {
    const log = options.json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    let issues: Issue[] = [];
    let timeline: Timeline | undefined;
    let note = '';
    try {
        timeline = loadTimeline(dir, { locale: options.locale });
    } catch (e: any) {
        issues.push({ level: 'error', message: e.message });
    }
    if (timeline) {
        issues.push(...validateTimeline(timeline));
        if (!options.static && !hasErrors(issues.filter(i => i.field === 'time' || i.field === 'action'))) {
            issues.push(...await browserCheck(dir, timeline, options));
        } else if (!options.static) {
            note = 'Browser pass skipped until the timing/action errors above are fixed.';
        }
    }
    issues.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));

    const errors = issues.filter(i => i.level === 'error').length;
    const warnings = issues.length - errors;
    if (options.json) {
        process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
    } else {
        for (const issue of issues) console.log(formatIssue(issue));
        const where = path.resolve(dir, 'anim.config.json');
        if (issues.length === 0) console.log(`OK: ${where} (${timeline!.steps.length} steps, ${options.static ? 'static' : 'static + browser'} check).`);
        else console.log(`\n${errors} error(s), ${warnings} warning(s) in ${where}${options.static ? ' (static check only)' : ''}.`);
    }
    if (note) log(note);
    process.exitCode = errors > 0 ? 1 : 0;
}
