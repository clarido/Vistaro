import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'zlib';

/**
 * Unit tests for saas/lib/zip.js — the zero-dependency ZIP reader that unpacks the
 * project archive a SaaS job submits (project.js hands it the uploaded bytes).
 *
 * The module is a pure Buffer -> { entries } function with zero fs, net and child
 * involvement, so this suite needs no temp dir, no port, no spawn and never touches
 * disk — there is nothing to clean up in test.after. Every fixture is a hand-built
 * archive Buffer assembled by buildZip() below (local headers + central directory +
 * EOCD); every reject is a crafted buffer. The builder is deliberately minimal and
 * is proven once by the happy paths before any reject test trusts it.
 *
 * Byte-layout seams the builder exists to exercise (the reader walks them by hand,
 * zip.js:102-179):
 *   - the data offset comes from the LOCAL header (zip.js:135-142), whose name and
 *     extra lengths may legally differ from the central ones — the stored round-trip
 *     carries entries where each of the two differs, in both directions;
 *   - the sizes and CRC come from the CENTRAL directory (zip.js:108-110), so a
 *     data-descriptor writer (general-purpose bit 3) zeroes them in the local header
 *     and appends a PK\x07\x08 blob after the payload, and must still extract;
 *   - findEOCD scans backwards for the signature only (zip.js:42-49), so a comment
 *     that itself carries an EOCD signature is found FIRST — the last test records
 *     that known spec limitation as behaviour, not as a bug.
 *
 * The caps are exercised through LOWERED opts (zip.js:79 merges opts over
 * DEFAULT_LIMITS), never by allocating a real bomb: each cap test asserts the cap
 * through its own numbers inside the verbatim error text.
 *
 * CRC oracle: crc32() below is a self-contained IEEE table implementation,
 * independent of the code under test; the correct-CRC test cross-checks it against
 * zlib.crc32 when that exists (Node >= 20.15). The mismatch test skips WITH A REASON
 * on runtimes without zlib.crc32, where zip.js deliberately skips verification
 * (zip.js:16-17, :164) — the skip keeps the branch honest rather than vacuous.
 *
 * Module loading follows the landed family (test/saas-queue.test.ts:21-26, :81-89):
 * saas/lib is plain CommonJS with allowJs off, so the import is dynamic with a
 * non-literal specifier (tsc has nothing to resolve, hence no TS7016) plus a local
 * cast, copied verbatim.
 *
 * The builder is file-local for this lot; test/saas-project.test.ts carries the
 * same one. When a lot next owns a shared helper, lift both verbatim into
 * test/zip-bytes.ts — a name without ".test." never
 * enters the runner glob (the test/orphans.ts:4-6 precedent).
 */

// saas/lib is plain CommonJS JavaScript with no type declarations, and tsconfig keeps
// allowJs off: a static import would fail `npx tsc --noEmit` with TS7016. The
// workaround lives in this file only — a dynamic import whose specifier is typed as a
// plain string (so tsc cannot resolve the module, hence no error) plus a local cast.
const zipPath: string = '../saas/lib/zip.js';

// Every key is optional: the lib merges opts over DEFAULT_LIMITS (zip.js:79), and the
// JSDoc contract is "{ maxEntries, maxTotalUncompressedBytes, maxEntryBytes }" — any
// subset (zip.js:68), which is exactly how the cap tests below lower one cap at a time.
type Limits = Partial<{
    maxEntries: number;
    maxTotalUncompressedBytes: number;
    maxEntryBytes: number;
}>;
type SinkEntry = { name: string; type: 'file'; data: Buffer };
type ZipEntry = { name: string; type: 'file' | 'dir'; data?: Buffer };

type ZipModule = {
    extractZip: (
        buf: Buffer,
        opts?: Limits | ((entry: SinkEntry) => void),
        onEntry?: ((entry: SinkEntry) => void) | null,
    ) => { entries: ZipEntry[] };
    looksLikeZip: (buf: unknown) => boolean;
    ZipError: new (message: string) => Error;
    DEFAULT_LIMITS: Limits;
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

let libP: Promise<ZipModule> | null = null;
function zipLib(): Promise<ZipModule> {
    libP ??= loadModule<ZipModule>(zipPath);
    return libP;
}

// zlib.crc32 exists from Node 20.15 (zip.js:16-17). Where it is absent the lib skips
// CRC verification by design, so the mismatch branch cannot fire and the test skips
// with this reason instead of passing vacuously (the POSIX_ONLY shape of
// test/saas-queue.test.ts:100).
const NO_ZLIB_CRC32: string | false = typeof zlib.crc32 === 'function'
    ? false
    : 'this Node lacks zlib.crc32 (added in v20.15): zip.js skips CRC verification there (zip.js:16-17, :164), so the mismatch branch cannot fire';

// ---------------------------------------------------------------------------
// The independent CRC-32 oracle (IEEE, reflected, poly 0xEDB88320) and the builder
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
};
const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
};

