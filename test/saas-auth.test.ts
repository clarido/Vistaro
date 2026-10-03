import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for saas/lib/auth.js (Bearer API-key auth).
 *
 * saas/lib/auth.js is plain CommonJS JavaScript. It is required here and cast
 * to a local type, which keeps the plain-.js import working under
 * `tsc --noEmit` (module CommonJS) with the workaround contained in this file
 * -- no tsconfig change and no dependency on any .d.ts sidecar.
 */
type AuthInstance = {
    readonly configured: boolean;
    check: (headerValue: unknown) => boolean;
};
type AuthModule = {
    Auth: new (keys: string[]) => AuthInstance;
    parseApiKeys: (raw: string | undefined) => string[];
};
const { Auth, parseApiKeys } = require('../saas/lib/auth.js') as AuthModule;

test('auth.js exports the Auth class and parseApiKeys', () => {
    assert.equal(typeof parseApiKeys, 'function', 'auth.js exports parseApiKeys as a function');
    assert.equal(typeof Auth, 'function', 'auth.js exports Auth as a class');
});

test('parseApiKeys(undefined) and parseApiKeys("") return []', () => {
    assert.deepEqual(parseApiKeys(undefined), [], 'an absent SAAS_API_KEYS configures no keys (auth.js:12)');
    assert.deepEqual(parseApiKeys(''), [], 'an empty SAAS_API_KEYS configures no keys (auth.js:12)');
});

test('parseApiKeys splits on commas, trims each entry and drops the empties', () => {
    assert.deepEqual(parseApiKeys('a, b , ,c'), ['a', 'b', 'c'], 'split on comma, trim, drop empties (auth.js:13-16)');
    assert.deepEqual(parseApiKeys('  key-alpha  '), ['key-alpha'], 'a single key is trimmed, not split');
    assert.deepEqual(parseApiKeys(' , , '), [], 'a string of only commas and spaces configures no keys');
});

test('new Auth([]) is unconfigured (configured === false) and authenticates nobody', () => {
    const auth = new Auth([]);
    assert.equal(auth.configured, false, 'zero keys means configured is exactly false, not merely falsy (auth.js:29-31)');
    const inputs: unknown[] = ['Bearer key-alpha', 'key-alpha', '', 'Bearer', undefined, null, 0];
    for (const input of inputs) {
        assert.equal(auth.check(input), false, `an unconfigured server refuses ${JSON.stringify(input) ?? String(input)} (auth.js:35)`);
    }
});

test('check() returns false for non-string input even on a configured auth', () => {
    const auth = new Auth(['key-alpha']);
    const nonStrings: unknown[] = [42, null, undefined, { Bearer: 'key-alpha' }, true];
    for (const bad of nonStrings) {
        assert.equal(auth.check(bad), false, `non-string input of type ${typeof bad} must be refused, not coerced (auth.js:36)`);
    }
});

test('check("Bearer <key>") accepts the configured key, tolerating outer and extra inner whitespace', () => {
    const auth = new Auth(['key-alpha']);
    assert.equal(auth.check('Bearer key-alpha'), true, 'the exact documented form authenticates');
    assert.equal(auth.check('  Bearer key-alpha  '), true, 'surrounding whitespace is trimmed before the Bearer match (auth.js:37)');
    assert.equal(auth.check('Bearer   key-alpha'), true, 'the regex allows \\s+ between Bearer and the key');
    assert.equal(auth.check('Bearer\tkey-alpha'), true, 'a tab counts as whitespace after Bearer');
});

test('check() refuses a wrong key, a bare key and a lowercase bearer scheme', () => {
    const auth = new Auth(['key-alpha']);
    assert.equal(auth.check('Bearer key-beta'), false, 'a configured auth refuses a key it does not hold');
    assert.equal(auth.check('key-alpha'), false, 'the Bearer scheme is required');
    assert.equal(auth.check('bearer key-alpha'), false, 'the /^Bearer\\s+/ match is case-sensitive (auth.js:37)');
    assert.equal(auth.check('Bearer'), false, 'the word Bearer with no key does not match');
    assert.equal(auth.check(''), false, 'an empty header authenticates nobody');
});

test('keys of different lengths compare without throwing: both sides are sha256-hashed before timingSafeEqual', () => {
    const longKey = 'k'.repeat(200);
    const auth = new Auth(['k', longKey, 'a-medium-length-key-0123456789']);
    assert.equal(auth.check(`Bearer ${longKey}`), true, 'the long configured key authenticates');
    assert.equal(auth.check('Bearer short'), false, 'a wrong key of yet another length is refused, not a RangeError (auth.js:19-21, 39-41)');
    assert.equal(auth.check(`Bearer ${'k'.repeat(199)}`), false, 'a wrong key differing only in length is refused');
});
