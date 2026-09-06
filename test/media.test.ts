import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeline } from '../src/engine/schema';
import { subtitleCues, buildVtt, vttTime } from '../src/media/vtt';
import { chaptersFor, ffmetadata } from '../src/media/chapters';
import { cacheKey, narrationOf, narrationOverruns } from '../src/media/tts';

const tl = parseTimeline({
    meta: { title: 'Demo; with=meta', tailMs: 1000 },
    steps: [
        { id: 'a', time: 0, action: 'wait', title: 'Overview', subtitle: 'First <b>bold</b> line' },
        { id: 'b', time: 2, action: 'click', target: '#x', title: 'Open', subtitle: 'Second' },
        { id: 'c', time: 3, action: 'wait' },
        { id: 'd', time: 5, action: 'wait', subtitle: 'Third', narration: 'Spoken differently' },
    ],
});

test('vttTime formats HH:MM:SS.mmm', () => {
    assert.equal(vttTime(0), '00:00:00.000');
    assert.equal(vttTime(2003), '00:00:02.003');
    assert.equal(vttTime(3723456), '01:02:03.456');
});

test('subtitleCues follow the subtitle-window rule on the given start times and strip HTML', () => {
    const cues = subtitleCues(tl);
    assert.deepEqual(cues.map(c => [c.startMs, c.endMs, c.text]), [[0, 2000, 'First bold line'], [2000, 5000, 'Second'], [5000, 9000, 'Third']]);
    const actual = subtitleCues(tl, s => s.timeMs + 7);
    assert.equal(actual[0].startMs, 7);
    assert.equal(actual[0].endMs, 2007);
    const vtt = buildVtt(cues);
    assert.ok(vtt.startsWith('WEBVTT\n\n'));
    assert.match(vtt, /\nb\n00:00:02\.000 --> 00:00:05\.000\nSecond\n/);
});

test('chaptersFor covers titled steps up to the next titled step or the end; ffmetadata escapes', () => {
    const ch = chaptersFor(tl, 7300);
    assert.deepEqual(ch.map(c => [c.startMs, c.endMs, c.title]), [[0, 2000, 'Overview'], [2000, 7300, 'Open']]);
    const meta = ffmetadata(ch, tl.meta.title);
    assert.ok(meta.startsWith(';FFMETADATA1\n'));
    assert.match(meta, /^title=Demo\\; with\\=meta$/m);
    assert.match(meta, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=0\nEND=2000\ntitle=Overview/);
    assert.equal(chaptersFor(tl, 1000).length, 1, 'chapters past the end are dropped');
});

test('narrationOf falls back to subtitle; cache key depends on engine, voice and text', () => {
    assert.equal(narrationOf(tl.steps[0]), 'First bold line');
    assert.equal(narrationOf(tl.steps[3]), 'Spoken differently');
    assert.equal(narrationOf(tl.steps[2]), undefined);
    const k = cacheKey('say', { say: 'Samantha' }, 'hello');
    assert.match(k, /^[0-9a-f]{40}$/);
    assert.notEqual(k, cacheKey('say', { say: 'Alex' }, 'hello'));
    assert.notEqual(k, cacheKey('openai', { openai: 'alloy' }, 'hello'));
    assert.notEqual(k, cacheKey('say', { say: 'Samantha' }, 'hello!'));
    assert.equal(k, cacheKey('say', { say: 'Samantha' }, 'hello'));
});

test('narrationOverruns reports exact milliseconds', () => {
    const clips = [
        { index: 1, id: 'a', text: '', startMs: 0, file: '', durationMs: 2500 },
        { index: 2, id: 'b', text: '', startMs: 2000, file: '', durationMs: 1000 },
        { index: 4, id: 'd', text: '', startMs: 5000, file: '', durationMs: 3000 },
    ];
    const w = narrationOverruns(clips, 7300);
    assert.equal(w.length, 2);
    assert.match(w[0], /step 1 \(2500ms\) overruns step 2 at 2000ms by 500ms/);
    assert.match(w[1], /step 4 \(3000ms\) runs 700ms past the end/);
});