type EntrySpec = {
    name: string;              // central-directory name, as the reader should decode it
    nameBytes?: Buffer;        // raw name bytes in BOTH headers (default: utf8 bytes of name)
    locNameBytes?: Buffer;     // LOCAL-only name override (local/central lengths may differ)
    data?: Buffer;             // file payload; omit for a directory entry
    method?: number;           // compression method in both headers (default 0 = stored)
    payload?: Buffer;          // bytes written after the local header (default: data, deflated for method 8)
    utf8?: boolean;            // set the general-purpose UTF-8 flag 0x800
    flags?: number;            // full general-purpose-flags override (wins over utf8)
    crc?: number;              // central CRC (default: crc32(data))
    locCrc?: number;           // local-header CRC override
    locCSize?: number;         // local-header compressed-size override
    locUSize?: number;         // local-header uncompressed-size override
    cenCrc?: number;           // central-header CRC override
    cenCSize?: number;         // central-header compressed-size override
    cenUSize?: number;         // central-header uncompressed-size override
    externalAttrs?: number;    // default 0
    locExtra?: Buffer;         // extra field in the LOCAL header only (default none)
    cenExtra?: Buffer;         // extra field in the CENTRAL header only (default none)
    cenComment?: Buffer;       // central comment (default none)
    descriptor?: boolean;      // append a 16-byte PK\x07\x08 data descriptor after the payload
};

type BuildOpts = {
    disk?: number;             // EOCD disk number (default 0)
    entryCount?: number;       // EOCD entry counts (default entries.length)
    cdOffset?: number;         // EOCD central-directory offset (default computed)
    cdSize?: number;           // EOCD central-directory size (default computed)
    comment?: Buffer;          // EOCD archive comment
};

/** Hand-built archive: [local headers + payloads (+descriptors)] [central directory] [EOCD (+comment)]. */
function buildZip(entries: EntrySpec[], opts: BuildOpts = {}): Buffer {
    const locs: Buffer[] = [];
    const cens: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
        const nameBytes = e.nameBytes ?? Buffer.from(e.name, 'utf8');
        const locName = e.locNameBytes ?? nameBytes;
        const method = e.method ?? 0;
        const payload = e.payload
            ?? (method === 8 ? zlib.deflateRawSync(e.data ?? Buffer.alloc(0)) : (e.data ?? Buffer.alloc(0)));
        const uSize = e.data ? e.data.length : 0;
        const cSize = payload.length;
        const crc = e.crc ?? (e.data ? crc32(e.data) : 0);
        const flags = e.flags ?? (e.utf8 ? 0x800 : 0);
        const locOffset = offset;
        const loc = Buffer.concat([
            u32(0x04034b50), u16(20), u16(flags), u16(method),
            u16(0), u16(0), // mod time/date: the reader never looks at them
            u32(e.locCrc ?? crc), u32(e.locCSize ?? cSize), u32(e.locUSize ?? uSize),
            u16(locName.length), u16(e.locExtra ? e.locExtra.length : 0),
            locName, e.locExtra ?? Buffer.alloc(0), payload,
            ...(e.descriptor ? [u32(0x08074b50), u32(crc), u32(cSize), u32(uSize)] : []),
        ]);
        const cen = Buffer.concat([
            u32(0x02014b50), u16(0x0314), u16(20), u16(flags), u16(method),
            u16(0), u16(0),
            u32(e.cenCrc ?? crc), u32(e.cenCSize ?? cSize), u32(e.cenUSize ?? uSize),
            u16(nameBytes.length), u16(e.cenExtra ? e.cenExtra.length : 0), u16(e.cenComment ? e.cenComment.length : 0),
            u16(0), u16(0), u32(e.externalAttrs ?? 0), u32(locOffset),
            nameBytes, e.cenExtra ?? Buffer.alloc(0), e.cenComment ?? Buffer.alloc(0),
        ]);
        locs.push(loc);
        cens.push(cen);
        offset += loc.length;
    }
    const cdStart = offset;
    const cd = Buffer.concat(cens);
    const count = opts.entryCount ?? entries.length;
    const eocd = Buffer.concat([
        u32(0x06054b50), u16(opts.disk ?? 0), u16(opts.disk ?? 0),
        u16(count), u16(count),
        u32(opts.cdSize ?? cd.length), u32(opts.cdOffset ?? cdStart),
        u16(opts.comment ? opts.comment.length : 0), opts.comment ?? Buffer.alloc(0),
    ]);
    return Buffer.concat([...locs, cd, eocd]);
}

