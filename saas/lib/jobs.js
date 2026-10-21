'use strict';
/**
 * Job store: one directory per build under <dataDir>/jobs/<id>/.
 *
 *   <id>/job.json     bookkeeping (status, artifacts, log tail)
 *   <id>/upload.zip   the uploaded project, kept for re-runs/debugging
 *   <id>/project/     the unzipped screen (index.html + vistaro.config.json + media)
 *   <id>/out/         CLI output (demo.mp4, demo.vtt)
 *
 * The CLI is invoked with <id>/project as its project directory, so its guide
 * lands in <id>/project/guide/. Everything under <id>/ is publicly served at
 * /embed/<id>/... (except job.json and upload.zip — see server.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOG_TAIL_BYTES = 8000;

function newJobId() {
  return `bld_${crypto.randomBytes(8).toString('hex')}`;
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function jobsRoot(dataDir) {
  return path.join(dataDir, 'jobs');
}

function jobDir(dataDir, id) {
  return path.join(jobsRoot(dataDir), id);
}

function jobMetaPath(dataDir, id) {
  return path.join(jobDir(dataDir, id), 'job.json');
}

/** Atomic-ish meta write: tmp file + rename, so a reader never sees a torn JSON. */
function writeMeta(dataDir, meta) {
  const file = jobMetaPath(dataDir, meta.id);
  meta.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, file);
}

function readMeta(dataDir, id) {
  try {
    return JSON.parse(fs.readFileSync(jobMetaPath(dataDir, id), 'utf8'));
  } catch {
    return null;
  }
}

function listJobs(dataDir) {
  const root = jobsRoot(dataDir);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (!JOB_ID_RE.test(name)) continue;
    const meta = readMeta(dataDir, name);
    if (meta) jobs.push(meta);
  }
  jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jobs;
}

/**
 * Create the on-disk skeleton for a job. Returns the job id.
 * (upload.zip + project/ are written by the caller, server.js.)
 */
function createJobDirs(dataDir) {
  const id = newJobId();
  const dir = jobDir(dataDir, id);
  fs.mkdirSync(path.join(dir, 'project'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  return { id, dir };
}

function tailString(buf, maxBytes = LOG_TAIL_BYTES) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  return s.length > maxBytes ? `…${s.slice(-maxBytes)}` : s;
}

/** Remove a job directory entirely (used when an upload is rejected). */
function deleteJob(dataDir, id) {
  fs.rmSync(jobDir(dataDir, id), { recursive: true, force: true });
}

module.exports = {
  JOB_ID_RE,
  LOG_TAIL_BYTES,
  createJobDirs,
  deleteJob,
  jobDir,
  jobsRoot,
  listJobs,
  newJobId,
  readMeta,
  tailString,
  writeMeta,
};
