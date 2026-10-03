'use strict';
/**
 * Minimal ZIP reader for the Demoforge SaaS MVP — zero runtime dependencies.
 *
 * Node has no built-in unzip, so this parses the archive by hand:
 * scan for the End Of Central Directory record, walk the central directory,
 * then inflate each entry with node:zlib.
 *
 * Supported:  stored (method 0) and deflate (method 8), UTF-8 entry names,
 *             entries written with a data descriptor (bit 3) — sizes are read
 *             from the central directory, which always has the real values.
 * Rejected:   zip64, multi-disk archives, symlinks, path traversal ("..",
 *             absolute paths, drive letters), entry-count and uncompressed-size
 *             bombs (see DEFAULT_LIMITS).
 *
 * Integrity:  CRC-32 is verified when zlib.crc32 is available (Node >= 20.15);
 *             on older 20.x runtimes the check is skipped rather than failing.
 */

const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

const DEFAULT_LIMITS = {
  maxEntries: 20000,
  // A demo project is HTML, JSON and some media: tens of MB. The caps exist so a crafted
  // archive cannot OOM the machine that is also running headless-Chromium exports; the
  // whole uncompressed payload is never held in RAM at once (see `onEntry` below).
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
};

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

function findEOCD(buf) {
  // EOCD is at least 22 bytes and the comment may be up to 65535.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function sanitizeName(raw) {
  if (raw.includes('\0')) throw new ZipError('NUL byte in entry name');
  const name = raw.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('/')) {
    throw new ZipError(`unsafe (absolute) entry name: ${JSON.stringify(raw)}`);
  }
  const parts = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new ZipError(`path traversal in entry: ${JSON.stringify(raw)}`);
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * @param {Buffer} buf whole archive
 * @param {object} [opts] { maxEntries, maxTotalUncompressedBytes, maxEntryBytes }
 * @param {(entry: {name: string, type: 'file', data: Buffer}) => void} [onEntry]
 *   Sink for streamed extraction: when given, each file is handed over as soon as it is
 *   inflated and its data is NOT retained here, so peak memory is one entry, not the
 *   whole archive. Without a sink everything is buffered into `entries` (tests, small
 *   archives).
 * @returns {{ entries: Array<{name: string, type: 'file'|'dir', data?: Buffer}> }}
 */
function extractZip(buf, opts = {}, onEntry = null) {
  const optsAreSink = typeof opts === 'function';
  const sink = optsAreSink ? opts : onEntry;
  const limits = { ...DEFAULT_LIMITS, ...(optsAreSink ? {} : opts) };
  if (!Buffer.isBuffer(buf)) throw new ZipError('input is not a Buffer');
  if (buf.length < 22) throw new ZipError('not a ZIP file (smaller than an empty archive)');

  const eocd = findEOCD(buf);
  if (eocd < 0) throw new ZipError('not a ZIP file (no end-of-central-directory record)');

  if (buf.readUInt16LE(eocd + 4) !== 0) {
    throw new ZipError('multi-disk archives are not supported');
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64 archives are not supported');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipError(`archive has too many entries (${entryCount} > ${limits.maxEntries})`);
  }

  const entries = [];
  let totalUncompressed = 0;
  let i = cdOffset;

  for (let n = 0; n < entryCount; n++) {
    if (i + 46 > buf.length || buf.readUInt32LE(i) !== CEN_SIG) {
      throw new ZipError('corrupt central directory');
    }
    const flags = buf.readUInt16LE(i + 8);
    const method = buf.readUInt16LE(i + 10);
    const crcExpected = buf.readUInt32LE(i + 16);
    const cSize = buf.readUInt32LE(i + 20);
    const uSize = buf.readUInt32LE(i + 24);
    const nameLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const commentLen = buf.readUInt16LE(i + 32);
    const externalAttrs = buf.readUInt32LE(i + 38);
    const locOffset = buf.readUInt32LE(i + 42);
    const rawName = buf.subarray(i + 46, i + 46 + nameLen);
    i += 46 + nameLen + extraLen + commentLen;

    const nameBuf = (flags & 0x800) !== 0 ? rawName.toString('utf8') : rawName.toString('latin1');
    const isDir = nameBuf.endsWith('/');
    const name = sanitizeName(nameBuf);
    if (name === '') continue; // e.g. a bare "dir/" entry sanitised to nothing

    if ((externalAttrs >>> 16 & 0o170000) === 0o120000) {
      throw new ZipError(`symlink entries are not allowed: ${JSON.stringify(nameBuf)}`);
    }
    if (isDir) {
      entries.push({ name, type: 'dir' });
      continue;
    }
    if (cSize > limits.maxEntryBytes) {
      throw new ZipError(`entry too large: ${name} (${cSize} bytes)`);
    }

    // Local header: its name/extra lengths may differ from the central ones,
    // so the data offset must come from here, not from the central record.
    if (locOffset + 30 > buf.length || buf.readUInt32LE(locOffset) !== LOC_SIG) {
      throw new ZipError(`corrupt local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(locOffset + 26);
    const lExtraLen = buf.readUInt16LE(locOffset + 28);
    const dataStart = locOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + cSize > buf.length) {
      throw new ZipError(`truncated entry: ${name}`);
    }
    const raw = buf.subarray(dataStart, dataStart + cSize);

    let data;
    if (method === 0) {
      data = Buffer.from(raw); // copy: subarray would pin the whole archive in memory
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
      } catch {
        throw new ZipError(`deflate failed (or output exceeded the cap) for ${name}`);
      }
    } else {
      throw new ZipError(`unsupported compression method ${method} for ${name}`);
    }

    if (uSize !== 0xffffffff && data.length !== uSize) {
      throw new ZipError(`size mismatch for ${name} (expected ${uSize}, got ${data.length})`);
    }
    if (typeof zlib.crc32 === 'function' && crcExpected !== 0) {
      if (zlib.crc32(data) !== crcExpected) {
        throw new ZipError(`crc32 mismatch for ${name}`);
      }
    }

    totalUncompressed += data.length;
    if (totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new ZipError(`archive expands beyond ${limits.maxTotalUncompressedBytes} bytes (zip bomb?)`);
    }
    if (sink) {
      sink({ name, type: 'file', data });
    } else {
      entries.push({ name, type: 'file', data });
    }
  }

  return { entries };
}

/** True when the buffer starts with the local-file-header magic "PK\x03\x04". */
function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

module.exports = { extractZip, looksLikeZip, ZipError, DEFAULT_LIMITS };
