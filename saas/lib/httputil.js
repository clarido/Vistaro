'use strict';
/** Small HTTP helpers: JSON responses, capped body reading, file serving with Range. */

const fs = require('node:fs');

const CONTENT_TYPES = {
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

function contentTypeFor(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] || 'application/octet-stream';
}

function json(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  if (res.req && res.req.method === 'HEAD') res.end();
  else res.end(body);
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Read the whole request body, refusing anything above maxBytes.
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, `request body too large (${declared} bytes > ${maxBytes})`));
      req.resume();
      return;
    }
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        reject(new HttpError(413, `request body too large (> ${maxBytes} bytes)`));
        // Drain (discard) the rest instead of destroying the socket: a destroy races the
        // 413 the handler is about to write and the client sees ECONNRESET, not the status.
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!done) reject(e); });
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'request body must be a JSON object');
    }
    return parsed;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/**
 * Serve one file from disk with correct Content-Type and single-range support
 * (so <video> elements can seek). Caller has already validated the path.
 * @returns {Promise<boolean>} false when the file does not exist
 */
function serveFile(req, res, filePath, { cacheControl = 'public, max-age=300' } = {}) {
  return new Promise((resolve) => {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      resolve(false);
      return;
    }
    if (!st.isFile()) { resolve(false); return; }

    const type = contentTypeFor(filePath);
    const range = req.headers.range;
    const baseHeaders = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    };

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      const size = st.size;
      if (!m || (m[1] === '' && m[2] === '') || (m[1] === '' && size === 0)) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        resolve(true);
        return;
      }
      let start;
      let end;
      if (m[1] === '') {
        // suffix range: last N bytes
        const n = Number(m[2]);
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        res.end();
        resolve(true);
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      stream.on('close', () => resolve(true));
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'content-length': st.size });
    if (req.method === 'HEAD') { res.end(); resolve(true); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    stream.on('close', () => resolve(true));
  });
}

module.exports = { json, readBody, readJsonBody, serveFile, contentTypeFor, HttpError };
