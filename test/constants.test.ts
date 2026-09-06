import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSource } from '../src/engine/inject';
import { DEFAULT_LEAD_MS, DEFAULT_CPS, DEFAULT_CAMERA_DURATION_S, DEFAULT_FADE_MS, DEFAULT_SCROLL_MS } from '../src/engine/schema';

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
});
