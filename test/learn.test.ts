import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { startLiveApp, LiveApp } from './fixtures/live-app/server';
import { parseTimeline, validateTimeline } from '../src/engine/schema';
import { writeLearnDraft, LearnedInteraction } from '../src/commands/learn';

const skip = process.env.SKIP_BROWSER === '1';
const root = path.resolve(__dirname, '..');
/**
 * A wedged child used to hang the whole suite (see record.test.ts): bound per CALL, well above the
 * slowest healthy recording and far under the runner's own --test-timeout, so a wedge is reported
 * here, by name, instead of as the runner cancelling the test.
 */
const CLI_TIMEOUT_MS = 300000;

function cli(args: string[]): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'cli.ts', ...args], { cwd: root, timeout: CLI_TIMEOUT_MS, killSignal: 'SIGKILL' });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
}

let app: LiveApp;
let work: string;

before(async () => {
    if (skip) return;
    app = await startLiveApp({});
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-learn-'));
});
after(async () => {
    if (app) await app.close();
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

function writeDir(name: string, config: unknown): string {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(config, null, 2));
    return dir;
}

/**
 * A flow whose authored targets are deliberately the selectors an author scribbles first
 * (bare tags, positional chains, raw ids), across two pages (a real navigation in the middle),
 * plus a press -- so the learned draft has to re-resolve every kind of target the manual ranks.
 */
const learnFlow = (base: string) => ({
    meta: { title: 'Learn flow', slug: 'learn-flow', app: 'Live app', url: `${base}/learn`, cursor: 'mac', tailMs: 500 },
    steps: [
        { id: 'who', time: 0.4, action: 'type', target: 'input[type="text"]', value: 'ada' },
        { id: 'second', time: 1.2, action: 'click', target: 'ul.choices li:nth-child(2) button' },
        { id: 'send', time: 2.0, action: 'click', target: 'button.send' },
        { id: 'toform', time: 2.6, action: 'navigate', url: `${base}/controlled` },
        { id: 'tag', time: 3.6, action: 'type', target: '#tag', value: 'urgent', waitFor: '#tag' },
        { id: 'add', time: 4.6, action: 'click', target: '#add' },
        { id: 'enter', time: 5.4, action: 'press', value: 'Enter' },
    ],
});

test('record --learn: the observed interactions are written as a valid, schema-parseable draft timeline (+ notes), with targets re-resolved to the stablest selector', { skip }, async () => {
    const dir = writeDir('flow', learnFlow(app.url));
    const out = path.join(work, 'learned.json');
    const r = await cli(['record', dir, '--learn', out, '-o', path.join(work, 'learned.mp4'), '--width', '640', '--height', '400']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /--learn: 7 interaction\(s\)/);

    // The draft exists, parses through the same parse the CLI uses, and carries no validation error.
    assert.ok(fs.existsSync(out), 'draft written');
    const parsed = parseTimeline(JSON.parse(fs.readFileSync(out, 'utf8')));
    const issues = validateTimeline(parsed, { live: true });
    assert.equal(issues.filter(i => i.level === 'error').length, 0, JSON.stringify(issues));
    // The human note sits beside it.
    const notesPath = out + '.notes.md';
    assert.ok(fs.existsSync(notesPath), 'notes written next to the draft');

    // meta: the recorded URL, so check --live / record work from the draft.
    assert.equal(parsed.meta.url, `${app.url}/learn`);
    // Every observed interaction, in observed time order, no titles anywhere.
    assert.deepEqual(parsed.steps.map(s => s.id), ['step-01', 'step-02', 'step-03', 'step-04', 'step-05', 'step-06', 'step-07']);
    const times = parsed.steps.map(s => s.timeMs);
    for (const t of times) assert.match(String(t), /^\d+$/, 'ms times');
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `chronological: ${times[i - 1]} -> ${times[i]}`);
    for (const s of parsed.steps) assert.equal(s.title, undefined, 'a draft carries no titles');
    for (const s of parsed.steps) assert.match(String(s.time), /^\d+ms$/, `time in ms: ${s.time}`);

    // Targets re-resolved in the manual's preference order, per observed interaction:
    const [who, second, send, toform, tag, add, enter] = parsed.steps;
    assert.equal(who.action, 'type');
    assert.equal(who.target, '#who', 'bare-tag authored selector -> the element\'s id');
    assert.equal(who.value, 'ada');
    assert.equal(second.action, 'click');
    assert.equal(second.target, 'button', 'no id, no class -> the bare-tag fallback');
    assert.equal(send.action, 'click');
    assert.equal(send.target, 'button.send', 'class kind kept');
    assert.equal(toform.action, 'navigate');
    assert.equal(toform.url, `${app.url}/controlled`);
    assert.equal(toform.target, undefined, 'navigate has no target');
    assert.equal(tag.action, 'type');
    assert.equal(tag.target, '[data-help="tag-input"]', 'data-help wins over the element\'s #id');
    assert.equal(tag.value, 'urgent');
    assert.equal(add.action, 'click');
    assert.equal(add.target, '[data-help="add"]');
    assert.equal(enter.action, 'press');
    assert.equal(enter.value, 'Enter');
    assert.equal(enter.target, undefined, 'press has no target');

    // The note says what was captured, which selectors are fragile, and what the author owes it.
    const notes = fs.readFileSync(notesPath, 'utf8');
    assert.match(notes, /# Learned timeline \(draft\)/);
    assert.match(notes, /7 interaction\(s\)/);
    assert.match(notes, /positional .*breaks on any DOM change/, 'the bare-tag target is flagged fragile');
    assert.match(notes, /## What to title/);
    assert.match(notes, /no titles on purpose/);
    // The recording itself is untouched: the video, manifest event and learned path are all recorded.
    assert.ok(fs.existsSync(path.join(work, 'learned.mp4')));
    const ev = JSON.parse(fs.readFileSync(path.join(dir, 'anim.manifest.json'), 'utf8')).history.at(-1);
    assert.equal(ev.command, 'record');
    assert.equal(ev.learn, '../learned.json');
    for (const s of ev.steps) assert.equal(s.error, undefined, `step ${s.index}: ${s.error}`);

    // Nothing to learn -> exit 1, a clear message, and no draft files of any kind.
    const emptyDir = writeDir('empty', { meta: { title: 'Nothing', url: `${app.url}/learn`, cursor: 'none', tailMs: 200 }, steps: [{ id: 'pause', time: 0.3, action: 'wait' }] });
    const emptyOut = path.join(work, 'empty.json');
    const r2 = await cli(['record', emptyDir, '--learn', emptyOut, '-o', path.join(work, 'empty.mp4'), '-d', '1', '--width', '320', '--height', '200']);
    assert.equal(r2.status, 1, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /--learn: nothing was captured/);
    assert.equal(fs.existsSync(emptyOut), false, 'no draft written');
    assert.equal(fs.existsSync(emptyOut + '.notes.md'), false, 'no notes written');
});

test('learn: the synthesizer sorts by observed time, names steps step-01..., and refuses an empty capture', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-learn-unit-'));
    try {
        const out = path.join(dir, 'draft.json');
        assert.throws(() => writeLearnDraft(out, [], { url: 'http://127.0.0.1:9/x', failed: 0, skipped: 0 }), /nothing was captured/);
        assert.equal(fs.existsSync(out), false, 'nothing written for an empty capture');

        const captured: LearnedInteraction[] = [
            { action: 'click', timeMs: 1200, target: '[data-help="save"]', kind: 'data-help', unique: true },
            { action: 'type', timeMs: 300, target: '#query', kind: 'id', unique: true, value: 'hi' },
            { action: 'press', timeMs: 1900.4, value: 'Enter' },
            { action: 'navigate', timeMs: 2500, url: 'http://127.0.0.1:9/next' },
            { action: 'click', timeMs: 3100, target: 'button:nth-of-type(2)', kind: 'fallback', unique: false, navigated: true },
        ];
        const s = writeLearnDraft(out, captured, { url: 'http://127.0.0.1:9/start', failed: 1, skipped: 2 });
        assert.equal(s.steps, 5);
        assert.ok(fs.existsSync(s.output!) && fs.existsSync(s.notes!));

        // The written file re-parses through the same parse the CLI uses, error-free (live, because
        // the draft may carry navigate steps), with the ids and ordering the contract promises.
        const parsed = parseTimeline(JSON.parse(fs.readFileSync(out, 'utf8')));
        assert.equal(validateTimeline(parsed, { live: true }).filter(i => i.level === 'error').length, 0);
        assert.deepEqual(parsed.steps.map(st => st.id), ['step-01', 'step-02', 'step-03', 'step-04', 'step-05']);
        assert.equal(parsed.steps[0].action, 'type', 'sorted by observed time, not capture order');
        assert.equal(parsed.steps[2].time, '1900ms', 'fractional observed ms are rounded');
        assert.deepEqual(parsed.steps.filter(st => st.title !== undefined).map(st => st.id), [], 'no titles');
        const notes = fs.readFileSync(s.notes!, 'utf8');
        assert.match(notes, /positional/);
        assert.match(notes, /more than one element/, 'a non-unique selector is flagged');
        assert.match(notes, /1 step\(s\) failed/, 'failed recording steps are named in the note');
        assert.match(notes, /2 other recording step\(s\)/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
