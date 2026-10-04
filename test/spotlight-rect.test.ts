import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRunnerGlob, stripComments, SourceFile } from './scan-source';
import { runtimeSource } from '../src/engine/inject';

/**
 * Canary for the inventory row « Spotlight-ring assertions read inline style, not
 * getBoundingClientRect » (AGENTS.md, Contributor notes; docs/testing-discipline.md): "The
 * spotlight ring pulses by scaling itself, so its measured rect is a few px off wherever it was
 * positioned. A test that asserts where the ring landed must read its inline style, not
 * getBoundingClientRect()." The ring, its pulse and its hold state are defined together in
 * src/engine/runtime.js:85-88 under the one id (`#anim-cli-highlight`, `.anim-cli-pulse`,
 * `.anim-cli-hold { opacity: 1; animation: none; }`) -- which is what the identity ratchet below
 * pins: a ring-id rename reds HERE instead of letting the scan read a dead name.
 *
 * Discovery reads the runner's own glob (test/*.test.ts, through the shared reader's
 * readRunnerGlob -- no fixtures/, and scan-source.ts itself is out by construction) through the
 * comment-stripper, and keys a site on a rect read OF THE RING, in exactly two shapes:
 *   A -- one line containing both 'anim-cli-highlight' and '.getBoundingClientRect()';
 *   B -- a line binding a variable from 'anim-cli-highlight' and '.getBoundingClientRect()'
 *        called on that exact variable within the next 2 lines.
 * The receiver tightening is the point: browser.test.ts:1137-1142 is the CORRECT pattern -- the
 * comment at :1137-1138 cites the pulse, :1139 binds the ring, :1140 reads
 * parseFloat(h.style.top) -- and its window DOES contain a getBoundingClientRect (:1141, on the
 * step's own target). A loose "rect call near a ring binding" shape would red the one test doing
 * it right; shapes A/B classify it as nothing, and the deepEqual below proves that on the real
 * files, not just on planted snippets.
 *
 * The two known sites are the whole exemption list, each justified in its entry's comment. A
 * THIRD rect-read site reds this canary until its author either reads the inline style like
 * browser.test.ts:1137-1142, or joins EXEMPT_SITES with the precondition that makes the rect
 * exact. Per rule 8, the list, the two shapes and the scope are allowlists: loosening any of
 * them is a documented decision, not a test edit.
 *
 * The shape-B window (2 lines) is a RATCHET, not a tolerance, measured against the code as it
 * stands (guide.test.ts:361-362: the binding, then the rect read on the very next line). A
 * legitimate reflow that pushes a real read past the window reds this canary on purpose -- fold
 * the read back into the window, or widen SHAPE_B_WINDOW_LINES as a documented decision; the red
 * reads as designed, not as flake.
 *
 * The planted snippets of the self-tests assemble the ring id and the rect call at runtime by
 * concatenation (the spawn-bounds.test.ts:30-34 precedent): this canary scans test/ and
 * therefore reads ITSELF, and a verbatim pattern in its own code would put that line in front of
 * the exemption list it polices. Comments are stripped before scanning, so they may name the
 * tokens verbatim.
 */

// Runtime-assembled so this file's own text never carries a contiguous pattern (see header).
const RING_ID = ['anim-cli', 'highlight'].join('-');
const RECT_CALL = ['.', 'getBoundingClientRect', '()'].join('');

// Shape B's window: the binding line plus its 2 following lines. Ratchet -- see header.
const SHAPE_B_WINDOW_LINES = 2;

// A local bound from the ring id on one line: `const|let|var name = ...`.
const BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;

type Site = { file: string; line: number; shape: 'A' | 'B' };

function escapeRx(name: string): string {
    return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rect reads of the ring in one file's text, in line order. Shape A wins over shape B on a line
 *  that carries both the id and the call, so one pattern occurrence yields one site. */
function ringRectSites(file: SourceFile): Site[] {
    const lines = stripComments(file.text).split('\n');
    const sites: Site[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes(RING_ID)) continue;
        if (line.includes(RECT_CALL)) {
            sites.push({ file: file.name, line: i + 1, shape: 'A' });
            continue;
        }
        const bound = BINDING.exec(line);
        if (!bound) continue;
        const onVar = new RegExp('(?<![.\\w$])' + escapeRx(bound[1]) + '\\s*\\.\\s*getBoundingClientRect\\s*\\(');
        for (let j = i + 1; j <= i + SHAPE_B_WINDOW_LINES && j < lines.length; j++) {
            if (onVar.test(lines[j])) {
                sites.push({ file: file.name, line: j + 1, shape: 'B' });
                break;
            }
        }
    }
    return sites;
}

function discover(files: SourceFile[]): Site[] {
    return files.flatMap(ringRectSites);
}

/** The exemption list -- the ONLY rect reads of the ring the runner glob may carry, each with the
 *  justification that makes its rect exact or its use insensitive. A third site reds the
 *  deepEqual: read the inline style like browser.test.ts:1137-1142, or join this list with the
 *  precondition that makes the rect exact. (Lines re-pinned when the orphan-wrap lot's insertions
 *  at the top of browser.test.ts and guide.test.ts shifted the sites; the sites themselves are
 *  the same two, unchanged.) */
