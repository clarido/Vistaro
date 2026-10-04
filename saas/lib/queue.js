'use strict';
/**
 * Serial in-process export queue.
 *
 * One browser-driven export at a time — the repo manual (AGENTS.md,
 * "Contributor notes") warns that concurrent browser-driven runs corrupt each
 * other, so this queue is deliberately serial and stays in memory: no job
 * survives a server restart (interrupted jobs are marked failed at boot).
 * A durable queue across restarts/replicas is a production gap (README).
 *
 * The runner spawns the parent repo's CLI exactly as documented:
 *
 *   npx tsx cli.ts export <jobdir>/project -o <jobdir>/out/demo.mp4
 *
 * with cwd set to the repo root, so the CLI resolves its own node_modules,
 * ffmpeg-static and Playwright browser.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const jobs = require('./jobs');

const KILL_GRACE_MS = 10000;

function defaultLog(line) {
  process.stderr.write(`[queue] ${line}\n`);
}

/** Artifacts we look for after a successful export (paths relative to the job dir). */
function discoverArtifacts(jobDirAbs) {
  const want = [
    ['video', path.join(jobDirAbs, 'out', 'demo.mp4')],
    ['subtitles', path.join(jobDirAbs, 'out', 'demo.vtt')],
    ['guideHtml', path.join(jobDirAbs, 'project', 'guide', 'guide.html')],
    ['guideJson', path.join(jobDirAbs, 'project', 'guide', 'guide.json')],
    ['poster', path.join(jobDirAbs, 'project', 'guide', 'assets', 'poster.png')],
  ];
  const found = {};
  for (const [key, abs] of want) {
    try {
      if (fs.statSync(abs).isFile()) {
        found[key] = path.relative(jobDirAbs, abs).split(path.sep).join('/');
      }
    } catch { /* absent */ }
  }
  return found;
}

class ExportQueue {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir    jobs root parent (saas/data)
   * @param {string} opts.repoRoot   parent repo — cwd for the CLI spawn
   * @param {number} [opts.timeoutMs] hard cap per export (default 30 min)
   * @param {boolean} [opts.disabled] SAAS_DISABLE_RUNNER: accept jobs, never spawn (smoke tests)
   * @param {(line: string) => void} [opts.log]
   */
  constructor({ dataDir, repoRoot, timeoutMs = 30 * 60 * 1000, disabled = false, log = defaultLog }) {
    this.dataDir = dataDir;
    this.repoRoot = repoRoot;
    this.timeoutMs = timeoutMs;
    this.disabled = disabled;
    this.log = log;
    this.waiting = [];
    this.runningJob = null;
    this.child = null;
    this.stopped = false;
  }

  get depth() {
    return this.waiting.length + (this.runningJob ? 1 : 0);
  }

  enqueue(meta) {
    this.waiting.push(meta.id);
    setImmediate(() => this.drain());
  }

  position(id) {
    const idx = this.waiting.indexOf(id);
    return idx === -1 ? null : idx + 1; // 1-based; null when running or done
  }

  drain() {
    if (this.stopped || this.runningJob || this.waiting.length === 0) return;
    const id = this.waiting.shift();
    if (this.disabled) {
      this.log(`runner disabled (SAAS_DISABLE_RUNNER=1); job ${id} stays queued`);
      // Keep it at the front so its state stays honestly "queued" — it will
      // run the moment a server without the flag picks it up (after restart
      // recovery marks it failed, i.e. this is a test-only limbo by design).
      this.waiting.unshift(id);
      return;
    }
    // The finally is the whole point: without it `runningJob` stays set after the first
    // job and the queue never drains again (reproduced: job 2 waits forever, /health
    // reports running: true eternally). Every exit path of runOne passes through it.
    Promise.resolve(this.runOne(id))
      .catch((e) => {
        this.log(`job ${id}: internal runner error: ${e && e.stack ? e.stack : e}`);
        this.finishFailure(id, `internal runner error: ${e && e.message ? e.message : e}`);
      })
      .finally(() => {
        this.runningJob = null;
        this.drain();
      });
  }

