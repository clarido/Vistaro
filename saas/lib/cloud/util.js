'use strict';
/**
 * Small primitives shared by the Vistaro Cloud modules: ids, secrets, password
 * hashing, cookies, slugs. Zero dependencies (node:crypto only).
 */

const crypto = require('node:crypto');

/** A prefixed random id, e.g. id('ws') -> ws_3f9c0a1b2c4d5e6f. */
function id(prefix, bytes = 8) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

/** A long random secret, url-safe. */
function secret(prefix = '', bytes = 24) {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Constant-time equality for two strings of any length. */
function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

// scrypt parameters: N=2^14 keeps a login under ~50 ms on a small VM.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'base64url');
  const want = Buffer.from(parts[3], 'base64url');
  const got = crypto.scryptSync(String(password), salt, want.length, { N, r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(got, want);
}

/** HMAC-SHA256, hex. */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** Parse a Cookie header into a plain object. Malformed pairs are skipped. */
function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { /* skip malformed */ }
  }
  return out;
}

function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, secure = false, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge != null) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Lower-case, dash-separated, 1-48 chars; '' when nothing usable is left. */
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

function normalizeEmail(s) {
  const e = String(s || '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

/** HTML-escape for the few server-rendered pages. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON safe to inline inside a <script> element. */
function inlineJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\u2029', 'g'), '\\u2029');
}

module.exports = {
  id, secret, sha256hex, safeEqual, hashPassword, verifyPassword, hmac,
  parseCookies, serializeCookie, slugify, SLUG_RE, normalizeEmail, esc, inlineJson,
};