const EXEMPT_SITES: Site[] = [
    // browser.test.ts:489 -- coverage-only use: the box feeds `h.width >= log.width && h.height >=
    // log.height` at :500, and the pulse only ever inflates the box, so every >= holds regardless
    // of the few-px drift the pulse adds.
    { file: 'browser.test.ts', line: 489, shape: 'A' },
    // guide.test.ts:362 -- a ±1px position assert at :368-369, made exact by its own asserted
    // precondition: `m.animations === 0` at :367 on a spotlight held by
    // runtime.js:87 `#anim-cli-highlight.anim-cli-hold { opacity: 1; animation: none; }`, so no
    // pulse is running to move the box.
    { file: 'guide.test.ts', line: 362, shape: 'B' },
];

const DISCOVERY_IDENTITY = 'discovery found no rect read of the spotlight ring in test/ -- the runner glob or the shape matchers broke, or the ring id died (the runtime ratchet below)';

/** The id ratchet: the scan keys on the ring's id, so the id must still exist where it is
 *  defined. Without this, a rename in runtime.js would red nothing -- the scan would find zero
 *  sites and pass vacuously on a dead name. */
function assertRuntimeHasRingId(source: string): void {
    assert.ok(source.includes(RING_ID), `runtimeSource() no longer contains the ring id ${RING_ID} -- the ring was renamed in src/engine/runtime.js:85-88; re-point this canary and re-derive EXEMPT_SITES in the same change, or the scan is reading a dead name`);
}

test('every rect read of the spotlight ring in test/ is one of the two exempted sites', () => {
    const sites = discover(readRunnerGlob(__dirname));
    assert.ok(sites.length >= 1, DISCOVERY_IDENTITY);
    assert.deepEqual(sites, EXEMPT_SITES, 'a rect read of the ring reds here: read the inline style it was placed with (browser.test.ts:1137-1142), or join EXEMPT_SITES with the precondition that makes the rect exact');
});

test('the two exemptions still hold the justifications their entries claim', () => {
    const byName = new Map(readRunnerGlob(__dirname).map(f => [f.name, f.text] as const));
    const browserLines = stripComments(byName.get('browser.test.ts')!).split('\n');
    assert.match(browserLines[499], /boxAtCapture\.h\.width >= boxAtCapture\.log\.width/, 'the :489 exemption is coverage-only: a >= the pulse only helps, at :500');
    assert.match(browserLines[1139], /parseFloat\(h\.style\.top\)/, 'the correct pattern at browser.test.ts:1137-1142 must stay an inline-style read');
    const guideLines = stripComments(byName.get('guide.test.ts')!).split('\n');
    assert.match(guideLines[348], /holdHighlight\(/, 'the :362 exemption reads a HELD spotlight (holdHighlight at :349)');
    assert.match(guideLines[366], /m\.animations,\s*0/, 'the :362 exemption leans on the asserted no-animation precondition at :367');
    const pixelAsserts = guideLines[367] + '\n' + guideLines[368];
    assert.match(pixelAsserts, /Math\.abs\(/, 'the :362 exemption serves the ±1px asserts at :368-369');
    assert.match(pixelAsserts, /<= 1/, 'the :362 exemption serves the ±1px asserts at :368-369');
});

test('the runtime still defines the ring id this canary scans for', () => {
    assertRuntimeHasRingId(runtimeSource());
});

test('self-test: a planted shape-A line is discovered', () => {
    const planted = [
        'function probe() {',
        `  const box = document.getElementById('${RING_ID}').${RECT_CALL};`,
        '  return box.width;',
        '}',
    ].join('\n');
    assert.deepEqual(discover([{ name: 'planted.test.ts', text: planted }]),
        [{ file: 'planted.test.ts', line: 2, shape: 'A' }], 'a planted shape-A rect read of the ring is discovered');
});

test('self-test: a planted shape-B read at the window edge is discovered', () => {
    const planted = [
        'function probe() {',
        `  const h = document.getElementById('${RING_ID}');`,
        '  const placed = h.style.top;',
        `  const w = h${RECT_CALL}.width;`,
        '  return w;',
        '}',
    ].join('\n');
    assert.deepEqual(discover([{ name: 'planted.test.ts', text: planted }]),
        [{ file: 'planted.test.ts', line: 4, shape: 'B' }], 'a planted shape-B rect read is discovered at the read line (binding, call two lines below)');
});

test('self-test: the correct inline-style shape with an unrelated rect in the window classifies as nothing', () => {
    // The browser.test.ts:1128-1130 shape: the ring's inline style for the ring, a rect for
    // something else inside the same window -- the receiver tightening must keep this clean.
    const correct = [
        'function probe() {',
        '  // the ring pulses; assert where it was placed, not where it measures',
        `  const h = document.getElementById('${RING_ID}');`,
        '  const top = parseFloat(h.style.top);',
        `  const r = document.querySelector(sel).${RECT_CALL};`,
        '  return { top, own: r.top };',
        '}',
    ].join('\n');
    assert.deepEqual(discover([{ name: 'planted.test.ts', text: correct }]), [],
        'an unrelated element\'s rect inside the window must not classify as a ring rect read');
});

test('self-test: an empty glob fails the identity assert by name', () => {
    assert.throws(() => {
        // A renamed glob or a broken shape matcher scans zero sites; the identity assert must red.
        const sites = discover([]);
        assert.ok(sites.length >= 1, DISCOVERY_IDENTITY);
        assert.deepEqual(sites, EXEMPT_SITES);
    }, /discovery found no rect read/);
});

test('self-test: a runtime source without the ring id fails by name', () => {
    assert.throws(() => assertRuntimeHasRingId('var spot = { pulse: true };'), new RegExp(RING_ID),
        'the ratchet names the missing id, not a bare ok-failure');
});
