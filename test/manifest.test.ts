import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readManifest, recordEvent, setManifestFields } from '../src/manifest';

test('a corrupt manifest is moved aside and a fresh one started, loudly', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-manifest-'));
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (m: any) => errors.push(String(m));
    try {
        fs.writeFileSync(path.join(d, 'vistaro.manifest.json'), '{ "history": [truncated');
        assert.deepEqual(readManifest(d), { history: [] });
        const leftovers = fs.readdirSync(d).filter(n => n.startsWith('vistaro.manifest.json.'));
        assert.equal(leftovers.length, 1, 'exactly one quarantined aside');
        assert.match(leftovers[0], /^vistaro\.manifest\.json\.corrupt-/);
        assert.ok(fs.readFileSync(path.join(d, leftovers[0]), 'utf8').includes('truncated'), 'the damaged bytes stay recoverable');
        // The warning is the whole point of "loudly": without it a wiped audit trail looks like a
        // fresh directory. It must name the file and the aside.
        assert.ok(errors.some(m => m.includes('vistaro.manifest.json') && m.includes('moved aside')), `a warning was printed: ${JSON.stringify(errors)}`);
    } finally {
        console.error = originalError;
        fs.rmSync(d, { recursive: true, force: true });
    }
});

test('a manifest that parses to a non-object (null, array) is treated as corrupt too', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-manifest-'));
    try {
        fs.writeFileSync(path.join(d, 'vistaro.manifest.json'), 'null');
        assert.deepEqual(readManifest(d), { history: [] });
        assert.ok(fs.readdirSync(d).some(n => n.startsWith('vistaro.manifest.json.corrupt-')));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('recordEvent appends to a valid manifest and writes atomically (no temp left behind)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaro-manifest-'));
    try {
        setManifestFields(d, { locale: 'fr' });
        recordEvent(d, { command: 'build', output: 'animated.html' });
        recordEvent(d, { command: 'export', output: 'demo.mp4' });
        const m = readManifest(d);
        assert.equal(m.locale, 'fr');
        assert.deepEqual(m.history.map(h => h.command), ['build', 'export']);
        assert.ok(m.history[0].timestamp);
        assert.equal(fs.readdirSync(d).filter(n => n.includes('.tmp-')).length, 0, 'the temp is renamed away, never left');
        // A history field of the wrong shape is repaired, not fatal.
        fs.writeFileSync(path.join(d, 'vistaro.manifest.json'), JSON.stringify({ locale: 'fr', history: 'nope' }));
        const repaired = readManifest(d);
        assert.deepEqual(repaired.history, []);
        assert.equal(repaired.locale, 'fr');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