/** Assert the thunk threw the lib's own ZipError carrying `expected` verbatim (identity, not class). */
function assertZipError(
    run: () => unknown,
    ZipErrorCtor: new (message: string) => Error,
    expected: string,
    what: string,
): void {
    let threw: unknown;
    try {
        run();
    } catch (err) {
        threw = err;
    }
    assert.ok(threw !== undefined, `${what}: expected a throw, but extractZip returned normally`);
    assert.ok(threw instanceof Error, `${what}: expected an Error, got ${String(threw)}`);
    assert.ok(
        threw instanceof ZipErrorCtor,
        `${what}: the lib must throw its own ZipError (zip.js:35-40), got name "${(threw as Error).name}" — if the error shape changed deliberately, update this suite's expected shape`,
    );
    assert.equal((threw as Error).message, expected, `${what}: the message must be verbatim`);
}

// ---------------------------------------------------------------------------
// looksLikeZip (zip.js:185-187)
// ---------------------------------------------------------------------------

test('looksLikeZip accepts exactly the local-header magic "PK\\x03\\x04" and refuses short, wrong-magic and non-Buffer inputs', async () => {
    const { looksLikeZip } = await zipLib();
    assert.equal(looksLikeZip(Buffer.from('PK\x03\x04')), true, 'exactly the four magic bytes is true');
    assert.equal(looksLikeZip(Buffer.from('PK\x03\x04and then whatever follows')), true, 'the magic suffices, whatever follows it');
    assert.equal(looksLikeZip(Buffer.from('PK\x03')), false, 'three bytes of the magic are short of it: the length floor is 4');
    assert.equal(looksLikeZip(Buffer.from('PK\x01\x02...')), false, 'a central-directory signature is not the local one');
    assert.equal(looksLikeZip(Buffer.from('PK\x05\x06...')), false, 'an EOCD signature is not the local one');
    assert.equal(looksLikeZip(Buffer.alloc(0)), false, 'an empty buffer is false');
    const nonBuffers: unknown[] = ['PK\x03\x04', null, undefined, 42, new Uint8Array([0x50, 0x4b, 0x03, 0x04]), []];
    for (const bad of nonBuffers) {
        assert.equal(looksLikeZip(bad), false, `a non-Buffer (${bad === null ? 'null' : typeof bad}) is false — even a plain Uint8Array holding the very magic bytes`);
    }
});

// ---------------------------------------------------------------------------
// Stored and deflate round-trips (zip.js:148-155) — these prove the builder
// before any reject test below trusts it
// ---------------------------------------------------------------------------

test('a stored archive round-trips exactly: file bytes, a directory entry without data, and entries whose LOCAL header lengths differ from the central ones', async () => {
    const { extractZip } = await zipLib();
    const hello = Buffer.from('Hello from the stored entry.\n');
    const wide = Buffer.from('this entry carries a LOCAL extra field the central header lacks\n');
    const cenOnly = Buffer.from('this entry carries a CENTRAL extra field the local header lacks\n');
    const renamed = Buffer.from('this entry was written with a shorter LOCAL name than its central name\n');
    const archive = buildZip([
        { name: 'hello.txt', data: hello },
        { name: 'docs/' },
        { name: 'wide.txt', data: wide, locExtra: Buffer.alloc(8) },
        { name: 'cenonly.txt', data: cenOnly, cenExtra: Buffer.alloc(12) },
        { name: 'renamed-longer.txt', data: renamed, locNameBytes: Buffer.from('short.txt') },
    ]);
    const snapshot = Buffer.from(archive);

    const got = extractZip(archive).entries;
    assert.deepEqual(
        got.map((e) => [e.name, e.type]),
        [
            ['hello.txt', 'file'],
            ['docs', 'dir'],
            ['wide.txt', 'file'],
            ['cenonly.txt', 'file'],
            ['renamed-longer.txt', 'file'],
        ],
        'entries follow central-directory order, with the central names sanitised; a dir loses its trailing slash',
    );
    assert.deepEqual(
        got[1],
        { name: 'docs', type: 'dir' },
        'a directory entry is exactly { name, type: "dir" } — no data key at all (zip.js:127-129)',
    );
    assert.deepEqual(got[0].data, hello, 'stored bytes come back verbatim');
    assert.deepEqual(
        got[2].data,
        wide,
        'an 8-byte LOCAL-only extra field must shift the data offset through the LOCAL header read (zip.js:135-142) — using the central extraLen would land 8 bytes early',
    );
    assert.deepEqual(
        got[3].data,
        cenOnly,
        'a 12-byte CENTRAL-only extra field must be skipped when walking the directory (zip.js:117) but never touch the data offset',
    );
    assert.deepEqual(
        got[4].data,
        renamed,
        'a shorter LOCAL name must be measured with the local name length (zip.js:140) — the central one would land 9 bytes late',
    );

    // The stored copy (zip.js:150) exists so a caller mutating returned bytes cannot
    // corrupt anything observable: the archive buffer stays pristine.
    const first = got[0] as SinkEntry;
    first.data[0] ^= 0xff;
    const again = extractZip(archive).entries;
    assert.deepEqual(
        again[0].data,
        hello,
        'after mutating returned data, a re-extract of the SAME archive buffer yields the pristine bytes — the stored path copies (Buffer.from, zip.js:150), it never hands out a subarray view',
    );
    assert.deepEqual(archive, snapshot, 'the archive buffer itself is byte-identical after the mutation');
});

