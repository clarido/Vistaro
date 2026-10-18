'use strict';
/**
 * The Cloud's durable state: one JSON document on disk, held in memory and
 * rewritten atomically (write a temp file, then rename) after every mutation.
 *
 * This is deliberately the simplest thing that survives a restart. It is
 * single-process: two servers on one data dir would overwrite each other.
 * The swap to Postgres is a production step (saas/README.md), and every
 * access goes through the methods below so that swap stays local.
 *
 * Analytics events are NOT kept here (they are append-only and large); see
 * analytics.js.
 */

const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = [
  'users', 'sessions', 'workspaces', 'members', 'invites', 'tokens',
  'projects', 'releases', 'comments', 'leads', 'strings', 'audit',
];

function emptyDoc() {
  const doc = { version: 1 };
  for (const c of COLLECTIONS) doc[c] = {};
  return doc;
}

class Store {
  /** @param {string} file absolute path of the JSON document */
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.doc = emptyDoc();
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const c of COLLECTIONS) this.doc[c] = parsed[c] && typeof parsed[c] === 'object' ? parsed[c] : {};
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.doc));
    fs.renameSync(tmp, this.file);
  }

  get(coll, key) {
    return Object.prototype.hasOwnProperty.call(this.doc[coll], key) ? this.doc[coll][key] : null;
  }

  put(coll, key, value) {
    this.doc[coll][key] = value;
    this.save();
    return value;
  }

  /** Shallow-merge `patch` into an existing record; null when absent. */
  update(coll, key, patch) {
    const cur = this.get(coll, key);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.doc[coll][key] = next;
    this.save();
    return next;
  }

  remove(coll, key) {
    if (!Object.prototype.hasOwnProperty.call(this.doc[coll], key)) return false;
    delete this.doc[coll][key];
    this.save();
    return true;
  }

  /** Every record of a collection matching `pred` (insertion order). */
  find(coll, pred = () => true) {
    return Object.values(this.doc[coll]).filter(pred);
  }

  findOne(coll, pred) {
    for (const v of Object.values(this.doc[coll])) if (pred(v)) return v;
    return null;
  }

  /** Remove every record matching `pred`; returns how many went. */
  removeWhere(coll, pred) {
    let n = 0;
    for (const [k, v] of Object.entries(this.doc[coll])) {
      if (pred(v)) { delete this.doc[coll][k]; n += 1; }
    }
    if (n) this.save();
    return n;
  }
}

module.exports = { Store, COLLECTIONS };