  async runOne(id) {
    const meta = jobs.readMeta(this.dataDir, id);
    if (!meta) {
      this.log(`job ${id}: meta vanished; skipping`);
      return;
    }
    this.runningJob = id;
    const jobDirAbs = jobs.jobDir(this.dataDir, id);
    const projectDir = path.join(jobDirAbs, 'project');
    const outMp4 = path.join(jobDirAbs, 'out', 'demo.mp4');

    meta.status = 'running';
    meta.startedAt = new Date().toISOString();
    jobs.writeMeta(this.dataDir, meta);

    const args = ['tsx', 'cli.ts', 'export', projectDir, '-o', outMp4];
    const command = this.spawnCommand();
    this.log(`job ${id}: spawning ${command} ${args.join(' ')} (cwd ${this.repoRoot})`);
    meta.command = `${command} ${args.join(' ')}`;
    jobs.writeMeta(this.dataDir, meta);

    let output = '';
    const collect = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 4 * jobs.LOG_TAIL_BYTES) output = output.slice(-2 * jobs.LOG_TAIL_BYTES);
    };

    const exit = await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.repoRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Node >= 18.20/20.12 refuses .cmd without a shell (CVE-2024-27980); the args are
        // server-built (job paths only), so the shell carries no injection surface.
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });
      this.child = child;
      this.killReason = null;
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timer = setTimeout(() => {
        this.killReason = 'timeout';
        this.log(`job ${id}: export exceeded ${this.timeoutMs} ms; sending SIGTERM`);
        child.kill('SIGTERM');
        this.killTimer = setTimeout(() => {
          this.log(`job ${id}: still alive after ${KILL_GRACE_MS} ms; sending SIGKILL`);
          child.kill('SIGKILL');
        }, KILL_GRACE_MS);
      }, this.timeoutMs);

      child.on('error', (e) => {
        clearTimeout(timer);
        clearTimeout(this.killTimer);
        this.child = null;
        resolve({ code: -1, signal: null, error: e.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(this.killTimer);
        this.child = null;
        resolve({ code, signal, killReason: this.killReason });
      });
    });

    const tail = jobs.tailString(output);

    if (exit.killReason === 'timeout') {
      this.finishFailure(id, `export timed out after ${this.timeoutMs} ms and was killed`, tail);
      return;
    }
    if (exit.killReason === 'shutdown') {
      this.finishFailure(id, 'export aborted: server shut down while it was running', tail);
      return;
    }
    if (exit.error) {
      this.finishFailure(id, `could not spawn the CLI: ${exit.error}`, tail);
      return;
    }
    if (exit.code !== 0) {
      this.finishFailure(id, `export exited with code ${exit.code}`, tail);
      return;
    }
    const artifacts = discoverArtifacts(jobDirAbs);
    if (!artifacts.video) {
      this.finishFailure(id, 'export exited 0 but no out/demo.mp4 was produced', tail);
      return;
    }
    const done = jobs.readMeta(this.dataDir, id) || meta;
    done.status = 'done';
    done.finishedAt = new Date().toISOString();
    done.durationMs = done.startedAt ? Date.parse(done.finishedAt) - Date.parse(done.startedAt) : null;
    done.artifacts = artifacts;
    done.log = tail;
    jobs.writeMeta(this.dataDir, done);
    this.log(`job ${id}: done in ${done.durationMs} ms → ${artifacts.video}`);
  }

  spawnCommand() {
    // Windows resolves `npx` through the shell; POSIX spawns the shim directly.
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
  }

  finishFailure(id, message, tail) {
    const meta = jobs.readMeta(this.dataDir, id);
    if (!meta) return;
    meta.status = 'failed';
    meta.finishedAt = new Date().toISOString();
    meta.durationMs = meta.startedAt ? Date.parse(meta.finishedAt) - Date.parse(meta.startedAt) : null;
    meta.error = message;
    if (tail) meta.log = tail;
    jobs.writeMeta(this.dataDir, meta);
    this.log(`job ${id}: FAILED — ${message}`);
  }

  /** Boot recovery: an MVP queue is in-memory, so anything non-terminal is dead. */
  markInterruptedJobs() {
    for (const meta of jobs.listJobs(this.dataDir)) {
      if (meta.status === 'queued' || meta.status === 'running') {
        const m = jobs.readMeta(this.dataDir, meta.id);
        m.status = 'failed';
        m.error = `server restarted while the job was ${meta.status}; the MVP queue is in-memory, submit again`;
        m.finishedAt = new Date().toISOString();
        jobs.writeMeta(this.dataDir, m);
        this.log(`job ${meta.id}: marked failed (interrupted by restart)`);
      }
    }
  }

  shutdown() {
    this.stopped = true;
    this.waiting = [];
    if (this.child) {
      this.log('shutdown: killing running export');
      this.killReason = 'shutdown';
      this.child.kill('SIGTERM');
      setTimeout(() => this.child && this.child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }
  }
}

module.exports = { ExportQueue, discoverArtifacts };