test('a deflate (method 8) entry inflates back to the exact original bytes', async () => {
    const { extractZip } = await zipLib();
    const text = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(8));
    const compressed = zlib.deflateRawSync(text);
    const archive = buildZip([{ name: 'deflated.txt', data: text, method: 8 }]);
    assert.ok(
        archive.includes(compressed),
        'precondition: the fixture really stores the deflateRawSync payload, not the plain text',
    );
    assert.deepEqual(
        extractZip(archive).entries,
        [{ name: 'deflated.txt', type: 'file', data: text }],
        'the inflateRawSync path (zip.js:151-155) must reproduce the exact uncompressed bytes',
    );
});

test('a data-descriptor entry (bit 3): zero sizes and CRC in the local header, a PK\\x07\\x08 blob after the payload — the central directory carries the real values', async () => {
    const { extractZip } = await zipLib();
    const data = Buffer.from('sizes live in the central directory, not in the local header');
    const archive = buildZip([{
        name: 'dd.txt',
        data,
        flags: 0x0008, // general-purpose bit 3: sizes/CRC follow the data in a descriptor
        descriptor: true,
        locCrc: 0,
        locCSize: 0,
        locUSize: 0,
    }]);
    assert.ok(
        archive.includes(u32(0x08074b50)),
        'precondition: the PK\\x07\\x08 descriptor really follows the payload in this fixture',
    );
    assert.deepEqual(
        extractZip(archive).entries,
        [{ name: 'dd.txt', type: 'file', data }],
        'an archive written with a data descriptor must extract: the reader takes sizes from the central directory (zip.js:108-110) and never from the zeroed local header',
    );
});

// ---------------------------------------------------------------------------
// Name decoding (zip.js:119)
// ---------------------------------------------------------------------------

test('name decoding: the UTF-8 flag (0x800) decodes utf8, its absence decodes latin1 — the same non-ASCII name through both branches', async () => {
    const { extractZip } = await zipLib();
    const utf8Bytes = Buffer.from('café.txt', 'utf8');
    const latin1Bytes = Buffer.from('café.txt', 'latin1');
    assert.notDeepEqual(utf8Bytes, latin1Bytes, 'precondition: the two encodings of the name really differ in the file');
    const archive = buildZip([
        { name: 'café.txt', utf8: true, data: Buffer.from('named with utf8 bytes and flagged') },
        { name: 'café.txt', nameBytes: latin1Bytes, data: Buffer.from('named with latin1 bytes, unflagged') },
    ]);
    assert.ok(archive.includes(utf8Bytes), 'precondition: the utf8-encoded name bytes are in the archive');
    assert.ok(archive.includes(latin1Bytes), 'precondition: the latin1-encoded name bytes are in the archive');

    const got = extractZip(archive).entries;
    assert.deepEqual(
        got.map((e) => e.name),
        ['café.txt', 'café.txt'],
        'flag 0x800 must select utf8 and its absence latin1 (zip.js:119): decoding both branches with the same charset would mojibake one of the two names',
    );
    assert.deepEqual(got[0].data, Buffer.from('named with utf8 bytes and flagged'), 'the utf8-flagged entry carries its own bytes');
    assert.deepEqual(got[1].data, Buffer.from('named with latin1 bytes, unflagged'), 'the unflagged entry carries its own bytes');
});

// ---------------------------------------------------------------------------
// sanitizeName cleanup (zip.js:57-63, :122)
// ---------------------------------------------------------------------------

