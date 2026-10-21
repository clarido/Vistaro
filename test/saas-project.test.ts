import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Unit tests for saas/lib/project.js — unpackProject(zipBuf, jobDirAbs), the
 * upload → <jobDir>/project/ unpacker the POST /v1/builds handler calls
 * (saas/server.js:28, :210).
 *
 * No module mocking and no fs mocking: the module is pure Node (no ports, no spawns,
 * no platform skips), so the only seam is its second argument — a per-test temp job
 * dir under os.tmpdir() (mkdtempSync, rmSync in the finally, like
 * saas-queue.test.ts:176-198). The oracle is the real filesystem read back with
 * plain fs — every extracted file compared byte for byte with the bytes the fixture
 * archive carried — plus the returned { files, bytes } asserted as exact identity
 * numbers. The lib's own extractZip is never used to verify anything: trusting the
 * reader inside the test of the code that calls it would be circular.
 *
 * Fixtures are hand-built ZIP archive Buffers from zipBytes() below: stored (method
 * 0) and deflate (method 8) entries with real CRC-32s, which zip.js verifies on
 * Node >= 20.15 (zip.js:164-168). The builder was validated once, off-suite,
 * against an archive /usr/bin/zip wrote from the same files — the two extract
 * identically through saas/lib/zip.js and `unzip -t` accepts the hand-built one —
 * but nothing is spawned inside the suite: the spawn-bounds canary counts spawn
 * sites in test/*.test.ts and must stay untouched. The builder lives in this file
 * rather than a shared test/zip-bytes.ts because this lot edits only its own test
 * file; test/saas-zip.test.ts landed in the same lot carrying the same builder —
 * lift both into test/zip-bytes.ts when a lot next owns a shared helper.
 *
 * Partial-state honesty: a missing-screen ZipError throws AFTER every entry was
 * already written to disk (the extract loop at project.js:25-31 precedes the
 * requireScreenFiles guard at :57), so the extracted files legitimately remain
 * under <jobDir>/project/. Those tests assert the verbatim message AND what stayed
 * on disk — never a cleanup the code does not do.
 */

// saas/lib is plain CommonJS JavaScript with no type declarations, and tsconfig keeps
// allowJs off: a static import would fail `npx tsc --noEmit` with TS7016. The
// workaround lives in this file only — a dynamic import whose specifier is typed as a
// plain string (so tsc cannot resolve the module, hence no error) plus a local cast.
const projectJs: string = '../saas/lib/project.js';
const zipJs: string = '../saas/lib/zip.js';

type ProjectModule = {
    unpackProject(zipBuf: Buffer, jobDirAbs: string): { files: number; bytes: number };
};

// project.js re-exports nothing: ZipError comes from the zip module project.js itself
// requires (project.js:6), so instanceof here pins the very class the lib throws.
type ZipModule = {
    ZipError: new (message: string) => Error;
};

type Libs = { project: ProjectModule; zip: ZipModule };

async function loadModule<T>(spec: string): Promise<T> {
    // Non-literal specifier: tsc has nothing to resolve, so no TS7016. At runtime tsx
    // compiles this file to CommonJS and the import lands on the lib's module.exports;
    // under a native dynamic import the CJS module shows up as `default`, so take that
    // when present.
    const ns: unknown = await import(spec);
    const wrapped = ns as { default?: T };
    return wrapped.default !== undefined && wrapped.default !== null ? wrapped.default : (ns as T);
}

const libsP: Promise<Libs> = (async () => ({
    project: await loadModule<ProjectModule>(projectJs),
    zip: await loadModule<ZipModule>(zipJs),
}))();

// ---------------------------------------------------------------------------
// The hand-built ZIP fixture builder
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; data: Buffer; method?: 0 | 8 };

// IEEE CRC-32, the check zip.js runs when zlib.crc32 exists (zip.js:164-168). A
// fixture with a wrong CRC would throw 'crc32 mismatch' before unpackProject does
// any work, so the builder computes the real value.
const CRC_TABLE: number[] = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a whole ZIP archive Buffer by hand: local headers + payloads, then the
 * central directory, then the EOCD — the three records zip.js walks (zip.js:42-49,
 * 102-181). Names are UTF-8 (flag 0x0800, zip.js:119) and external attrs stay 0 so
 * no entry can read as a symlink (zip.js:124). Validated off-suite against
 * /usr/bin/zip (see the file comment); not by extractZip inside this suite.
 */
