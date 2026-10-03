# Test discipline

These rules apply to every agent and every person changing this repo (Claude Code, Codex, GLM). AGENTS.md is the manual for *driving* the CLI; this file is the manual for *changing* it.

## The rules

1. **Every bug fix ships with a test that fails first.**
   - Write it from the real artifact that triggered the bug (the actual `anim.config.json`, mockup, MP4 or HTTP request), reduced to its shape, with no client content.
   - Run it red on the unfixed code, then green on the fix, and say both in the commit or PR.
2. **Every invariant written in AGENTS.md or here gets a canary test, or it isn't real.** A canary scans the codebase for a whole class of mistake, so it catches the next person who never read the rule. Each rule in the inventory below names its canary, or says « no canary yet ».
3. **A canary only counts if it can fail.**
   - Its oracle is independent of the code under test, and uses the same accessor its consumer uses, not a look-alike that agrees today.
   - Assert an identity (this exact element or file), never a class (« not empty », « status != x »).
   - Its self-test goes red when discovery finds nothing: if a rename makes it scan zero files, it fails rather than passing.
4. **Mutation check for every new test.**
   - Break the code it guards (`if (false && …)`, remove the guard, invert the condition), watch the test go red, then restore.
   - Back the file up with `cp` before mutating. Never `git checkout` a file that has uncommitted work.
   - After any change to a test, replay every mutation it had killed: a test-only fix can resurrect one.
5. **Don't write a test and the code it tests in the same breath and call it verified.**
   - Prefer the real thing: a real Chromium, a real ffmpeg encode, a real HTTP call to `saas/server.js`.
   - Mocks hide exactly the bugs this tool has (timing, injection, encode).
   - Run anything that writes state (a `build-all --changed-only`, a SaaS job, a live-page `record` with `reset`) twice: idempotence bugs only appear on the second run.
6. **A failed or contended run is not a result.**
   - Browser and ffmpeg tests are machine-sensitive (see AGENTS.md, Contributor notes), so rerun a red test alone, on an idle machine, before acting on it.
   - One browser-driven job at a time.
7. **Report exit codes, not impressions.** Read each command's exit code in its own call. Give the suite's counts (pass, fail, skipped) before and after. Say plainly what you could not verify.
8. **Loosening a guard, a canary or an allowlist needs JF's explicit go.** That covers adding an exception, widening a pattern and raising a ratchet.

## Commands and expected results

| What | Command | Expected |
|---|---|---|
| Fast run, no browser, no TTS | `npm run test:static` | all pass; browser and TTS tests reported as skipped |
| Full suite | `npm test` | all pass, about 10 to 15 minutes, serial |
| Types | `npx tsc --noEmit` | 0 errors |
| CLI reference drift | `npm run docs:check` | exit 0 |
| SaaS HTTP contract | `node saas/smoke.mjs` | PASS; it always kills its server |

## Invariant inventory