test('sanitizeName cleanup: "./x" and "a//b" collapse, and a dir entry whose name sanitizes to "" is skipped entirely', async () => {
    const { extractZip } = await zipLib();
    const cleanup = buildZip([
        { name: './keep.txt', data: Buffer.from('kept') },
        { name: 'a//b.txt', data: Buffer.from('joined') },
    ]);
    assert.deepEqual(
        extractZip(cleanup).entries.map((e) => e.name),
        ['keep.txt', 'a/b.txt'],
        'empty and dot segments are dropped during sanitisation (zip.js:57-63)',
    );

    const bare = buildZip([{ name: './' }]); // sanitises to '' — nothing to keep
    assert.deepEqual(
        extractZip(bare).entries,
        [],
        'an entry whose name sanitises to the empty string is skipped from entries (zip.js:122), not emitted as an empty name',
    );
});

// ---------------------------------------------------------------------------
// sanitizeName rejects (zip.js:51-64) — each verbatim
// ---------------------------------------------------------------------------

test('a NUL byte in an entry name is refused verbatim', async () => {
    const { extractZip, ZipError } = await zipLib();
    const archive = buildZip([{ name: 'bad\u0000name.txt', data: Buffer.from('x') }]);
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'NUL byte in entry name',
        'the NUL check (zip.js:52) runs before anything else about the name',
    );
});

test('drive-letter and absolute entry names are refused with the verbatim "unsafe (absolute) entry name" message', async () => {
    const { extractZip, ZipError } = await zipLib();
    const drive = buildZip([{ name: 'C:evil.txt', data: Buffer.from('x') }]);
    assertZipError(
        () => extractZip(drive),
        ZipError,
        'unsafe (absolute) entry name: "C:evil.txt"',
        'a drive letter matches /^[a-zA-Z]:/ after backslash normalisation (zip.js:54-55); the raw name is JSON.stringify-ed into the message',
    );
    const absolute = buildZip([{ name: '/etc/passwd', data: Buffer.from('x') }]);
    assertZipError(
        () => extractZip(absolute),
        ZipError,
        'unsafe (absolute) entry name: "/etc/passwd"',
        'a leading slash is refused the same way (zip.js:54-55)',
    );
});

test('path traversal is refused, forwards and in its backslashed form after normalisation', async () => {
    const { extractZip, ZipError } = await zipLib();
    const forward = buildZip([{ name: 'a/../../b', data: Buffer.from('x') }]);
    assertZipError(
        () => extractZip(forward),
        ZipError,
        'path traversal in entry: "a/../../b"',
        'a ".." segment anywhere is refused (zip.js:60), not just a leading one',
    );
    // Backslashes are normalised to slashes first (zip.js:53), so the Windows form
    // cannot slip past. JSON.stringify escapes each backslash, so the verbatim
    // message carries them doubled.
    const backslashed = buildZip([{ name: 'a\\..\\..\\b', data: Buffer.from('x') }]);
    assertZipError(
        () => extractZip(backslashed),
        ZipError,
        'path traversal in entry: "a\\\\..\\\\..\\\\b"',
        'the backslashed traversal must hit the same refusal as its normalised form (zip.js:53 then :60)',
    );
});

// ---------------------------------------------------------------------------
// Structural rejects — each verbatim
// ---------------------------------------------------------------------------

test('non-Buffer input is refused: "input is not a Buffer"', async () => {
    const { extractZip, ZipError } = await zipLib();
    const bads: unknown[] = ['PK\x03\x04', null, undefined, 42, new Uint8Array(22), [0x50, 0x4b, 0x03, 0x04], { 0: 0x50, length: 4 }];
    for (const bad of bads) {
        assertZipError(
            () => extractZip(bad as unknown as Buffer),
            ZipError,
            'input is not a Buffer',
            `a ${bad === null ? 'null' : typeof bad} input is refused (Buffer.isBuffer, zip.js:80) — a plain Uint8Array with the right shape is refused too, the reader demands a real Buffer`,
        );
    }
});

test('fewer than 22 bytes is refused; an exactly-22-byte empty archive parses to no entries', async () => {
    const { extractZip, ZipError } = await zipLib();
    assertZipError(
        () => extractZip(Buffer.alloc(21)),
        ZipError,
        'not a ZIP file (smaller than an empty archive)',
        'one byte under the EOCD floor is refused (zip.js:81)',
    );
    const empty = buildZip([]);
    assert.equal(empty.length, 22, 'precondition: an empty archive is exactly one EOCD record, 22 bytes');
    assert.deepEqual(extractZip(empty).entries, [], 'the 22-byte lower bound itself parses: an empty archive has no entries');
});

test('a buffer without an end-of-central-directory record is refused', async () => {
    const { extractZip, ZipError } = await zipLib();
    assertZipError(
        () => extractZip(Buffer.alloc(100, 0x41)),
        ZipError,
        'not a ZIP file (no end-of-central-directory record)',
        'the backward scan for PK\\x05\\x06 (zip.js:42-49) finding nothing is refused (zip.js:84)',
    );
});

