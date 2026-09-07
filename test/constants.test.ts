import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSource } from '../src/engine/inject';
import { DEFAULT_LEAD_MS, DEFAULT_CPS, DEFAULT_CAMERA_DURATION_S, DEFAULT_FADE_MS, DEFAULT_SCROLL_MS, DEFAULT_TAIL_MS, SUBTITLE_HOLD_MS, DEFAULT_ANIMATE_DURATION_S, EASING_NAMES } from '../src/engine/schema';

/** runtime.js is plain JS and cannot import schema.ts; its literals must not drift. */
function literal(name: string): number {
    const m = new RegExp(`var ${name} = ([\\d.]+);`).exec(runtimeSource());
    assert.ok(m, `runtime.js defines ${name}`);
    return parseFloat(m![1]);
}

test('runtime.js constants equal the schema exports', () => {
    assert.equal(literal('DEFAULT_LEAD_MS'), DEFAULT_LEAD_MS);
    assert.equal(literal('DEFAULT_CPS'), DEFAULT_CPS);
    assert.equal(literal('DEFAULT_CAMERA_S'), DEFAULT_CAMERA_DURATION_S);
    assert.equal(literal('FADE_MS'), DEFAULT_FADE_MS);
    assert.equal(literal('SCROLL_MS'), DEFAULT_SCROLL_MS);
    assert.equal(literal('DEFAULT_TAIL_MS'), DEFAULT_TAIL_MS);
    assert.equal(literal('SUBTITLE_HOLD_MS'), SUBTITLE_HOLD_MS);
    assert.equal(literal('DEFAULT_ANIMATE_S'), DEFAULT_ANIMATE_DURATION_S);
});

test('runtime.js EASINGS holds exactly the names schema.ts validates against', () => {
    // schema.ts cannot import runtime.js, so it duplicates the names to reject a bad `ease` early.
    const block = /var EASINGS = \{([\s\S]*?)\};/.exec(runtimeSource());
    assert.ok(block, 'runtime.js defines EASINGS');
    const names = [...block![1].matchAll(/^\s*([A-Za-z]+):/gm)].map(m => m[1]);
    assert.deepEqual(names.sort(), [...EASING_NAMES].sort());
});
