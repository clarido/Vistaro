import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseTimeline } from '../src/engine/schema';
import { buildAnimatedHtml, runtimeSource, stripRuntime, scriptJson } from '../src/engine/inject';

const fixture = path.join(__dirname, 'fixtures', 'basic');

test('runtime.js is plain browser JS (no require/import/TS)', () => {
    const src = runtimeSource();
    assert.ok(!/\brequire\(/.test(src));
    assert.ok(!/^\s*import\s/m.test(src));
    assert.ok(!/^\s*export\s/m.test(src));
    assert.ok(!/<\/script/i.test(src), 'must be safe to inline in a <script>');
    assert.ok(src.includes('window.__anim = api'));
});

test('buildAnimatedHtml inlines the runtime, boots with the timeline, and switches cursor', () => {
    const html = fs.readFileSync(path.join(fixture, 'index.html'), 'utf8');
    const tl = parseTimeline(JSON.parse(fs.readFileSync(path.join(fixture, 'anim.config.json'), 'utf8')));
    const mac = buildAnimatedHtml(html, tl, { cursor: 'mac' });
    assert.ok(mac.includes('window.__anim'));
    assert.ok(mac.includes('window.__anim.boot({'));
    assert.ok(mac.includes('"cursor":"mac"'));
    assert.ok(mac.includes('"defaultCps":25'));
    assert.ok(mac.indexOf('anim-cli-runtime:start') < mac.lastIndexOf('</body>'));
    const win = buildAnimatedHtml(html, tl, { cursor: 'windows', loop: true });
    assert.ok(win.includes('"cursor":"windows"'));
    assert.ok(win.includes('"loop":true'));
    // idempotent on its own output
    const twice = buildAnimatedHtml(mac, tl, { cursor: 'windows' });
    assert.equal(twice.split('anim-cli-runtime:start').length, 2);
    assert.ok(!twice.includes('"cursor":"mac"'));
    assert.equal(stripRuntime(mac).includes('window.__anim'), false);
});

test('scriptJson escapes sequences that would break out of a <script>', () => {
    const s = scriptJson({ a: '</script><b>', b: '\u2028' });
    assert.ok(!s.includes('</script'));
    assert.ok(!s.includes('\u2028'));
    assert.deepEqual(JSON.parse(s), { a: '</script><b>', b: '\u2028' });
});

test('meta.cursor is the default, CLI cursor overrides it, no </body> appends', () => {
    const tl = parseTimeline({ meta: { cursor: 'windows' }, steps: [] });
    assert.ok(buildAnimatedHtml('<html><body></body></html>', tl).includes('"cursor":"windows"'));
    assert.ok(buildAnimatedHtml('<html><body></body></html>', tl, { cursor: 'none' }).includes('"cursor":"none"'));
    const out = buildAnimatedHtml('<p>no body tag</p>', tl);
    assert.ok(out.startsWith('<p>no body tag</p>'));
    assert.ok(out.includes('window.__anim.boot('));
});
