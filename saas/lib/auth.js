'use strict';
/**
 * Bearer API-key auth. Keys come from the SAAS_API_KEYS env var
 * (comma-separated). Comparison is timing-safe: both sides are hashed with
 * SHA-256 first so timingSafeEqual always gets equal-length buffers.
 */

const crypto = require('node:crypto');

/** @param {string|undefined} raw comma-separated keys */
function parseApiKeys(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

class Auth {
  constructor(keys) {
    this.digests = keys.map((k) => sha256(Buffer.from(k, 'utf8')));
    this.count = keys.length;
  }

  get configured() {
    return this.count > 0;
  }

  /** @returns {boolean} */
  check(headerValue) {
    if (this.count === 0) return false;
    if (typeof headerValue !== 'string') return false;
    const m = /^Bearer\s+(.+)$/.exec(headerValue.trim());
    if (!m) return false;
    const given = sha256(Buffer.from(m[1].trim(), 'utf8'));
    for (const digest of this.digests) {
      if (crypto.timingSafeEqual(given, digest)) return true;
    }
    return false;
  }
}

module.exports = { Auth, parseApiKeys };
