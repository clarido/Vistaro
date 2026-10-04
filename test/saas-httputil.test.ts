import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

/**
 * Unit tests for saas/lib/httputil.js — JSON responses, capped body reading, file
 * serving with Range.
 *
 * No module mocking: each export is driven through the seam it actually touches
 * (docs/testing-discipline.md rule 5). contentTypeFor is pure. json() only needs
 * writeHead/end and res.req.method (httputil.js:41-48), so it gets a recording stub
 * object. readBody/readJsonBody attach data/end/error listeners and call resume()
 * (httputil.js:63-90), so they get a real PassThrough stream — the same flowing-mode
 * semantics as a request — carrying a headers object. serveFile stats then pipes a
 * real fs.createReadStream into res (httputil.js:112-177), so it is exercised over a
 * real node:http server on an ephemeral port (server.listen(0), closed in finally)
 * with real fetch clients that read whole response bodies: stubbing the res a file
 * stream pipes into would test nothing. No spawns, no fixed ports, PATH untouched.
 *
 * Not tested on purpose (surveyor's hazard): the two stream-onerror branches
 * (httputil.js:164, :173 — res.destroy() when createReadStream fails after
 * writeHead). They are a stat-then-open race that cannot be triggered reliably from
 * a unit test without writing a flaky test.
 */

// saas/lib is plain CommonJS JavaScript with no type declarations, and tsconfig keeps
// allowJs off: a static import would fail `npx tsc --noEmit` with TS7016. The
// workaround lives in this file only — a dynamic import whose specifier is typed as a
// plain string (so tsc cannot resolve the module, hence no error) plus a local cast.
// (Copied from test/saas-queue.test.ts:81-89.)
const httputilPath: string = '../saas/lib/httputil.js';

type JsonResLike = {
    req: { method: string };
    writeHead: (status: number, headers: Record<string, unknown>) => void;
    end: (body?: unknown) => void;
};

type StreamReqLike = { headers: Record<string, string | undefined> };

type ServeReqLike = { headers: Record<string, string | string[] | undefined>; method?: string };

type HttpErrorLike = Error & { status: number; extra: Record<string, unknown> };

type HttputilModule = {
    json: (res: JsonResLike, status: number, obj: unknown, extraHeaders?: Record<string, unknown>) => void;
    readBody: (req: StreamReqLike, maxBytes: number) => Promise<Buffer>;
    readJsonBody: (req: StreamReqLike, maxBytes?: number) => Promise<Record<string, unknown>>;
    serveFile: (req: ServeReqLike, res: unknown, filePath: string, opts?: { cacheControl?: string }) => Promise<boolean>;
    contentTypeFor: (filePath: string) => string;
    HttpError: new (status: number, message: string, extra?: Record<string, unknown>) => HttpErrorLike;
};

async function loadModule<T>(spec: string): Promise<T> {
    // Non-literal specifier: tsc has nothing to resolve, so no TS7016. At runtime tsx
    // compiles this file to CommonJS and the import lands on the lib's module.exports;
    // under a native dynamic import the CJS module shows up as `default`, so take that
    // when present.
    const ns: unknown = await import(spec);
    const wrapped = ns as { default?: T };
    return wrapped.default !== undefined && wrapped.default !== null ? wrapped.default : (ns as T);
}

const libsP: Promise<{ httputil: HttputilModule }> = (async () => ({
    httputil: await loadModule<HttputilModule>(httputilPath),
}))();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Settle `p` with a deadline: a mutation that never settles (a 413 that waits on the
 * stream instead of the declared length) must fail within ms, not hang the run —
 * node:test's own default timeout is Infinity (AGENTS.md, "nothing in a run may wait
 * forever").
 */
async function settleWithin<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    p.catch(() => {}); // if the deadline wins the race, the loser's late rejection stays handled
    return Promise.race([
        p,
        delay(ms).then(() => {
            throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        }),
    ]);
}

/** fetch with a deadline, for the same reason. */
async function fetchWithin(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
}

function assertHttpError(lib: HttputilModule, err: unknown, status: number, message: string, what: string): void {
    assert.ok(err instanceof lib.HttpError, `${what}: expected an HttpError from the lib, got ${String(err)}`);
    const he = err as HttpErrorLike;
    assert.equal(he.status, status, `${what}: expected status ${status}, got ${he.status}`);
    assert.equal(
        he.message,
        message,
        `${what}: expected the verbatim message ${JSON.stringify(message)}, got ${JSON.stringify(he.message)}`,
    );
}

