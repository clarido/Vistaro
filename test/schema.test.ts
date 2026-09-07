import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTimeline, parseTime, validateTimeline, computeDurationMs, subtitleWindows, leadMsFor,
    formatIssue, hasErrors, DEFAULT_CPS, typingDurationMs, applyDevice, isReel, reelOptions,
} from '../src/engine/schema';

test('parseTime accepts seconds strings, ms strings and numbers', () => {
    assert.equal(parseTime('2s'), 2000);
    assert.equal(parseTime('2.5s'), 2500);
    assert.equal(parseTime('2000ms'), 2000);
    assert.equal(parseTime('3'), 3000);
    assert.equal(parseTime(2), 2000);
    assert.equal(parseTime(2.5), 2500);
    assert.ok(Number.isNaN(parseTime('soon')));
    assert.ok(Number.isNaN(parseTime(undefined)));
});

test('bare array (legacy) and object form normalize to the same steps', () => {
    const legacy = parseTimeline([
        { time: '0s', action: 'fadeIn', target: 'body', subtitle: 'Hi' },
        { time: '2s', action: 'click', target: '#a' },
        { time: '4s', action: 'showText', target: '#t' },
    ]);
    const obj = parseTimeline({
        meta: { title: 'T' },
        steps: [
            { time: 0, action: 'fadeIn', target: 'body', subtitle: 'Hi' },
            { time: 2, action: 'click', target: '#a' },
            { time: 4, action: 'fadeIn', target: '#t' },
        ],
    });
    assert.equal(legacy.legacy, true);
    assert.equal(obj.legacy, false);
    assert.equal(obj.meta.title, 'T');
    assert.deepEqual(legacy.steps.map(s => s.timeMs), [0, 2000, 4000]);
    assert.deepEqual(obj.steps.map(s => s.timeMs), [0, 2000, 4000]);
    assert.deepEqual(legacy.steps.map(s => s.id), ['step-01', 'step-02', 'step-03']);
    assert.deepEqual(legacy.steps.map(s => s.index), [1, 2, 3]);
    assert.equal(legacy.steps[2].action, 'fadeIn', 'showText is aliased to fadeIn');
    assert.equal(legacy.steps[2].deprecatedAction, 'showText');
    assert.equal(legacy.steps[0].subtitleMs, 4000);
});

test('parseTimeline rejects structurally invalid documents', () => {
    assert.throws(() => parseTimeline('nope' as any), /array of steps/);
    assert.throws(() => parseTimeline({ meta: {} } as any), /"steps" array/);
    assert.throws(() => parseTimeline([1] as any), /step 1 must be an object/);
});