test('a multi-disk archive is refused', async () => {
    const { extractZip, ZipError } = await zipLib();
    const archive = buildZip([], { disk: 1 });
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'multi-disk archives are not supported',
        'a non-zero EOCD disk number is refused (zip.js:86-88), before any directory walk',
    );
});

test('the zip64 sentinels (entryCount 0xffff, cdOffset 0xffffffff) are refused', async () => {
    const { extractZip, ZipError } = await zipLib();
    const byCount = buildZip([], { entryCount: 0xffff });
    assertZipError(
        () => extractZip(byCount),
        ZipError,
        'zip64 archives are not supported',
        'an entry count of 0xffff is the zip64 sentinel (zip.js:91-93) — and the check precedes the maxEntries cap',
    );
    const byOffset = buildZip([], { cdOffset: 0xffffffff });
    assertZipError(
        () => extractZip(byOffset),
        ZipError,
        'zip64 archives are not supported',
        'a central-directory offset of 0xffffffff is the other zip64 sentinel (zip.js:91-93)',
    );
});

test('a corrupt central directory is refused: a broken signature, and a count that lies', async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.from('central directory corruption target');
    const built = buildZip([{ name: 'hello.txt', data }]);
    const cenSig = Buffer.from('PK\x01\x02', 'latin1');
    const at = built.indexOf(cenSig);
    assert.ok(at > 0, 'precondition: the fixture carries exactly one central-directory signature to corrupt');
    const flipped = Buffer.from(built);
    flipped.writeUInt32LE(0x04034b50, at); // a local-header signature where a central one belongs
    assertZipError(
        () => extractZip(flipped),
        ZipError,
        'corrupt central directory',
        'a directory slot whose signature is wrong is refused before any entry is read (zip.js:103-105)',
    );

    const lying = buildZip([{ name: 'hello.txt', data }], { entryCount: 2 });
    assertZipError(
        () => extractZip(lying),
        ZipError,
        'corrupt central directory',
        'a count naming more entries than the directory holds walks off its end (i + 46 past the buffer) into the same refusal (zip.js:103-105)',
    );
});

test('a corrupt or lying local header is refused: "corrupt local header for …" and "truncated entry: …"', async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.from('local header corruption target');
    const built = buildZip([{ name: 'hello.txt', data }]);
    const locSig = Buffer.from('PK\x03\x04', 'latin1');
    const at = built.indexOf(locSig);
    assert.equal(at, 0, 'precondition: the local header opens the archive');
    const flipped = Buffer.from(built);
    flipped.writeUInt32LE(0x06054b50, at); // an EOCD signature where a local one belongs
    assertZipError(
        () => extractZip(flipped),
        ZipError,
        'corrupt local header for hello.txt',
        'a local header whose signature is wrong is refused, naming the central-directory name (zip.js:137-139)',
    );

    const truncated = buildZip([{ name: 'hello.txt', data, cenCSize: data.length + 100 }]);
    assertZipError(
        () => extractZip(truncated),
        ZipError,
        'truncated entry: hello.txt',
        'a central compressed size reaching past the end of the buffer is refused before any inflate (zip.js:143-145)',
    );
});

test('an unsupported compression method is refused naming the method', async () => {
    const { extractZip, ZipError } = await zipLib();
    const archive = buildZip([{ name: 'hello.txt', data: Buffer.from('abcde'), method: 12 }]);
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'unsupported compression method 12 for hello.txt',
        'only stored (0) and deflate (8) are supported; the message names the method it saw (zip.js:157-159)',
    );
});

test('a central uncompressed size that disagrees with the data is refused naming expected and got', async () => {
    const { extractZip, ZipError } = await zipLib();
    const archive = buildZip([{ name: 'hello.txt', data: Buffer.from('hello'), cenUSize: 6 }]);
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'size mismatch for hello.txt (expected 6, got 5)',
        'the central uSize is the contract; a one-byte lie must be caught with both numbers verbatim (zip.js:161-163)',
    );
});

// ---------------------------------------------------------------------------
// Symlinks (zip.js:124-126)
// ---------------------------------------------------------------------------

