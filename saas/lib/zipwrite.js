'use strict';
/**
 * Minimal ZIP writer (the counterpart of zip.js), zero dependencies: stored
 * entries for already-compressed media, deflate for everything else. Used by
 * the publish client to bundle a CLI output directory. No zip64: the Cloud's
 * reader refuses it anyway, so a bundle past 4 GB fails here, loudly.
 */

const zlib = require('node:zlib');

const STORED_EXT = /\.(mp4|webm|png|jpe?g|gif|webp|mp3|aiff|zip|woff2?)$/i;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer}>} entries posix names, no leading slash
 * @returns {Buffer}
 */
function writeZip(entries) {
  if (entries.length > 0xfffe) throw new Error('too many files for a zip without zip64');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe zip entry name: ${name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const deflate = !STORED_EXT.test(name) && data.length > 64;
    const payload = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
    if (offset > 0xfffffffe) throw new Error('bundle is larger than 4 GB; zip64 is not supported');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

module.exports = { writeZip, crc32 };