function zipBytes(entries: ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const method = e.method ?? 0;
        const payload = method === 8 ? zlib.deflateRawSync(e.data) : Buffer.from(e.data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0); // local file header signature
        local.writeUInt16LE(20, 4); // version needed to extract
        local.writeUInt16LE(0x0800, 6); // general-purpose flags: bit 11 = UTF-8 names
        local.writeUInt16LE(method, 8); // 0 stored, 8 deflate
        local.writeUInt16LE(0, 10); // mod time (never read by the walker)
        local.writeUInt16LE(0x0021, 12); // mod date 1980-01-01 (never read)
        local.writeUInt32LE(crc32(e.data), 14);
        local.writeUInt32LE(payload.length, 18); // compressed size
        local.writeUInt32LE(e.data.length, 22); // uncompressed size
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra field length
        name.copy(local, 30);
        locals.push(local, payload);

        const cen = Buffer.alloc(46 + name.length);
        cen.writeUInt32LE(0x02014b50, 0); // central directory signature
        cen.writeUInt16LE(20, 4); // version made by (DOS)
        cen.writeUInt16LE(20, 6); // version needed
        cen.writeUInt16LE(0x0800, 8); // flags
        cen.writeUInt16LE(method, 10);
        cen.writeUInt16LE(0, 12); // mod time
        cen.writeUInt16LE(0x0021, 14); // mod date
        cen.writeUInt32LE(crc32(e.data), 16);
        cen.writeUInt32LE(payload.length, 20);
        cen.writeUInt32LE(e.data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt16LE(0, 30); // extra len
        cen.writeUInt16LE(0, 32); // comment len
        cen.writeUInt16LE(0, 34); // disk number start
        cen.writeUInt16LE(0, 36); // internal attrs
        cen.writeUInt32LE(0, 38); // external attrs: no unix mode bits, so no symlink
        cen.writeUInt32LE(offset, 42); // offset of the local header above
        name.copy(cen, 46);
        centrals.push(cen);

        offset += local.length + payload.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with the central directory
    eocd.writeUInt16LE(entries.length, 8); // entries on this disk
    eocd.writeUInt16LE(entries.length, 10); // total entries
    eocd.writeUInt32LE(cd.length, 12); // central directory size
    eocd.writeUInt32LE(offset, 16); // central directory offset
    eocd.writeUInt16LE(0, 20); // comment length
    return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// Per-test world: a temp job dir under os.tmpdir(), removed in the finally
// ---------------------------------------------------------------------------

type World = { tmp: string; jobDir: string };

function makeWorld(): World {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saas-project-'));
    const jobDir = path.join(tmp, 'job');
    // The job dir itself is created up front (server.js passes jobs.createJobDirs
    // output, which exists), so "nothing was created" below means precisely
    // <jobDir>/project — not an absent tree.
    fs.mkdirSync(jobDir, { recursive: true });
    return { tmp, jobDir };
}

// Fixture payloads. The PNG stand-in cycles through every byte value 0..255
// ((i*7+13) mod 256, 7 coprime with 256), so any text round-trip of binary entry
// data shows up as a byte mismatch on read-back.
const SCREEN_HTML = Buffer.from(
    '<!doctype html>\n<html><body><h1>Demoforge screen</h1><main id="app"></main></body></html>\n',
);
const CONFIG_JSON = Buffer.from(
    '{"meta":{"title":"Create a report","slug":"create-report"},"steps":[]}\n',
);
// Repetitive on purpose: deflate has something to chew on, so the deflate path of
// the reader is exercised for real.
const APP_CSS = Buffer.from('body { color: #3B82F6; font-family: sans-serif; }\n.card { border-radius: 8px; }\n'.repeat(6));
const LOGO_BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7 + 13) & 0xff));
const NOTES_TXT = Buffer.from('just a stray text file\n');

function onDisk(jobDir: string, entryName: string): string {
    // The mirror of project.js:26 — '/'-separated entry names land as nested paths.
    return path.join(jobDir, 'project', ...entryName.split('/'));
}

function payloadSum(entries: ZipEntry[]): number {
    return entries.reduce((n, e) => n + e.data.length, 0);
}

function assertOnDisk(jobDir: string, entries: ZipEntry[]): void {
    for (const e of entries) {
        assert.deepEqual(
            fs.readFileSync(onDisk(jobDir, e.name)),
            e.data,
            `the bytes on disk at project/${e.name} are exactly the bytes the archive carried`,
        );
    }
}