test('validateTimeline reports unknown action, type without value, decreasing times', () => {
    const tl = parseTimeline([
        { time: '0s', action: 'wait' },
        { time: '1s', action: 'explode', target: '#x' },
        { time: '2s', action: 'type', target: '#f' },
        { time: '1.5s', action: 'click', target: '#b' },
        { time: 'later', action: 'click', target: '#b' },
        { time: '3s', action: 'click' },
    ]);
    const issues = validateTimeline(tl);
    const errors = issues.filter(i => i.level === 'error');
    assert.ok(hasErrors(issues));
    assert.ok(errors.some(i => i.step === 2 && /unknown action "explode"/.test(i.message)));
    assert.ok(errors.some(i => i.step === 3 && i.field === 'value'));
    assert.ok(errors.some(i => i.step === 4 && /earlier than the previous step/.test(i.message)));
    assert.ok(errors.some(i => i.step === 5 && /invalid "time"/.test(i.message)));
    assert.ok(errors.some(i => i.step === 6 && i.field === 'target'));
    for (const e of errors) assert.match(formatIssue(e), /^error {2}\s+step \d+ \(/);
});

test('validateTimeline is clean on a good object-form timeline and warns on deprecated alias', () => {
    const tl = parseTimeline({
        meta: {},
        steps: [
            { time: 0, action: 'fadeIn', target: 'body' },
            { time: 2, action: 'click', target: '#a', title: 'Open' },
            { time: 3, action: 'type', target: '#f', value: 'hi' },
            { time: 4, action: 'camera', target: '#f', scale: 1.2 },
            { time: 6, action: 'showText', target: '#t' },
        ],
    });
    const issues = validateTimeline(tl);
    assert.equal(issues.filter(i => i.level === 'error').length, 0);
    assert.ok(issues.some(i => i.level === 'warning' && /deprecated/.test(i.message)));
});

test('typing overrun is a warning with exact milliseconds', () => {
    const tl = parseTimeline([
        { time: 0, action: 'type', target: '#f', value: 'x'.repeat(50) },
        { time: 1, action: 'click', target: '#b' },
    ]);
    assert.equal(typingDurationMs(tl.steps[0]), Math.round(50 / DEFAULT_CPS * 1000));
    const w = validateTimeline(tl).find(i => i.level === 'warning' && /overruns/.test(i.message));
    assert.ok(w);
    assert.match(w!.message, /2000ms/);
    assert.match(w!.message, /by 1000ms/);
});

test('computeDurationMs = last interaction + intrinsic duration + tail', () => {
    const tl = parseTimeline({ meta: { tailMs: 1000 }, steps: [
        { time: 0, action: 'wait' },
        { time: 5, action: 'type', target: '#f', value: 'x'.repeat(25) },
    ] });
    assert.equal(computeDurationMs(tl), 5000 + 1000 + 1000);
    const tl2 = parseTimeline([{ time: '2s', action: 'camera', scale: 1.2, duration: 2 }]);
    assert.equal(computeDurationMs(tl2), 2000 + 2000 + 2500);
    const tl3 = parseTimeline([{ time: 1, action: 'fadeIn', target: '#t' }, { time: 2, action: 'fadeIn', target: '#t', duration: 3 }]);
    assert.equal(computeDurationMs(tl3), 2000 + 3000 + 2500, 'explicit fade duration wins over the 800ms default');
});

test('subtitleWindows: until next subtitle, else +4s, never under 1s', () => {
    const tl = parseTimeline([
        { time: 0, action: 'wait', subtitle: 'a' },
        { time: 0.5, action: 'wait', subtitle: 'b' },
        { time: 3, action: 'wait' },
        { time: 5, action: 'wait', subtitle: 'c' },
    ]);
    const w = subtitleWindows(tl);
    assert.deepEqual(w.map(x => [x.startMs, x.endMs, x.text]), [[0, 1000, 'a'], [500, 5000, 'b'], [5000, 9000, 'c']]);
    assert.equal(tl.steps[3].subtitleMs, 4000);
});

test('leadMsFor = min(950, gap since previous, timeMs)', () => {
    const tl = parseTimeline([
        { time: 0, action: 'wait' },
        { time: 0.4, action: 'click', target: '#a' },
        { time: 3, action: 'click', target: '#a' },
        { time: 3.2, action: 'click', target: '#a' },
    ]);
    const [s0, s1, s2, s3] = tl.steps;
    assert.equal(leadMsFor(s0), 0);
    assert.equal(leadMsFor(s1, s0), 400);
    assert.equal(leadMsFor(s2, s1), 950);
    assert.equal(leadMsFor(s3, s2), 200);
});

test('guide steps need a title: warning by default, error when a guide is produced; waitForTimeoutMs validated; long guides warn', () => {
    const tl = parseTimeline([
        { time: 0, action: 'click', target: '#a' },
        { time: 1, action: 'camera', scale: 1.2 },
        { time: 2, action: 'wait', title: 'Beat' },
        { time: 3, action: 'highlight', target: '#b', title: 'Notice', waitFor: '#b', waitForTimeoutMs: 500 },
        { time: 4, action: 'highlight', target: '#c', title: 'Bad', waitFor: '#c', waitForTimeoutMs: -1 },
        { time: 5, action: 'highlight', target: '#d', title: 'Odd', waitFor: 200, waitForTimeoutMs: 500 },
    ]);
    const plain = validateTimeline(tl, { live: true });
    const titles = plain.filter(i => i.field === 'title');
    assert.deepEqual(titles.map(i => [i.step, i.level]), [[1, 'warning']], 'only the numbered step without a title; camera without target is not numbered');
    assert.equal(validateTimeline(tl, { live: true, guide: true }).find(i => i.field === 'title')!.level, 'error');
    const wf = plain.filter(i => i.field === 'waitForTimeoutMs');
    assert.deepEqual(wf.map(i => [i.step, i.level]), [[5, 'error'], [6, 'warning']]);
    const long = parseTimeline(Array.from({ length: 11 }, (_, i) => ({ time: i, action: 'click', target: `#s${i}`, title: `Step ${i}` })));
    assert.match(validateTimeline(long).find(i => i.field === 'guide')!.message, /11 numbered guide steps: a guide this long is usually two guides/);
    const hidden = parseTimeline(Array.from({ length: 11 }, (_, i) => ({ time: i, action: 'click', target: `#s${i}`, title: `Step ${i}`, guide: i > 8 ? false : undefined })));
    assert.equal(validateTimeline(hidden).find(i => i.field === 'guide'), undefined, '"guide": false steps are not numbered');
});

test('applyDevice drops "only" steps for the other device, merges the matching override, and keeps ids stable', () => {
    const raw = {
        meta: { title: 'Devices' },
        steps: [
            { id: 'first', time: '0s', action: 'highlight', target: '#a' },
            { time: '1s', action: 'highlight', target: '#b', only: 'desktop' },
            { time: '2s', action: 'camera', target: '#c', scale: 1.2, ease: 'easeOutCubic', mobile: { scale: 1.6, yOffset: -30 } },
        ],
    };
    const desktop = applyDevice(parseTimeline(raw), 'desktop');
    assert.deepEqual(desktop.steps.map(s => s.id), ['first', 'step-02', 'step-03']);
    assert.equal(desktop.steps[2].scale, 1.2, 'the mobile override is not applied on desktop');

    const mobile = applyDevice(parseTimeline(raw), 'mobile');
    assert.deepEqual(mobile.steps.map(s => s.id), ['first', 'step-03'], 'the desktop-only step is dropped');
    // The auto id keeps the number it was authored with: it is what a strings file is keyed on, so a
    // dropped step must not renumber the survivors.
    assert.deepEqual(mobile.steps.map(s => s.index), [1, 3], 'index stays authored, not renumbered');
    const camera = mobile.steps[1];
    assert.equal(camera.scale, 1.6, 'the mobile override wins');
    assert.equal(camera.yOffset, -30, 'and adds its own fields');
    assert.equal(camera.ease, 'easeOutCubic', 'fields the override does not mention are inherited');
    for (const key of ['mobile', 'desktop', 'only']) {
        assert.ok(!(key in camera), `${key} is stripped once resolved`);
    }
});

test('a dropped "only" step re-derives the subtitle windows, so the bar does not blank (device regression)', () => {
    // A subtitle runs until the NEXT subtitle starts. Dropping the step that a preceding window was
    // measured against leaves that window short, and the burned-in bar blanks while the .vtt (built
    // from the final step list) still says the cue is showing.
    const raw = {
        meta: { title: 'Holes' },
        steps: [
            { id: 'a', time: '0s', action: 'highlight', target: '#a', subtitle: 'first' },
            { id: 'b', time: '1s', action: 'highlight', target: '#a', subtitle: 'second' },
            { id: 'c', time: '2s', action: 'highlight', target: '#a', subtitle: 'third', only: 'desktop' },
            { id: 'd', time: '3s', action: 'highlight', target: '#a', subtitle: 'fourth' },
        ],
    };
    const desktop = applyDevice(parseTimeline(raw), 'desktop');
    assert.deepEqual(desktop.steps.map(s => s.subtitleMs), [1000, 1000, 1000, 4000]);

    const mobile = applyDevice(parseTimeline(raw), 'mobile');
    assert.deepEqual(mobile.steps.map(s => s.id), ['a', 'b', 'd']);
    // b now holds until d at 3000ms, not until the dropped c at 2000ms.
    assert.deepEqual(mobile.steps.map(s => s.subtitleMs), [1000, 2000, 4000]);
});

test('kind: "reel" resolves the silent profile and drops the guide-shaped validation', () => {
    const guide = parseTimeline({ meta: { title: 'G' }, steps: [{ time: 0, action: 'highlight', target: '#a' }] });
    const reel = parseTimeline({ meta: { title: 'R', kind: 'reel' }, steps: [{ time: 0, action: 'highlight', target: '#a' }] });
    assert.equal(isReel(guide), false);
    assert.equal(isReel(reel), true);
    assert.deepEqual(reelOptions(guide), { spotlight: true, ripple: true, subtitles: true, loop: false, autoplay: 'immediate', poster: 'last' });
    assert.deepEqual(reelOptions(reel), { spotlight: false, ripple: false, subtitles: false, loop: true, autoplay: 'inview', poster: 'last' });
    // An explicit value always beats the profile default, in both directions.
    const mixed = parseTimeline({ meta: { kind: 'reel', reel: { spotlight: true, loop: false, autoplay: 'message' } }, steps: [] });
    const m = reelOptions(mixed);
    assert.equal(m.spotlight, true);
    assert.equal(m.loop, false);
    assert.equal(m.autoplay, 'message');

    // A step with no title is a guide defect and a non-event for a reel.
    assert.ok(validateTimeline(guide).some(i => i.field === 'title'), 'the guide warns about the missing title');
    assert.ok(!validateTimeline(reel).some(i => i.field === 'title'), 'the reel does not');
    assert.ok(!validateTimeline(reel, { guide: true }).some(i => i.field === 'title'));
});

test('reel meta and animate steps are validated', () => {
    const errs = (raw: any) => validateTimeline(parseTimeline(raw)).filter(i => i.level === 'error').map(i => i.message);
    assert.ok(errs({ meta: { kind: 'video' }, steps: [] }).some(m => /meta.kind must be/.test(m)));
    assert.ok(errs({ meta: { kind: 'reel', reel: { loop: 'yes' } }, steps: [] }).some(m => /meta.reel.loop must be true or false/.test(m)));
    assert.ok(errs({ meta: { kind: 'reel', reel: { autoplay: 'soon' } }, steps: [] }).some(m => /meta.reel.autoplay must be/.test(m)));
    assert.ok(errs({ meta: { kind: 'reel', reel: { poster: 'middle' } }, steps: [] }).some(m => /meta.reel.poster must be/.test(m)));
    // A poster past the end of the clip is refused rather than silently clamped.
    assert.ok(errs({ meta: { kind: 'reel', tailMs: 0, reel: { poster: '90s' } }, steps: [{ time: 0, action: 'wait' }] }).some(m => /past the end of the clip/.test(m)));
    assert.ok(errs({ steps: [{ time: 0, action: 'animate', target: '#a', ease: 'easeOutWobble' }] }).some(m => /unknown easing/.test(m)));
    assert.ok(errs({ steps: [{ time: 0, action: 'animate', target: '#a', from: [1, 2] }] }).some(m => /"from" must be an object/.test(m)));
    assert.ok(errs({ steps: [{ time: 0, action: 'animate', target: '#a', count: 2.5, from: { opacity: 0 } }] }).some(m => /"count" must be a whole number/.test(m)));
    assert.ok(errs({ steps: [{ time: 0, action: 'highlight', target: '#a', only: 'tablet' }] }).some(m => /"only" must be/.test(m)));
    // A well-formed reel timeline is clean.
    assert.deepEqual(errs({ meta: { kind: 'reel', reel: { loop: true, autoplay: 'inview', poster: 'first' } },
        steps: [{ id: 'a', time: 0, action: 'animate', target: '.card', all: true, stagger: 0.1, count: 3, from: { opacity: 0, y: 20 }, to: { opacity: 1, y: 0 }, ease: 'easeOutBack' }] }), []);
});

test('an animate step accounts for its stagger in the clip length', () => {
    const one = parseTimeline({ meta: { tailMs: 0 }, steps: [{ time: 0, action: 'animate', target: '.c', from: { opacity: 0 } }] });
    assert.equal(computeDurationMs(one), 600, 'the default duration is 0.6s');
    const staggered = parseTimeline({ meta: { tailMs: 0 }, steps: [
        { time: 0, action: 'animate', target: '.c', all: true, stagger: 0.1, count: 4, duration: 0.5, from: { opacity: 0 } },
    ] });
    // 500ms for the element itself, plus 0.1s x (4 - 1) before the last one starts.
    assert.equal(computeDurationMs(staggered), 800);
    const noCount = parseTimeline({ meta: { tailMs: 0 }, steps: [{ time: 0, action: 'animate', target: '.c', all: true, stagger: 0.1, duration: 0.5, from: { opacity: 0 } }] });
    assert.equal(computeDurationMs(noCount), 500, 'count defaults to 1, so the estimate is just the duration');
});
