import * as fs from 'fs';
import * as path from 'path';
import { Issue, Step, Timeline, loadTimeline, validateTimeline, formatIssue, hasErrors, CURSOR_ACTIONS, TARGET_REQUIRED } from '../engine/schema';
import { runTimeline, ensureRuntime } from '../engine/driver';
import { launchPage, fileUrl, ViewportOptions } from '../browser';
import { extractStrings, isAutoStepId } from '../engine/strings';

export interface CheckOptions extends ViewportOptions {
    static?: boolean;
    /** Validate for `record` (a live page): navigate/waitFor are expected, no index.html and no browser probe. */
    live?: boolean;
    json?: boolean;
    locale?: string;
}

interface TargetProbe {
    error?: string;
    count: number;
    rendered?: boolean;
    clipped?: boolean;
    anchored?: boolean;
    anchorSelector?: string;
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
export async function browserCheck(dir: string, timeline: Timeline, opts: ViewportOptions, staticIssues: Issue[] = []): Promise<Issue[]> {
    const issues: Issue[] = [];
    // Steps whose target is already statically wrong would only produce a duplicate browser error.
    const staticTargetErrors = new Set(staticIssues.filter(i => i.level === 'error' && i.field === 'target').map(i => i.step));
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
                    const anim = (window as any).__anim;
                    const anchor = anim.anchorOf(el);
                    const ar = anchor.getBoundingClientRect();
                    // No inner function declarations here: tsx/esbuild would wrap them in a `__name`
                    // helper that does not exist inside the page (the callback is serialized by Playwright).
                    // The runtime scrolls a clipped target into view before interacting; mirror that here
                    // so the warning only fires when scrolling cannot reveal it.
                    let clipped = anim.isClipped(el);
                    if (clipped) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); clipped = anim.isClipped(el); }
                    return {
                        count: all.length, width: r.width, height: r.height, rendered, clipped,
                        anchored: anchor !== el && ar.width > 0 && ar.height > 0,
                        anchorSelector: anchor !== el ? anim.selectorOf(anchor) : undefined,
                        display: cs.display, visibility: cs.visibility, opacity: parseFloat(cs.opacity),
                        inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
                    };
                }, step.target);
                if (process.env.ANIM_DEBUG) console.error(`probe step ${step.index} ${step.target}: ${JSON.stringify(probe)}`);
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
                } else if (!revealsTarget && (!probe.width || !probe.height) && !(step.action === 'type' && probe.anchored)) {
                    // An empty caret span being typed into is fine when a sized ancestor can carry the spotlight;
                    // any other 0x0 target renders nothing in the frame.
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has zero size when this step runs (${Math.round(probe.width || 0)}x${Math.round(probe.height || 0)}px)${step.action === 'type' ? ' and no sized ancestor to spotlight' : ''}`));
                } else if (step.action === 'type' && probe.anchored && (!probe.width || !probe.height)) {
                    const info = issueFor(step, 'info', `target ${JSON.stringify(step.target)} is 0x0 (empty caret); the spotlight uses its sized ancestor ${probe.anchorSelector}`);
                    info.highlightFallback = probe.anchorSelector;
                    issues.push(info);
                } else if (!revealsTarget && CURSOR_ACTIONS.has(step.action) && probe.clipped) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is clipped by an overflow container and cannot be scrolled into view; the cursor and typed text will be off-frame`));
                } else if (!revealsTarget && probe.opacity === 0) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} has opacity 0 when this step runs`));
                } else if (!revealsTarget && step.action !== 'scroll' && CURSOR_ACTIONS.has(step.action) && probe.inViewport === false) {
                    issues.push(issueFor(step, 'warning', `target ${JSON.stringify(step.target)} is outside the viewport when this step runs (add a "scroll" step first)`));
                }
            },
            afterStep: (step, result) => {
                // A missing target was already reported by the probe above; don't list it twice.
                if (result.error && !reportedMissing.has(step.index) && !staticTargetErrors.has(step.index)) {
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
        issues.push(...validateTimeline(timeline, { live: !!options.live }));
        if (timeline.strings) {
            const st = timeline.strings;
            const file = path.basename(st.file);
            for (const key of st.unknown) issues.push({ level: 'warning', field: 'strings', message: `${file}: key "${key}" matches no step or field (step ids: ${timeline.steps.map(s => s.id).join(', ')})` });
            if (st.missing.length) issues.push({ level: 'info', field: 'strings', message: `${file}: ${st.missing.length} string(s) missing, inline text used: ${st.missing.slice(0, 6).join(', ')}${st.missing.length > 6 ? ', …' : ''}` });
            if (st.untranslated.length && timeline.locale !== timeline.baseLocale) issues.push({ level: 'info', field: 'strings', message: `${file}: ${st.untranslated.length} string(s) still identical to the source text: ${st.untranslated.slice(0, 6).join(', ')}${st.untranslated.length > 6 ? ', …' : ''}` });
        } else if (timeline.locale && timeline.locale !== timeline.baseLocale) {
            issues.push({ level: 'info', field: 'strings', message: `locale "${timeline.locale}" requested but no strings.${timeline.locale}.json next to anim.config.json; inline text used` });
        }
        // Translations attach to step ids: auto-generated step-NN ids silently move when a step is inserted.
        const localized = !!timeline.strings || fs.readdirSync(path.resolve(dir)).some(f => /^strings\.[A-Za-z0-9-]+\.json$/.test(f));
        if (localized) {
            const auto = Object.keys(extractStrings(timeline)).map(k => /^steps\.(.+)\.[a-z]+$/.exec(k)?.[1]).filter((id): id is string => !!id && isAutoStepId(id));
            const ids = [...new Set(auto)];
            if (ids.length) issues.push({ level: 'warning', field: 'id', message: `${ids.length} localized step(s) use auto-generated ids (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}); give them explicit "id"s so inserting a step does not re-attach their translations` });
        }
        if (options.live) {
            // A live page's targets can only be probed by `record` itself (login, navigations, storage state).
            note = 'Live timeline: targets are probed by `record` against the page, not here.';
        } else if (!options.static && !hasErrors(issues.filter(i => i.field === 'time' || i.field === 'action'))) {
            issues.push(...await browserCheck(dir, timeline, options, issues));
        } else if (!options.static) {
            note = 'Browser pass skipped until the timing/action errors above are fixed.';
        }
    }
    const rank = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || rank[a.level] - rank[b.level]);

    const errors = issues.filter(i => i.level === 'error').length;
    const warnings = issues.filter(i => i.level === 'warning').length;
    const infos = issues.length - errors - warnings;
    if (options.json) {
        process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
    } else {
        for (const issue of issues) console.log(formatIssue(issue));
        const where = path.resolve(dir, 'anim.config.json');
        if (errors + warnings === 0) console.log(`${infos ? '\n' : ''}OK: ${where} (${timeline!.steps.length} steps, ${options.static ? 'static' : 'static + browser'} check${infos ? `, ${infos} info` : ''}).`);
        else console.log(`\n${errors} error(s), ${warnings} warning(s)${infos ? `, ${infos} info` : ''} in ${where}${options.static ? ' (static check only)' : ''}.`);
    }
    if (note) log(note);
    process.exitCode = errors > 0 ? 1 : 0;
}