function assertZipError(libs: Libs, run: () => unknown, message: string, what: string): void {
    assert.throws(
        run,
        (e: unknown) => {
            const err = e as Error;
            return err instanceof libs.zip.ZipError && err.name === 'ZipError' && err.message === message;
        },
        `${what} — expected the ZipError thrown verbatim, message ${JSON.stringify(message)} ` +
            '(a wording change in project.js must land together with this assert)',
    );
}

// ---------------------------------------------------------------------------
// The PK-header guard (project.js:15-17)
// ---------------------------------------------------------------------------

test('unpackProject refuses a buffer without the PK header with the verbatim ZipError and creates nothing', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const notAZip = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('a real image, not an archive')]);
        const what = 'a non-ZIP upload is refused by the guard at project.js:15';
        assertZipError(libs, () => libs.project.unpackProject(notAZip, w.jobDir), 'upload is not a ZIP archive (missing PK header)', what);
        // The guard precedes the mkdir (project.js:15 vs :19), so a refused upload
        // leaves the job dir exactly as it was: no project/ directory at all.
        assert.equal(
            fs.existsSync(path.join(w.jobDir, 'project')),
            false,
            'the guard precedes the mkdir — a refused upload creates no <jobDir>/project/',
        );

        // Same verdict for the degenerate buffer: zero bytes cannot start with PK.
        assertZipError(
            libs,
            () => libs.project.unpackProject(Buffer.alloc(0), w.jobDir),
            'upload is not a ZIP archive (missing PK header)',
            'an empty upload is refused by the same guard',
        );
        assert.equal(fs.existsSync(path.join(w.jobDir, 'project')), false, 'still nothing created for the empty upload');
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// The happy path (project.js:14-36): extraction identity
// ---------------------------------------------------------------------------

