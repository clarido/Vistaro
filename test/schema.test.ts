import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTimeline, parseTime, validateTimeline, computeDurationMs, subtitleWindows, leadMsFor,
    formatIssue, hasErrors, DEFAULT_CPS, typingDurationMs,
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