test('a symlink entry (S_IFLNK in the external-attrs high bits) is refused; the same attrs as a regular file extract fine', async () => {
    const { extractZip, ZipError } = await zipLib();
    const target = Buffer.from('/etc/passwd');
    const S_IFLNK = 0o120000;
    const symlink = buildZip([{ name: 'link', data: target, externalAttrs: (0o120777 << 16) >>> 0 }]);
    assertZipError(
        () => extractZip(symlink),
        ZipError,
        'symlink entries are not allowed: "link"',
        'the Unix mode sits in the high 16 bits of the external attrs; S_IFLNK << 16 must be refused verbatim (zip.js:124-126)',
    );
    const regular = buildZip([{ name: 'link', data: target, externalAttrs: (0o100644 << 16) >>> 0 }]);
    assert.deepEqual(
        extractZip(regular).entries,
        [{ name: 'link', type: 'file', data: target }],
        'a regular-file mode (S_IFREG) in the same field must NOT trip the symlink check — the check keys on the file-type bits, not on any external attrs',
    );
});

// ---------------------------------------------------------------------------
// Caps, every one through LOWERED opts so no real bomb is ever allocated
// ---------------------------------------------------------------------------

test('an entry count above opts.maxEntries is refused naming both numbers', async () => {
    const { extractZip, ZipError } = await zipLib();
    const archive = buildZip([], { entryCount: 5 });
    assertZipError(
        () => extractZip(archive, { maxEntries: 4 }),
        ZipError,
        'archive has too many entries (5 > 4)',
        'the cap is asserted through its own numbers (zip.js:94-96); no central directory is needed — the refusal fires before the walk',
    );
});

test('a compressed size above opts.maxEntryBytes is refused naming the entry and the size', async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.from('0123456789'); // 10 real bytes on disk
    const archive = buildZip([{ name: 'big.bin', data }]);
    assertZipError(
        () => extractZip(archive, { maxEntryBytes: 5 }),
        ZipError,
        'entry too large: big.bin (10 bytes)',
        'the per-entry cap reads the CENTRAL cSize (zip.js:131-133) and refuses before the local header is even opened',
    );
});

test('a highly compressible payload inflated past opts.maxEntryBytes is refused by the inflate cap', async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.alloc(100000); // zeros: compresses to a few hundred bytes
    const payload = zlib.deflateRawSync(data);
    assert.ok(
        payload.length + 1 < data.length,
        'precondition: the lowered cap sits between the compressed and uncompressed size, so the inflate cap fires and not the cSize check',
    );
    const archive = buildZip([{ name: 'zeros.bin', data, method: 8 }]);
    assertZipError(
        () => extractZip(archive, { maxEntryBytes: payload.length + 1 }),
        ZipError,
        'deflate failed (or output exceeded the cap) for zeros.bin',
        'the compressed size passes the cSize check (zip.js:131) and maxOutputLength (zip.js:153) catches the expansion — both outcomes surface as this one verbatim message (zip.js:155)',
    );
});

test('two small entries summing past opts.maxTotalUncompressedBytes are refused naming the cap', async () => {
    const { extractZip, ZipError } = await zipLib();
    const ten = Buffer.from('0123456789');
    const archive = buildZip([
        { name: 'a.txt', data: ten },
        { name: 'b.txt', data: ten },
    ]);
    assertZipError(
        () => extractZip(archive, { maxTotalUncompressedBytes: 15 }),
        ZipError,
        'archive expands beyond 15 bytes (zip bomb?)',
        'the first entry (10 bytes) fits, the second pushes the running total to 20 — the message names the cap itself (zip.js:170-172), not the entry',
    );
});

// ---------------------------------------------------------------------------
// Sink vs buffered API (zip.js:76-79, :174-178)
// ---------------------------------------------------------------------------

const TWO_FILES = {
    a: Buffer.from('first file'),
    b: Buffer.from('second file'),
    build() {
        return buildZip([
            { name: 'a.txt', data: this.a },
            { name: 'b.txt', data: this.b },
        ]);
    },
    expected() {
        return [
            { name: 'a.txt', type: 'file' as const, data: this.a },
            { name: 'b.txt', type: 'file' as const, data: this.b },
        ];
    },
};

test('sink as the opts argument: every file reaches the sink, the returned entries stay empty', async () => {
    const { extractZip } = await zipLib();
    const seen: SinkEntry[] = [];
    const sunk = extractZip(TWO_FILES.build(), (e) => {
        seen.push(e);
    });
    assert.deepEqual(
        sunk.entries,
        [],
        'with a sink nothing is buffered into the returned entries — that is the streaming contract (zip.js:70-73)',
    );
    assert.deepEqual(
        seen,
        TWO_FILES.expected(),
        'every file entry reached the sink, in central-directory order, with its real bytes (zip.js:174-175)',
    );
});