test('a screen archive unpacks under <jobDir>/project with byte-identical contents and identity { files, bytes }', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        // Mixed methods and depths: stored and deflate, a two-level and a
        // three-level path — the '/'-separated entry name is split into nested
        // directories at project.js:26.
        const entries: ZipEntry[] = [
            { name: 'index.html', data: SCREEN_HTML, method: 0 },
            { name: 'vistaro.config.json', data: CONFIG_JSON, method: 0 },
            { name: 'assets/app.css', data: APP_CSS, method: 8 },
            { name: 'media/logo.png', data: LOGO_BYTES, method: 0 },
            { name: 'assets/img/icons/feed.svg', data: Buffer.from('<svg></svg>\n'), method: 8 },
        ];
        const result = libs.project.unpackProject(zipBytes(entries), w.jobDir);

        assert.deepEqual(
            result,
            { files: 5, bytes: payloadSum(entries) },
            '{ files, bytes } is the exact entry count and the exact summed uncompressed byte length',
        );
        assertOnDisk(w.jobDir, entries);
        // The project dir holds exactly the five entries' top-level shapes — nothing
        // invented, nothing dropped (sorted: readdir order is the OS's, not ours).
        assert.deepEqual(
            [...fs.readdirSync(path.join(w.jobDir, 'project'))].sort(),
            ['assets', 'index.html', 'media', 'vistaro.config.json'],
            'the project root holds exactly the archive’s top-level shapes',
        );
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// flattenWrapperDir (project.js:39-50)
// ---------------------------------------------------------------------------

test('everything wrapped in one top-level folder with the screen inside is unwrapped to the project root', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const entries: ZipEntry[] = [
            { name: 'my-site/index.html', data: SCREEN_HTML, method: 0 },
            { name: 'my-site/vistaro.config.json', data: CONFIG_JSON, method: 8 },
            { name: 'my-site/assets/app.css', data: APP_CSS, method: 8 },
        ];
        const result = libs.project.unpackProject(zipBytes(entries), w.jobDir);

        // The return is honest about the archive it read: 3 entries, summed bytes —
        // the unwrap moves files, it does not re-read them.
        assert.deepEqual(result, { files: 3, bytes: payloadSum(entries) }, 'the counters describe the archive, not the unwrap');
        assertOnDisk(w.jobDir, [
            { name: 'index.html', data: SCREEN_HTML },
            { name: 'vistaro.config.json', data: CONFIG_JSON },
            { name: 'assets/app.css', data: APP_CSS },
        ]);
        assert.equal(
            fs.existsSync(path.join(w.jobDir, 'project', 'my-site')),
            false,
            'the wrapper directory itself is gone (project.js:46-49): its children were renamed out, not copied',
        );
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

test('index.html already at the root: nothing is unwrapped — even a nested dir holding its own index.html survives untouched', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        // The nested index.html is what makes this test able to fail: drop the
        // hasScreenFiles(projectDir) guard at project.js:40 and flattenWrapperDir
        // would rename archive-screens/index.html over the root screen.
        const entries: ZipEntry[] = [
            { name: 'index.html', data: SCREEN_HTML, method: 0 },
            { name: 'vistaro.config.json', data: CONFIG_JSON, method: 0 },
            { name: 'archive-screens/index.html', data: Buffer.from('<!doctype html><html><body>old screen</body></html>'), method: 0 },
            { name: 'archive-screens/media/logo.png', data: LOGO_BYTES, method: 8 },
        ];
        const result = libs.project.unpackProject(zipBytes(entries), w.jobDir);

        assert.deepEqual(result, { files: 4, bytes: payloadSum(entries) }, 'the archive is read whole, nothing unwrapped');
        assertOnDisk(w.jobDir, entries);
        assert.deepEqual(
            [...fs.readdirSync(path.join(w.jobDir, 'project'))].sort(),
            ['archive-screens', 'index.html', 'vistaro.config.json'],
            'every authored path survives: the root screen stays the root screen',
        );
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

test('two top-level dirs: nothing is unwrapped, and the missing-screen ZipError names both files — entries honestly left on disk', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const entries: ZipEntry[] = [
            { name: 'a/index.html', data: SCREEN_HTML, method: 0 },
            { name: 'a/vistaro.config.json', data: CONFIG_JSON, method: 0 },
            { name: 'b/notes.txt', data: NOTES_TXT, method: 0 },
        ];
        // dirs.length !== 1 (project.js:43) refuses to guess between a/ and b/, so
        // nothing is renamed — and requireScreenFiles then throws at the root.
        assertZipError(
            libs,
            () => libs.project.unpackProject(zipBytes(entries), w.jobDir),
            'the archive must contain a Demoforge screen at its root (missing: index.html, vistaro.config.json)',
            'two top-level dirs are not a wrapper the code may flatten',
        );
        // Partial-state honesty: the extract loop (project.js:25-31) ran before the
        // guard (:57), so the entries stay on disk where they were extracted — under
        // a/ and b/, NOT promoted to the root.
        assertOnDisk(w.jobDir, entries);
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

test('a single top-level dir without index.html inside is not unwrapped either — its contents stay nested under it', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const entries: ZipEntry[] = [{ name: 'docs/readme.md', data: Buffer.from('# notes\n'), method: 0 }];
        // hasScreenFiles(inner) is false (project.js:45), so docs/ is not mistaken
        // for a wrapper; requireScreenFiles then throws the both-missing message.
        assertZipError(
            libs,
            () => libs.project.unpackProject(zipBytes(entries), w.jobDir),
            'the archive must contain a Demoforge screen at its root (missing: index.html, vistaro.config.json)',
            'a screenless single dir is not unwrapped and the archive is refused',
        );
        assertOnDisk(w.jobDir, entries);
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// requireScreenFiles (project.js:57-66): the CLI's screen contract
// ---------------------------------------------------------------------------

test('missing only index.html: the ZipError names it alone, and the extracted vistaro.config.json stays on disk', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const entries: ZipEntry[] = [{ name: 'vistaro.config.json', data: CONFIG_JSON, method: 0 }];
        // A root-level file is not a wrapper candidate (dirs.length === 0 at
        // project.js:43), so this reaches the guard with exactly one screen file.
        assertZipError(
            libs,
            () => libs.project.unpackProject(zipBytes(entries), w.jobDir),
            'the archive must contain a Demoforge screen at its root (missing: index.html)',
            'a timeline without a screen is refused with the one-file message',
        );
        assertOnDisk(w.jobDir, entries);
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});

test('missing both screen files: the message is the joined pair, verbatim — the join is the contract', async () => {
    const libs = await libsP;
    const w = makeWorld();
    try {
        const entries: ZipEntry[] = [{ name: 'notes.txt', data: NOTES_TXT, method: 0 }];
        assertZipError(
            libs,
            () => libs.project.unpackProject(zipBytes(entries), w.jobDir),
            'the archive must contain a Demoforge screen at its root (missing: index.html, vistaro.config.json)',
            'the missing list is joined ", " exactly as project.js:63 writes it',
        );
        assertOnDisk(w.jobDir, entries);
    } finally {
        fs.rmSync(w.tmp, { recursive: true, force: true });
    }
});
