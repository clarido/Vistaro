'use strict';
/** Unzip an uploaded project into <jobDir>/project/, with a screen the CLI accepts. */

const fs = require('node:fs');
const path = require('node:path');
const { extractZip, looksLikeZip, ZipError } = require('./zip');

/**
 * @param {Buffer} zipBuf the uploaded archive
 * @param {string} jobDirAbs job directory (project/ is created inside)
 * @returns {{ files: number, bytes: number }} what was extracted
 * @throws ZipError on anything unsafe or unreadable
 */
function unpackProject(zipBuf, jobDirAbs) {
  if (!looksLikeZip(zipBuf)) {
    throw new ZipError('upload is not a ZIP archive (missing PK header)');
  }
  const projectDir = path.join(jobDirAbs, 'project');
  fs.mkdirSync(projectDir, { recursive: true });

  let files = 0;
  let bytes = 0;
  // Streamed to disk entry by entry: an uploaded archive must never become a
  // whole-payload array in RAM on the same machine that runs the exports.
  extractZip(zipBuf, (entry) => {
    const target = path.join(projectDir, ...entry.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    files += 1;
    bytes += entry.data.length;
  });

  flattenWrapperDir(projectDir);
  requireScreenFiles(projectDir);
  return { files, bytes };
}

/** Many zips wrap everything in one top-level folder; unwrap it if so. */
function flattenWrapperDir(projectDir) {
  if (hasScreenFiles(projectDir)) return;
  const top = fs.readdirSync(projectDir, { withFileTypes: true });
  const dirs = top.filter((d) => d.isDirectory());
  if (dirs.length !== 1) return;
  const inner = path.join(projectDir, dirs[0].name);
  if (!hasScreenFiles(inner)) return;
  for (const child of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, child), path.join(projectDir, child));
  }
  fs.rmdirSync(inner);
}

function hasScreenFiles(dir) {
  return fs.existsSync(path.join(dir, 'index.html'));
}

/** The CLI's contract is a directory with index.html (+ vistaro.config.json for export). */
function requireScreenFiles(projectDir) {
  const missing = ['index.html', 'vistaro.config.json'].filter(
    (f) => !fs.existsSync(path.join(projectDir, f)),
  );
  if (missing.length > 0) {
    throw new ZipError(
      `the archive must contain a Demoforge screen at its root (missing: ${missing.join(', ')})`,
    );
  }
}

module.exports = { unpackProject };