test('limits object plus third-arg onEntry works, with the lib defaults filling what the opts omit', async () => {
    const { extractZip, DEFAULT_LIMITS } = await zipLib();
    const seen: SinkEntry[] = [];
    const sunk = extractZip(
        TWO_FILES.build(),
        { maxTotalUncompressedBytes: DEFAULT_LIMITS.maxTotalUncompressedBytes },
        (e) => {
            seen.push(e);
        },
    );
    assert.deepEqual(seen, TWO_FILES.expected(), 'the third-arg onEntry sink receives every file entry with its real bytes');
    assert.deepEqual(sunk.entries, [], 'and nothing is buffered into the returned entries');
    assert.deepEqual(DEFAULT_LIMITS, { maxEntries: 20000, maxTotalUncompressedBytes: 128 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024 },
        'the exported defaults are the documented caps — a lowered-opts test elsewhere in this file relies on the merge (zip.js:79)');
});

test('without a sink everything is buffered into entries in central-directory order', async () => {
    const { extractZip } = await zipLib();
    assert.deepEqual(
        extractZip(TWO_FILES.build()).entries,
        TWO_FILES.expected(),
        'the no-sink shape is the buffered one: same entries, same order, data attached (zip.js:177)',
    );
});

// ---------------------------------------------------------------------------
// CRC-32 (zip.js:164-168), version-gated on zlib.crc32
// ---------------------------------------------------------------------------

test('a correct CRC-32 passes the integrity check (and cross-checks the independent oracle against zlib.crc32)', async () => {
    const { extractZip } = await zipLib();
    const data = Buffer.from('crc-checked payload\n');
    const archive = buildZip([{ name: 'hello.txt', data }]); // the builder stamps crc32(data)
    assert.deepEqual(
        extractZip(archive).entries,
        [{ name: 'hello.txt', type: 'file', data }],
        'an entry carrying its true CRC must extract',
    );
    if (typeof zlib.crc32 === 'function') {
        assert.equal(
            crc32(data),
            zlib.crc32(data),
            'the test oracle agrees with zlib.crc32 — the very check the lib just ran on this entry, so the fixture CRCs are real',
        );
    }
});

test('a wrong CRC-32 is refused verbatim', { skip: NO_ZLIB_CRC32 }, async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.from('payload whose integrity is lied about\n');
    const trueCrc = crc32(data);
    const wrong = (trueCrc ^ 0xa5a5a5a5) >>> 0;
    assert.ok(wrong !== 0 && wrong !== trueCrc, 'precondition: the crafted CRC differs from the true one and is not the 0 that disables the check');
    const archive = buildZip([{ name: 'hello.txt', data, crc: wrong }]);
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'crc32 mismatch for hello.txt',
        'a tampered payload must be caught with the entry name verbatim (zip.js:166) — on a Node without zlib.crc32 this test is skipped, not vacuous',
    );
});

test('a central CRC of 0 skips verification entirely (the crcExpected !== 0 guard)', async () => {
    const { extractZip } = await zipLib();
    const data = Buffer.from('payload whose CRC field was never filled in\n');
    assert.ok(crc32(data) !== 0, 'precondition: the data has a nonzero true CRC, so only the guard could let this pass');
    const archive = buildZip([{ name: 'hello.txt', data, crc: 0 }]);
    assert.deepEqual(
        extractZip(archive).entries,
        [{ name: 'hello.txt', type: 'file', data }],
        'a central CRC of 0 disables the check on every Node version (zip.js:164) — runs even where zlib.crc32 is absent',
    );
});

// ---------------------------------------------------------------------------
// KNOWN SPEC LIMITATION: findEOCD matches the signature only (zip.js:42-49)
// ---------------------------------------------------------------------------

test('KNOWN SPEC LIMITATION: EOCD-signature bytes inside the archive comment are found first and read as the EOCD', async () => {
    const { extractZip, ZipError } = await zipLib();
    const data = Buffer.from('harmless content');
    // A well-formed-by-spec comment whose first 22 bytes are themselves a plausible
    // EOCD (disk 0, one entry, directory at offset 0). The real EOCD declares this
    // 22-byte comment, so BOTH records are self-consistent; the ambiguity is real.
    const fakeEocd = Buffer.concat([
        u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(0), u32(0), u16(0),
    ]);
    const archive = buildZip([{ name: 'hello.txt', data }], { comment: fakeEocd });
    assert.ok(
        archive.subarray(archive.length - 22).equals(fakeEocd),
        'precondition: the fake EOCD is the last 22 bytes, so the backward scan meets it first',
    );
    assertZipError(
        () => extractZip(archive),
        ZipError,
        'corrupt central directory',
        'KNOWN SPEC LIMITATION, recorded as behaviour: findEOCD (zip.js:42-49) matches the signature only, so a comment carrying PK\\x05\\x06 is read as the EOCD (cdOffset 0) and the real directory is never reached — stricter readers validate pos + 22 + commentLen against the buffer length; if this archive ever starts extracting, this test documents the change',
    );
});