// ---------------------------------------------------------------------------
// Stub req/res for the pure helpers (no port, fully deterministic)
// ---------------------------------------------------------------------------

/** A real Readable (the same flowing semantics as a request) carrying a headers object. */
function streamReq(headers: Record<string, string | undefined> = {}): PassThrough & StreamReqLike {
    const req = new PassThrough() as PassThrough & StreamReqLike;
    req.headers = headers;
    return req;
}

function streamWithBody(
    raw: string | Buffer | null,
    headers: Record<string, string | undefined> = {},
): PassThrough & StreamReqLike {
    const req = streamReq(headers);
    if (raw !== null) req.write(raw);
    req.end();
    return req;
}

type RecordedRes = JsonResLike & {
    status: number | null;
    headers: Record<string, unknown> | null;
    endCalls: unknown[][];
};

/** Records writeHead/end exactly as json() makes them; res.req.method keys the HEAD branch. */
function recordingRes(method: 'GET' | 'HEAD' = 'GET'): RecordedRes {
    const res: RecordedRes = {
        req: { method },
        status: null,
        headers: null,
        endCalls: [],
        writeHead(status, headers) {
            res.status = status;
            res.headers = headers;
        },
        end(...args: unknown[]) {
            res.endCalls.push(args);
        },
    };
    return res;
}

// ---------------------------------------------------------------------------
// A real node:http server on an ephemeral port for serveFile's streaming paths
// ---------------------------------------------------------------------------

type Routes = Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>;