| Rule | Where it's stated | Canary |
|---|---|---|
| The timing constants in `runtime.js` mirror `schema.ts` | Contributor notes | `test/constants.test.ts` |
| The CLI reference matches `cli.ts` | Contributor notes | `test/docs.test.ts`, `npm run docs:check` |
| Every CLI spawn in `test/` has `timeout: CLI_TIMEOUT_MS` and `killSignal: 'SIGKILL'` (11 of 11); the 7 `spawnSync` helpers also call `assertRan()`, but the 4 async `spawn` helpers (`record.test.ts:34`, `verify.test.ts:20`, `learn.test.ts:22`, `buildall.test.ts:40`) do not, so a kill there still reports as « expected null to equal 0 » | « Nothing in a run may wait forever » | **no canary yet.** `assertRan` is copied, textually identical, into 7 test files (`browser`, `strings`, `export`, `tour`, `buildall`, `guide`, `filmstrip`): make it one shared helper covering both the sync result and the async shape, then scan `test/` for a `spawnSync`/`spawn` of the CLI missing any of the three bounds. **This row supersedes** the « each helper calling `assertRan()` » clause of AGENTS.md's « Nothing in a run may wait forever » note, which still claims every helper calls it: the code matches this row, and that file carries JF's uncommitted work, so the sentence is left for JF to correct |
| Every `spawnSync`/`execFileSync` in `src/` has a timeout | same | **no canary yet** |
| Every async child `spawn` in `src/` (`runCli` in `build-all.ts`) carries `CHILD_TIMEOUT_MS` (15 min, SIGTERM then SIGKILL after a 10 s grace) | same | **no canary yet** — and the src/ row's scan (`spawnSync`/`execFileSync`) would not see it: the bound is a `setTimeout` beside the spawn, not a `timeout` option |
| Every CLI run force-exits through `exitWhenDrained()` (5 s grace, naming the holders) even when a browser or socket keeps the process open | same | **no canary yet** (an identity assert that `cli.ts` still ends `parseAsync` with `.finally(exitWhenDrained)`; a dropped `.finally` must go red) |
| No inner function inside a callback serialized into the page (`page.evaluate`, `page.waitForFunction`) | « Rule for page.evaluate callbacks » | **no canary yet** (scan `src/` and `test/` for an `evaluate`/`waitForFunction` callback that declares a function or an arrow assigned to a const) |
| `runtime.js` and `tour-bridge.js` stay import-free plain browser JavaScript (injected as text, must tolerate document-start injection) | Contributor notes | **no canary yet** (scan both sources — `runtimeSource()` already reads one — for `import`/`export`/`require(` outside comments; the self-test plants a synthetic import and watches it go red) |
| A test that asserts where the spotlight ring landed reads its inline style, not `getBoundingClientRect()` (the pulse scales the box, so a measured rect is a few px off) | Contributor notes | **no canary yet** (scan `test/` for position assertions on `#anim-cli-highlight` that read the rect) |
| A change to what a build emits bumps `OUTPUT_REVISION` | Contributor notes | **no canary yet** (hard to automate; a review checklist item for now) |
| A fixture meant to be unreachable uses `overflow: clip` | Contributor notes | **no canary yet** |
| The CLI leaves no orphaned Chromium/ffmpeg processes; the check counts them machine-wide (parent pid 1) | « The browser-driven commands are sensitive to what else is running on the machine » | `orphans()` in `test/record.test.ts` — but it wraps only the `record` hang test and has no self-test (rule 3): plant a decoy `chromium`/`ffmpeg` process, assert the counter sees it, then run it around the other browser-driven tests |
| The suite runs serial: `--test-concurrency=1` in the `test` scripts | Contributor notes (Tests) and rule 6 | **no canary yet** (assert `package.json` keeps the flag on `test` and `test:static`; the orphan check and one-browser-job-at-a-time both assume it) |
| CI runs `npm run docs:check`, `npx tsc --noEmit` and `npm test` on every push | Contributor notes (CI) | **no canary yet** (scan `.github/workflows/test.yml` for the three steps) |
| SaaS: `/v1/*` refuses a request without a key; no path traversal on embeds; billing answers 501 without Stripe | `saas/smoke.mjs` | the smoke script, chained into `npm test` after the suite (and so into CI's Test step), plus unit tests for four of the `saas/lib` modules: `test/saas-auth.test.ts`, `test/saas-jobs.test.ts`, `test/saas-queue.test.ts`, `test/saas-stripe.test.ts` |

## Known gaps, in priority order

1. **The SaaS unit tests are new and partial.** `test/saas-auth.test.ts`, `test/saas-jobs.test.ts`, `test/saas-queue.test.ts` and `test/saas-stripe.test.ts` cover `saas/lib/auth.js`, `jobs.js`, `queue.js` and `stripe.js`, and `saas/smoke.mjs` is chained into `npm test` after the suite, so CI's Test step exercises the HTTP contract too. What remains: `saas/lib/httputil.js`, `project.js` and `zip.js` have no dedicated unit tests — the smoke reaches the ZIP reader, the unpack and the Range/file serving only end-to-end, through the HTTP contract.
2. **No agent guardrails:**
   - no hook that type-checks the files an agent edits;
   - no guard against commits without a pathspec, or against overwriting uncommitted work;
   - no pre-push check.
3. **CI runs the three checks on every push** (inventoried above), but nothing ties a red build to a deploy of the website or the SaaS.
4. **The rules marked « no canary yet »** in the inventory above — and `orphans()`, a canary that exists but has no self-test, so by rule 3 it does not count yet.

The phased plan to close them runs lot by lot, each with JF's go at the end: SaaS unit tests and smoke wiring (done), one shared `assertRan` helper plus the spawn-bound canary, a canary per « no canary yet » row with its mutation proof, then agent guardrails and a pre-push check.
