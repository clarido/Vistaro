import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { chromium } from 'playwright';

/**
 * Tests for the studio hub/picker front-end bugs: the picker's card-list keydown leaking into
 * the open-folder dialog, literal "\n" two-character sequences baked into the static HTML, the
 * hub copy button reporting a clipboard refusal as success, and the Browse button wiping a
 * typed Windows path.
 *
 * studioCommand never resolves (the listening server IS the process), so an in-process boot of
 * the real server would hang the runner. Instead this file runs a minimal stub http server that
 * serves the SHIPPED app files from src/studio/app/ verbatim (serveAppFile's contract) plus the
 * two /api endpoints the pages fetch -- the code under test is the real browser JavaScript.
 */
const root = path.resolve(__dirname, '..');
const APP = path.join(root, 'src', 'studio', 'app');
const skip = process.env.SKIP_BROWSER === '1';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const FILES = ['index.html', 'picker.html', 'hub.html', 'picker.css', 'hub.css', 'studio.css', 'picker.js', 'hub.js', 'browse.js'];

function serveFile(res: http.ServerResponse, name: string): void {
    res.writeHead(200, { 'content-type': MIME[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(APP, name)));
}

let server: http.Server;
let url = '';

before(async () => {
    server = http.createServer((req, res) => {
        const got = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (got.pathname === '/api/projects') {
            // The shape /api/projects really answers with (studio.ts), narrowed to the fields
            // picker.js reads. Two cards: the repro needs a card for the cursor to land on.
            const project = (id: string, title: string) => ({
                id, dir: 'work/' + title.toLowerCase().replace(/\W+/g, '-'), title,
                configName: 'vistaro.config.json', kind: 'guide', tour: false,
                locales: ['en'], devices: ['desktop'], steps: 3, lastTouched: null, current: false,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ projects: [project('cardaaa11', 'Project A'), project('cardbbb22', 'Project B')], defaultId: null }));
            return;
        }
        if (got.pathname === '/' || got.pathname === '/picker.html') { serveFile(res, 'picker.html'); return; }
        if (got.pathname === '/hub' || got.pathname === '/hub.html') { serveFile(res, 'hub.html'); return; }
        const name = got.pathname.replace(/^\//, '');
        if (FILES.includes(name)) { serveFile(res, name); return; }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Browser tests are machine-sensitive and other agents run browser jobs in parallel, so a
 *  contended pass is not a result (docs/testing-discipline.md rule 6): rerun exactly once. */
async function retryOnce(body: () => Promise<void>): Promise<void> {
    try {
        await body();
    } catch (first) {
        process.stderr.write(`[retry] first pass failed, rerunning once: ${String(first)}\n`);
        await body();
    }
}

// ---------------------------------------------------------------- #6 literal "\n" in the HTML

test('studio static HTML: no literal backslash-n two-character sequences are baked into the markup', () => {
    // hub.css's #open-form is display:grid, so the one inside #open-form renders as an extra
    // "\n" row; the ones beside <script> tags render as stray text at the page bottoms. The
    // files are static markup (no inline scripts), so any backslash-n anywhere is a mistake --
    // split on real newlines and refuse the two-character sequence in every line.
    for (const file of ['hub.html', 'picker.html', 'index.html']) {
        const lines = fs.readFileSync(path.join(APP, file), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            assert.ok(!lines[i].includes('\\n'),
                `${file}:${i + 1} carries a literal \\n two-character sequence -- it renders as page text; use a real newline`);
        }
    }
});

// ---------------------------------------------------------------- #10 the Browse fill

test('studio browse: the fill keeps a typed Windows prefix and its trailing separator', () => {
    // browse.js is plain CommonJS-shipped browser JavaScript; the DOM boot is guarded so the
    // pure fill rule can be required and driven directly (the saas/lib test pattern).
    const browse = require('../src/studio/app/browse.js') as { fillPath: (existing: string, name: string) => string };
    const fill = browse.fillPath;
    assert.equal(typeof fill, 'function', 'browse.js exports the fillPath rule');
    assert.equal(fill('C:\\Users\\jf\\proj', 'demo'), 'C:\\Users\\jf\\demo',
        'a typed Windows path keeps its prefix and backslash (the old [^/]*$ regex ate all of it)');
    assert.equal(fill('/home/jf/proj', 'demo'), '/home/jf/demo', 'a typed POSIX path keeps its prefix');
    assert.equal(fill('C:\\', 'demo'), 'C:\\demo', 'a bare drive prefix keeps its separator');
    assert.equal(fill('', 'demo'), 'demo', 'an empty field just takes the folder name');
    assert.equal(fill('proj', 'demo'), 'demo', 'no separator anywhere: the name replaces the tail (the field stays authoritative)');
});

// ---------------------------------------------------------------- #9 the hub copy button

test('studio hub copy: a clipboard refusal is not reported as success', { skip }, async () => {
    await retryOnce(async () => {
        const browser = await chromium.launch();
        try {
            // execCommand signals refusal with a false return, not a throw. Force exactly that
            // documented signal (and drop navigator.clipboard so the execCommand fallback runs).
            const force = async (page: import('playwright').Page, result: boolean): Promise<void> => {
                await page.addInitScript(
                    'Object.defineProperty(navigator, "clipboard", { get: function () { return undefined; } });' +
                    `document.execCommand = function () { return ${result}; };`
                );
                await page.goto(url + '/hub', { waitUntil: 'networkidle' });
            };

            const refused = await browser.newContext();
            const bad = await refused.newPage();
            await force(bad, false);
            await bad.click('#copy-ask');
            await bad.waitForTimeout(400);
            assert.equal(await bad.locator('#copy-ask').textContent(), 'copy',
                'a refused copy must leave the button alone (no "copied" on a false return)');
            await refused.close();

            // Control: the same harness with execCommand returning true must still confirm, so
            // the assertion above holds because the guard is honest, not because done() is dead.
            const allowed = await browser.newContext();
            const good = await allowed.newPage();
            await force(good, true);
            await good.click('#copy-ask');
            await good.waitForTimeout(400);
            assert.match((await good.locator('#copy-ask').textContent()) ?? '', /copied/,
                'a successful fallback copy still confirms');
            await allowed.close();
        } finally {
            await browser.close();
        }
    });
});

// ---------------------------------------------------------------- #4 the picker's keydown leak

test('studio picker: the open-folder dialog owns the keyboard; Enter submits the typed path', { skip }, async () => {
    await retryOnce(async () => {
        const browser = await chromium.launch();
        try {
        const page = await browser.newPage();
        // The oracle is the network request: the typed path must reach POST /api/open (the
        // unfixed page preventDefaults the submit and navigates to a card instead).
        await page.route('**/api/open', async (route) => {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'stubopen1' }) });
        });
            await page.goto(url + '/', { waitUntil: 'networkidle' });
            await page.waitForFunction('document.querySelectorAll(".card-project").length === 2', null, { timeout: 8000 });

            // The repro setup: put a card cursor on screen (the list keyboard still has to work).
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.locator('.card-project.is-cursor').count(), 1, 'ArrowDown marks the first card');

            await page.click('#open-dir');
            await page.waitForSelector('#open-path', { state: 'visible' });
            assert.equal(await page.locator('.card-project.is-cursor').count(), 0,
                'opening the dialog drops the stale card cursor');
            await page.keyboard.press('ArrowDown');
            assert.equal(await page.locator('.card-project.is-cursor').count(), 0,
                'ArrowDown inside the dialog leaves the card list alone');

            await page.fill('#open-path', '/tmp/elsewhere/newproj');
            const opened = page.waitForRequest('**/api/open', { timeout: 8000 });
            await page.keyboard.press('Enter');
            // The success branch navigates only after the route fulfilled, so by the time the
            // URL settles the captured request's body is final and safe to read.
            await page.waitForURL((u: URL) => u.searchParams.get('project') === 'stubopen1', { timeout: 8000 });
            const posted = JSON.parse((await opened).postData() ?? '{}') as { path?: string };
            assert.equal(posted.path, '/tmp/elsewhere/newproj', 'Enter submitted the typed path to /api/open');
        } finally {
            await browser.close();
        }
    });
});