async function listenOnEphemeralPort(routes: Routes): Promise<{ server: http.Server; url: (p: string) => string }> {
    const server = http.createServer((req, res) => {
        const route = routes[(req.url ?? '/').split('?')[0] ?? '/'];
        if (!route) {
            res.writeHead(404);
            res.end('no route');
            return;
        }
        route(req, res);
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP address with an ephemeral port');
    return { server, url: (p: string) => `http://127.0.0.1:${addr.port}${p}` };
}

/**
 * fetch/undici holds keep-alive sockets open, which would hold server.close() open;
 * destroy them first so the awaited close is bounded and nothing leaks into the next
 * serial test (AGENTS.md, "nothing in a run may wait forever").
 */
async function closeServer(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// contentTypeFor (httputil.js:33-37, table :6-31)
// ---------------------------------------------------------------------------

// The test's own table is the oracle: identical to the lib's CONTENT_TYPES today
// (24 entries) and every value is an exact string. If httputil.js gains or changes an
// extension, this table is the change to make; the count assert keeps the loop from
// passing vacuously.
const EXPECTED_CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.aiff': 'audio/aiff',
    '.vtt': 'text/vtt; charset=utf-8',
    '.zip': 'application/zip',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
};

test('contentTypeFor maps every documented extension to its exact MIME string (24 entries)', async () => {
    const libs = await libsP;
    assert.equal(
        Object.keys(EXPECTED_CONTENT_TYPES).length,
        24,
        'the oracle table must list every extension the lib maps — if httputil.js gains one, add it here; if this scans zero, the test is vacuous (rule 3)',
    );
    for (const [ext, mime] of Object.entries(EXPECTED_CONTENT_TYPES)) {
        assert.equal(libs.httputil.contentTypeFor(`asset${ext}`), mime, `asset${ext} must map to exactly ${JSON.stringify(mime)}`);
    }
});

test('contentTypeFor is case-insensitive and falls back to application/octet-stream', async () => {
    const libs = await libsP;
    assert.equal(libs.httputil.contentTypeFor('poster.PNG'), 'image/png', 'the extension is lowercased before the lookup (httputil.js:36)');
    assert.equal(libs.httputil.contentTypeFor('INDEX.HTML'), 'text/html; charset=utf-8', 'an uppercase HTML keeps its charset parameter');
    assert.equal(libs.httputil.contentTypeFor('no-extension'), 'application/octet-stream', 'a dotless path is opaque bytes (httputil.js:35)');
    assert.equal(libs.httputil.contentTypeFor('data.unknownxyz'), 'application/octet-stream', 'an unmapped extension falls back, it does not guess');
    assert.equal(libs.httputil.contentTypeFor('archive.tar.gz'), 'application/octet-stream', 'only the last extension counts, and .gz is unmapped');
    assert.equal(libs.httputil.contentTypeFor('trailing.'), 'application/octet-stream', 'a trailing dot is an empty extension: not in the table, so the fallback');
});

// ---------------------------------------------------------------------------
// json (httputil.js:39-49)
// ---------------------------------------------------------------------------

test('json writes the three fixed headers with a BYTE content-length and the exact JSON body', async () => {
    const libs = await libsP;
    const res = recordingRes('GET');
    libs.httputil.json(res, 201, { m: 'é' });
    assert.equal(res.status, 201, 'the status is passed through to writeHead');
    assert.deepEqual(
        res.headers,
        {
            'content-type': 'application/json; charset=utf-8',
            'content-length': 10,
            'cache-control': 'no-store',
        },
        '\'{"m":"é"}\' is 10 BYTES but 9 characters — a chars-vs-bytes content-length reds here (httputil.js:40,43)',
    );
    // json() ends with the Buffer it built (httputil.js:40,48), so the identity assert is on exact bytes.
    assert.deepEqual(res.endCalls, [[Buffer.from('{"m":"é"}', 'utf8')]], 'the GET body is the exact JSON text as bytes, ended once');

    const res2 = recordingRes('GET');
    libs.httputil.json(res2, 200, { t: '中文 x' });
    assert.equal(res2.headers?.['content-length'], 16, '\'{"t":"中文 x"}\' is 16 bytes but 12 characters — a second script pins the byte length');
});

test('extraHeaders merge after the fixed headers, so a caller can override content-type', async () => {
    const libs = await libsP;
    const res = recordingRes('GET');
    libs.httputil.json(res, 200, { ok: true }, { 'content-type': 'text/plain', 'x-job': 'job-9' });
    assert.equal(res.headers?.['content-type'], 'text/plain', 'extraHeaders spread LAST (httputil.js:45), so an override wins over the fixed JSON type');
    assert.equal(res.headers?.['x-job'], 'job-9', 'extra keys ride along');
    assert.equal(res.headers?.['cache-control'], 'no-store', 'keys the caller does not pass keep their fixed values');
    assert.equal(res.headers?.['content-length'], 11, '\'{"ok":true}\' is 11 bytes');
    assert.deepEqual(res.endCalls, [[Buffer.from('{"ok":true}', 'utf8')]]);
});

test('json answers a HEAD with full headers and no body', async () => {
    const libs = await libsP;
    const res = recordingRes('HEAD');
    libs.httputil.json(res, 200, { ok: true });
    assert.equal(res.status, 200, 'headers are written for a HEAD too');
    assert.equal(res.headers?.['content-length'], 11, 'content-length still describes the body a GET would carry');
    assert.deepEqual(
        res.endCalls,
        [[]],
        'the HEAD end call must carry NO arguments (httputil.js:47-48) — a body on a HEAD corrupts keep-alive framing',
    );
});

// ---------------------------------------------------------------------------
// HttpError (httputil.js:51-57)
// ---------------------------------------------------------------------------

test('HttpError carries .status and .extra and stays an Error instance', async () => {
    const libs = await libsP;
    const err = new libs.httputil.HttpError(503, 'queue is full', { retryAfterMs: 400 });
    assert.ok(err instanceof Error, 'an HttpError IS an Error — server.js\'s catch-all keys on `e instanceof HttpError` (server.js:336)');
    assert.ok(err instanceof libs.httputil.HttpError, 'instanceof works through the extends chain (httputil.js:51-57)');
    assert.equal(err.status, 503, '.status is the response status');
    assert.equal(err.message, 'queue is full', '.message carries the verbatim message');
    assert.deepEqual(err.extra, { retryAfterMs: 400 }, '.extra carries structured detail');
    assert.deepEqual(new libs.httputil.HttpError(400, 'x').extra, {}, 'extra defaults to an empty object (httputil.js:52)');
});

// ---------------------------------------------------------------------------
// readBody (httputil.js:63-90)
// ---------------------------------------------------------------------------

test('readBody rejects a declared content-length above the cap BEFORE any byte is read, naming both numbers', async () => {
    const libs = await libsP;
    const req = streamReq({ 'content-length': '200' });
    let resumeCalls = 0;
    const realResume = req.resume.bind(req);
    (req as unknown as { resume: () => void }).resume = () => {
        resumeCalls += 1;
        realResume();
    };

    // Nothing has been written and the stream is never ended: if the 413 waited on the
    // stream, settleWithin's deadline turns the hang into a named failure instead.
    await assert.rejects(
        settleWithin(libs.httputil.readBody(req, 100), 5000, 'the declared-length 413 (it must not wait on the stream)'),
        (e: unknown) => {
            assertHttpError(libs.httputil, e, 413, 'request body too large (200 bytes > 100)', 'declared-length overflow');
            return true;
        },
        'the 413 must name BOTH numbers verbatim (httputil.js:67) — the mid-stream variant says "> 100 bytes" instead',
    );
    assert.ok(resumeCalls >= 1, 'the oversized request is drained with resume() (httputil.js:68), not left paused or destroyed');
});

test('readBody rejects ONCE mid-stream over the cap and drains rather than destroys', async () => {
    const libs = await libsP;
    const req = streamReq({}); // no content-length: exercises the mid-stream branch (httputil.js:74-84)
    let resumeCalls = 0;
    const realResume = req.resume.bind(req);
    (req as unknown as { resume: () => void }).resume = () => {
        resumeCalls += 1;
        realResume();
    };
    let settledAs: 'none' | 'resolved' | 'rejected' = 'none';
    const p = libs.httputil.readBody(req, 100);
    p.then(
        () => { settledAs = 'resolved'; },
        () => { settledAs = 'rejected'; },
    );
    // My own data listener counts what flows after the rejection: on a destroyed stream
    // nothing further is ever emitted, so bytes-after-reject > 0 is the drain proof.
    let draining = false;
    let bytesAfterReject = 0;
    req.on('data', (c: Buffer) => { if (draining) bytesAfterReject += c.length; });

    req.write('a'.repeat(60)); // under the cap: kept
    req.write('b'.repeat(90)); // 150 total: over the cap
    await assert.rejects(
        // settleWithin: under a mutation that drops the mid-stream 413 this promise
        // never settles and a bare PassThrough holds no event-loop handles, so the
        // loop would drain and node:test would cancel the REST of the file instead
        // of failing this one test by name (found by this test's own mutation check).
        settleWithin(p, 5000, 'the mid-stream 413 (a widened cap must not leave the body promise pending)'),
        (e: unknown) => {
            assertHttpError(libs.httputil, e, 413, 'request body too large (> 100 bytes)', 'mid-stream overflow');
            return true;
        },
        'the mid-stream 413 names ONLY the cap (httputil.js:79) — the declared-length variant names both numbers',
    );
    draining = true;
    req.write('c'.repeat(30)); // the tail of a body still in flight after the 413
    req.end(); // the stream still finishes after the rejection
    await delay(30);

    assert.equal(
        settledAs,
        'rejected',
        'the done latch (httputil.js:87) keeps the later end() from RESOLVING the promise — a resolve-after-reject would hand a handler two responses',
    );
    // `destroyed` is deliberately not asserted: a PassThrough auto-destroys once it is
    // ended and fully drained, which is the good outcome. The honest drain evidence is
    // that the tail bytes still flowed and end still arrived (a real destroy would
    // emit neither — that is the ECONNRESET the lib's comment at :80-81 avoids).
    assert.equal(
        bytesAfterReject,
        30,
        'the tail kept flowing to the resume() drain (httputil.js:82) — a destroy mid-flight would emit nothing further and the client would see ECONNRESET',
    );
    assert.equal(req.readableEnded, true, 'end still arrived; it was ignored by the done latch, not awaited');
    assert.ok(resumeCalls >= 1, 'the drain is a resume()');
});

test('readBody concatenates under-cap chunks in arrival order and resolves on end', async () => {
    const libs = await libsP;
    const req = streamReq({});
    req.write('Hello, ');
    req.write('wor');
    req.write('ld!');
    req.end();
    const body = await libs.httputil.readBody(req, 1000);
    assert.ok(Buffer.isBuffer(body), 'readBody resolves to a Buffer');
    assert.equal(body.toString('utf8'), 'Hello, world!', 'chunks are concatenated in arrival order (httputil.js:87 Buffer.concat)');
    assert.equal(body.length, 13, 'the byte length, not the chunk count');
});

test('readBody propagates stream errors as-is', async () => {
    const libs = await libsP;
    const req = streamReq({});
    const boom = new Error('socket exploded');
    const p = libs.httputil.readBody(req, 1000);
    req.emit('error', boom); // the listeners are attached synchronously inside the promise executor
    await assert.rejects(p, (e: unknown) => e === boom, 'a stream error is rethrown untouched (httputil.js:88), not wrapped in an HttpError');
});

// ---------------------------------------------------------------------------
// readJsonBody (httputil.js:92-105)
// ---------------------------------------------------------------------------

test('readJsonBody: an empty body is {}, an object round-trips, non-object JSON is the verbatim 400', async () => {
    const libs = await libsP;

    const empty = await libs.httputil.readJsonBody(streamWithBody(null));
    assert.deepEqual(empty, {}, 'an empty body parses to {} (httputil.js:94)');

    const src = { id: 'job-1', count: 2, nested: { tags: ['a', 'é'] } };
    const round = await libs.httputil.readJsonBody(streamWithBody(JSON.stringify(src)));
    assert.deepEqual(round, src, 'a valid JSON object round-trips');

    // null, arrays and scalars all cross JSON.parse fine — the object check at
    // httputil.js:97-99 throws the HttpError, and the instanceof pass-through at :102
    // is what keeps it from being re-labelled "not valid JSON" by the catch below.
    for (const raw of ['null', '[1, 2]', '42', '"a string"', 'true']) {
        await assert.rejects(
            libs.httputil.readJsonBody(streamWithBody(raw)),
            (e: unknown) => {
                assertHttpError(libs.httputil, e, 400, 'request body must be a JSON object', `body ${raw}`);
                return true;
            },
            `${raw} must be refused with 400 "request body must be a JSON object" — if it comes back as "is not valid JSON", the instanceof pass-through at httputil.js:102 was dropped`,
        );
    }
});

test('readJsonBody: malformed JSON is the verbatim 400 "request body is not valid JSON"', async () => {
    const libs = await libsP;
    await assert.rejects(
        libs.httputil.readJsonBody(streamWithBody('{"a": nope}')),
        (e: unknown) => {
            assertHttpError(libs.httputil, e, 400, 'request body is not valid JSON', 'malformed body');
            return true;
        },
    );
});

test('readJsonBody default cap is exactly 1 MiB: 1048576 parses, 1048577 is the verbatim 413', async () => {
    const libs = await libsP;
    const pad = 'a'.repeat(1024 * 1024 - 10); // '{"pad":"' (8) + pad + '"}' (2) = 1048576 bytes
    const at = await libs.httputil.readJsonBody(streamWithBody(`{"pad":"${pad}"}`));
    assert.deepEqual(at, { pad }, 'a body of exactly 1048576 bytes still parses under the default cap (httputil.js:92)');

    const over = streamWithBody(Buffer.alloc(1024 * 1024 + 1, 0x61));
    await assert.rejects(
        settleWithin(libs.httputil.readJsonBody(over), 5000, 'the default-cap 413'),
        (e: unknown) => {
            assertHttpError(libs.httputil, e, 413, 'request body too large (> 1048576 bytes)', 'default-cap overflow');
            return true;
        },
        'the 413 must name the DEFAULT cap 1048576 verbatim — any other number means the default changed',
    );
});

// ---------------------------------------------------------------------------
// serveFile (httputil.js:112-177) — real files, real server, real clients
// ---------------------------------------------------------------------------

test('serveFile resolves false for an absent path and for a directory, writing nothing', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-httputil-'));
    try {
        const dir = path.join(tmp, 'a-directory');
        fs.mkdirSync(dir);
        const req: ServeReqLike = { headers: {}, method: 'GET' };
        const res = recordingRes('GET');

        const absent = await libs.httputil.serveFile(req, res, path.join(tmp, 'missing.bin'));
        assert.equal(absent, false, 'an absent path resolves false (httputil.js:115-120) — the caller writes its own 404 (server.js:187-188)');
        assert.equal(res.status, null, 'nothing was written for an absent file');
        assert.equal(res.endCalls.length, 0, 'no end, no body, no half-response');

        const isDir = await libs.httputil.serveFile(req, res, dir);
        assert.equal(isDir, false, 'a directory is not a file (httputil.js:121)');
        assert.equal(res.status, null, 'still nothing written');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('serveFile: full GET/HEAD carry content-type by extension, accept-ranges, nosniff, cache-control (default + override) and the file\'s exact bytes', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-httputil-'));
    const pageBytes = Buffer.from('<!doctype html><h1>Voilà — café ☕</h1>\n', 'utf8');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xfe, 0xff]);
    fs.writeFileSync(path.join(tmp, 'page.html'), pageBytes);
    fs.writeFileSync(path.join(tmp, 'icon.png'), pngBytes);
    const { server, url } = await listenOnEphemeralPort({
        '/page.html': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'page.html')); },
        '/icon.png': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'icon.png')); },
        '/no-store': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'page.html'), { cacheControl: 'no-store' }); },
    });
    try {
        const page = await fetchWithin(url('/page.html'));
        const pageBody = Buffer.from(await page.arrayBuffer());
        assert.equal(page.status, 200, 'a plain GET answers 200 (httputil.js:170)');
        assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8', 'content-type is chosen by extension (httputil.js:123)');
        assert.equal(page.headers.get('accept-ranges'), 'bytes', 'range support is advertised on every file (httputil.js:127)');
        assert.equal(page.headers.get('x-content-type-options'), 'nosniff', 'nosniff is set (httputil.js:129)');
        assert.equal(page.headers.get('cache-control'), 'public, max-age=300', 'the DEFAULT cache-control is public, max-age=300 (httputil.js:112)');
        assert.equal(page.headers.get('content-length'), String(pageBytes.length), 'content-length is the file\'s exact byte size');
        assert.ok(pageBody.equals(pageBytes), 'the body bytes EQUAL the file\'s bytes, multibyte utf8 included (rule 3: identity, not class)');

        const icon = await fetchWithin(url('/icon.png'));
        await icon.arrayBuffer(); // drain fully before asserting: serveFile resolves on stream close
        assert.equal(icon.status, 200);
        assert.equal(icon.headers.get('content-type'), 'image/png', 'a binary type carries no charset parameter');

        const override = await fetchWithin(url('/no-store'));
        await override.arrayBuffer();
        assert.equal(override.status, 200);
        assert.equal(override.headers.get('cache-control'), 'no-store', 'the cacheControl option overrides the default (httputil.js:112; server.js:129 precedent)');

        const head = await fetchWithin(url('/page.html'), { method: 'HEAD' });
        const headBody = Buffer.from(await head.arrayBuffer());
        assert.equal(head.status, 200, 'HEAD answers 200');
        assert.equal(head.headers.get('content-length'), String(pageBytes.length), 'HEAD carries the content-length (httputil.js:170)');
        assert.equal(head.headers.get('accept-ranges'), 'bytes');
        assert.equal(headBody.length, 0, 'a HEAD has a zero-byte body (httputil.js:171)');
    } finally {
        await closeServer(server);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('serveFile: Range requests return exact 206 byte slices (first-N, suffix -N, open-ended, end clamped at EOF)', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-httputil-'));
    const bytes = Buffer.alloc(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256; // byte i carries value i%256: every slice is self-describing
    fs.writeFileSync(path.join(tmp, 'data.bin'), bytes);
    const { server, url } = await listenOnEphemeralPort({
        '/data.bin': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'data.bin')); },
    });
    try {
        const cases = [
            { range: 'bytes=0-99', contentRange: 'bytes 0-99/300', first: 0, last: 99, why: 'a plain first-100 range' },
            { range: 'bytes=-50', contentRange: 'bytes 250-299/300', first: 250, last: 299, why: 'a suffix range is the LAST N bytes (httputil.js:143-147)' },
            { range: 'bytes=280-', contentRange: 'bytes 280-299/300', first: 280, last: 299, why: 'an open-ended range runs to EOF (httputil.js:150)' },
            { range: 'bytes=250-500', contentRange: 'bytes 250-299/300', first: 250, last: 299, why: 'an end past EOF clamps to size-1 (httputil.js:150 Math.min)' },
        ];
        for (const c of cases) {
            const res = await fetchWithin(url('/data.bin'), { headers: { range: c.range } });
            const body = Buffer.from(await res.arrayBuffer());
            assert.equal(res.status, 206, `${c.range}: expected 206 — ${c.why}`);
            assert.equal(res.headers.get('content-range'), c.contentRange, `${c.range}: content-range must name the served slice verbatim`);
            assert.equal(res.headers.get('content-length'), String(c.last - c.first + 1), `${c.range}: content-length must equal the slice length`);
            assert.ok(
                body.equals(bytes.subarray(c.first, c.last + 1)),
                `${c.range}: the BODY must equal the file's exact bytes [${c.first}, ${c.last}] — a right-status/wrong-slice bug passes any status-only test (rule 3)`,
            );
        }

        // The 206 keeps the base headers too (httputil.js:159-163).
        const one = await fetchWithin(url('/data.bin'), { headers: { range: 'bytes=0-0' } });
        await one.arrayBuffer();
        assert.equal(one.status, 206, 'a one-byte range is served as 206');
        assert.equal(one.headers.get('content-type'), 'application/octet-stream', '.bin is unmapped, so the 206 carries the fallback type (httputil.js:123)');
        assert.equal(one.headers.get('accept-ranges'), 'bytes', 'accept-ranges rides on a 206 as well');
    } finally {
        await closeServer(server);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('serveFile: malformed, empty, inverted and past-EOF ranges answer 416 with "bytes */SIZE"', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-httputil-'));
    const bytes = Buffer.alloc(300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    fs.writeFileSync(path.join(tmp, 'data.bin'), bytes);
    const { server, url } = await listenOnEphemeralPort({
        '/data.bin': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'data.bin')); },
    });
    try {
        const bad = [
            { range: 'bytes=', why: 'no numbers at all' },
            { range: 'bytes=abc', why: 'non-numeric bounds fail the regex (httputil.js:133)' },
            { range: 'chars=0-5', why: 'not a bytes unit' },
            { range: 'bytes=-', why: 'both bounds empty (httputil.js:135)' },
            { range: 'bytes=0-1,5-6', why: 'multi-range is not supported and must not be half-served' },
            { range: 'bytes=5-2', why: 'start > end (httputil.js:152)' },
            { range: 'bytes=300-', why: 'start == size (httputil.js:152)' },
            { range: 'bytes=999-1005', why: 'start far past EOF (httputil.js:152)' },
        ] as const;
        for (const { range, why } of bad) {
            const res = await fetchWithin(url('/data.bin'), { headers: { range } });
            const body = Buffer.from(await res.arrayBuffer());
            assert.equal(res.status, 416, `${range}: expected 416 — ${why}`);
            assert.equal(res.headers.get('content-range'), 'bytes */300', `${range}: the 416 must carry "bytes */SIZE" with the whole size verbatim`);
            assert.equal(body.length, 0, `${range}: a 416 carries no body`);
        }
    } finally {
        await closeServer(server);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('serveFile: an empty file answers 200 with content-length 0, but a suffix range on it answers 416 "bytes */0"', async () => {
    const libs = await libsP;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-httputil-'));
    fs.writeFileSync(path.join(tmp, 'empty.txt'), '');
    const { server, url } = await listenOnEphemeralPort({
        '/empty.txt': (req, res) => { void libs.httputil.serveFile(req, res, path.join(tmp, 'empty.txt')); },
    });
    try {
        const full = await fetchWithin(url('/empty.txt'));
        assert.equal(full.status, 200, 'a full GET of an empty file is a fine 200');
        assert.equal(full.headers.get('content-length'), '0');
        assert.equal(Buffer.from(await full.arrayBuffer()).length, 0);

        const suffix = await fetchWithin(url('/empty.txt'), { headers: { range: 'bytes=-10' } });
        const body = Buffer.from(await suffix.arrayBuffer());
        assert.equal(suffix.status, 416, 'a suffix range on an EMPTY file is unsatisfiable (httputil.js:135: m[1]==="" && size===0)');
        assert.equal(suffix.headers.get('content-range'), 'bytes */0', 'the 416 names the true size: 0');
        assert.equal(body.length, 0);
    } finally {
        await closeServer(server);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
