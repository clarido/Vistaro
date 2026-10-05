# Coordination state — test-discipline campaign

Coordinator: this ZCode session (GLM-5.3), started 2026-10-03.
No other Claude tabs exist in this environment; the coding fleet is one dynamic
workflow whose subagents run on GLM-5.3-Flash. This file is the running log.

## Shared tree (startup check, 2026-10-03)

- main tip: `b4d314e` (website de-slop lot — the previously uncommitted website/
  changes landed here before coordination started; not ours).
- dirty, JF's own, untouchable: `AGENTS.md`, `CLAUDE.md` (loads @AGENTS.md +
  @docs/testing-discipline.md), `.zcodeignore`, `docs/testing-discipline.md`.
- Standing rule: no commits at all until JF says so; our only edit target is
  `docs/testing-discipline.md`.

## Slot

- None. Phase 0 is docs-only: no landing, no gate suite. The next slot opens
  only after JF approves phase 0 (then: SaaS unit tests + smoke into npm test/CI).

## Open lots

- **Phase 0 — verify the discipline doc** (workflow "Phase 0: verify the
  discipline doc", GLM-5.3-Flash):
  - 10 read-only checkers (one per inventory row, gaps + commands, one
    missing-invariants hunter) — no cleared files, no writes, no suite runs.
  - Doc writer: `docs/testing-discipline.md` EXCLUSIVE; no git state changes.
  - Fresh reviewer: read-only, judges the edited doc against the diff and code.
  - Status: DONE. Run 2 (dwfrun-72273e00, amended) completed 2026-10-03: 22 checks,
    13 confirmed as written, 9 corrections/additions applied; fresh review: no blockers.
    Doc verified on disk by coordinator read-back; nothing committed (waits for JF).

## Queue (agreed order, after JF approves phase 0)

1. a. SaaS unit tests (`saas/lib/auth.js`, `stripe.js`, `jobs.js`, `queue.js`)
   and `saas/smoke.mjs` into `npm test` + CI.
2. b. One shared `assertRan` helper in `test/`, then the spawn-bound canary.
3. c. The other « no canary yet » rows, one canary each, with mutation proofs.
4. d. Agent guardrails + pre-push check.

## Waiting on JF

- (/docommit RUNNING, 2026-10-03/04, JF + "make sure we have clear instructions for
  future coding sessions") COMBINED granularity chosen by default (JF named none):
  one commit over lot c + canary-respect section + lot d, doc included once d
  settles (its doc pass shares the file; its gates share the machine). Sequence:
  wait d → fresh review (combined diff) → full npm test gate → pathspec commit.
  Instructions-chain verification for future sessions included in the final report:
  CLAUDE.md loads both manuals; AGENTS.md:354 points at the discipline doc; the doc
  carries rules 1-8 + canary-respect + phased plan + (from d) ACTIVATION. Optional
  flag to JF: the multi-session coordinator protocol (lots, clearances, slots) lives
  only in his prompt + this state file — committing it as repo policy is his call.

- (commit BLOCKED, 2026-10-03) First full-suite run: 221 tests, 220 pass, 1 FAIL —
  and the coordinator's exit capture was wrong (zsh: PIPESTATUS is bash; the 0 was
  tail's). The `&&` chain means smoke never ran either. Rule 6 invoked: full rerun
  with complete log to /tmp/lot-a-npm-test-full.log to identify the red test, then
  rerun it alone. No commit until a genuinely green gate. Suspects: machine-sensitive browser
  test flake, or lot-a side effects (saas-queue shims spawn children during the suite).
- (lot b /docommit, 2026-10-03) Fresh review: no code defects; ONE doc blocker —
  row 45's supersession clause was inverted by the lot itself (wiring the 4 async
  helpers made AGENTS.md's assertRan sentence TRUE again) — fixed before the gate.
  Review notes filed: member-call async spawn + spaced/execFile/fork openers and
  hoisted cli.ts escape discovery (false negatives only, identity assert still
  ratchets); bound 3 is file-scope (fine while one CLI helper per file); ENOENT
  renders "killed by ENOENT" (cosmetic); real-file mutations rest partly on the
  coder's report. AGENTS.md assertRan-correction item DISSOLVED (sentence true
  again); only RESET_TIMEOUT_MS naming remains optional for JF.
- (commit in progress, 2026-10-03) /docommit run for lot a: fresh review clean (no
  blockers, 6 notes — 2 fixed: inert saas/lib/auth.d.ts deleted, tsc re-verified 0;
  doc's ~/Downloads path replaced by an inline phase summary). Full npm test chain
  running as the commit-time gate; commit by pathspec on its green. auth.d.ts question
  resolved by removal (nothing consumed it).
- After commit: lot b dispatched (JF: "then go to start lot b").
- Review notes filed for later lots: chars-vs-bytes contract in jobs tailString
  (LOG_TAIL_BYTES name vs characters); serial-drain shim sleep could widen;
  tailString(Buffer)-vs-string soft oracle; smoke could join test:static (JF's call).
- Queue after lot b: the queue.js log-tail bug-fix lot (confirmed), then c, d.
- Optional, his own file AGENTS.md: the « each helper calling assertRan() » clause is
  superseded (4 async spawn helpers lack it), and RESET_TIMEOUT_MS (src/reset.ts:4)
  is unnamed in the Contributor notes.
- Shared-tree event: another session landed 8001ff5 (website/index.html only, no
  overlap with our paths). Coordinator saw it before committing.

## Done, uncommitted (lot output on disk, no commit)

- **Lot a — SaaS unit tests + smoke wiring** (2026-10-03, run dwfrun-1e28213e):
  4 test files (43 cases), 33 mutations — all went red, all restored; gates green in
  round 1 (tsc exit 0, test:static exit 0, smoke exit 0); saas/ clean of mutation
  leaks; fresh review: no blockers. Wiring: `npm test` chains `&& node saas/smoke.mjs`
  after the suite (serial kept, test:static untouched); CI comment-only (npm test
  covers smoke — no duplicate step); doc SaaS row + gap 1 updated.
  DEVIATION: saas/lib/auth.d.ts created off-list (see Waiting on JF).
  BUG (CONFIRMED by coordinator read of queue.js): the success path drops the CLI log
  tail — queue.js:177 assigns `finishedMeta.log = tail` to an object never written
  back; queue.js:200-205 re-reads meta from disk and writes it without `log`; failure
  branches keep the tail (queue.js:221). TODO marker left in test/saas-queue.test.ts.

## Done, uncommitted (lot output on disk, no commit)

- **Lot b — shared assertRan + spawn canary** (2026-10-03, run dwfrun-c7c7d48a):
  NEW test/assert-ran.ts (CLI_TIMEOUT_MS + CliSpawnResult + assertRan, sync and
  async shapes, not glob-picked) and test/spawn-bounds.test.ts (canary: 11 known
  sites identity-asserted, three bounds, empty-discovery red, non-CLI shapes proven
  inert, literal-timeout red); 7 local copies deleted (−160/+45 over 11 files);
  4 async helpers wired, with an added child-error settle (ENOENT no longer hangs
  the await); doc row 45 updated. Gates: tsc exit 0, test:static exit 0, leftover
  scan clean. 7 decoy/mutation proofs reported. Fresh review: no blockers.
  Coordinator verified: tree, helper, canary read in full.
  Awaiting JF's /docommit for the full-suite gate + pathspec commit.

## Done, uncommitted (lot output on disk, no commit)

- **Lot c — one canary per row** (2026-10-03, run dwfrun-a64e2f81): 8 canaries
  (src-spawn-bounds, src-async-spawn-bound, cli-force-exit, page-callback-purity,
  plain-browser-js, serial-suite, ci-workflow, spotlight-rect) + shared reader
  test/scan-source.ts + orphans.ts (moved verbatim) with its rule-3 self-test
  (test/orphans.test.ts, real ppid-1 decoy); record.test.ts wraps its two
  browser-owning tests. 28 mutation proofs, 0 not red; gates: tsc 0, static red
  round 1 (stderr-only capture missed node:test's stdout TAP — lesson filed),
  fixed by gate fixer, round 2 exit 0; src/ clean. Doc: 12 edits, rows current,
  2 rows recorded not-automatable with reasoned verdicts (OUTPUT_REVISION,
  overflow:clip), gap 4 rewritten. Fresh review: blockers fixed in one round.
  Coordinator verified tree + doc read.
- **Lot d — agent guardrails** (2026-10-04, run dwfrun-70e6b9fb, 1h38m): shipped
  INERT — .githooks/claude/{pre-tool-use-guard.mjs, post-tool-use-typecheck.mjs,
  settings.example.json} + .githooks/pre-push + test/guardrails.test.ts (4 blocks:
  hook integrity, live-file equality, docs-refs ratchet, end-to-end guard matrix).
  Fresh-review blocker (.claude/ is gitignored) fixed by relocation to .githooks/claude/.
  Gates: tsc 0; static red round 1 (3 fails, stdout-tail capture worked this time),
  fixed, round 2 exit 0. Activation verified absent (hooksPath unset, no live settings).
- **Combined /docommit (c + micro + d), 2026-10-04**: fresh review — 1 blocker
  (checkout -B/--orphan silently allowed; --git-dir and (git stash) bypasses too) +
  7 notes. Coordinator fixed in /docommit mode: ask on -b/-B/--orphan, GLOBAL_VALUE
  set for --git-dir/--work-tree/--namespace, paren-prefix AND subcommand-trailing
  punctuation stripping (first fix missed `stash)`); matrix extended; guard header
  enumeration; plain-browser-js stale header; ACTIVATION mkdir -p. Canary 19/19.
  COMMIT COMPOSITION: AGENTS.md EXCLUDED (its uncommitted diff is half the studio
  lot's reference section — foreign); CLAUDE.md INCLUDED (pure campaign: the two
  @-imports); docs-refs token `docs/testing-discipline.md` re-sourced to the doc's
  own intro (empirically verified: 19/19 under simulated HEAD with old AGENTS.md).
  LESSON (twice now): zsh has no PIPESTATUS — always `cmd > log; echo $?`, never
  pipes, for gates.
- **Micro: canary-respect section** (2026-10-03, JF "do that"): the 7-point
  "When a canary goes red at you" protocol added after the rules, by coordinator
  edit, content dictated by JF. Rides the combined commit.

## Done, uncommitted (lot output on disk, no commit)

- **Open-items lot** (2026-10-04, run dwfrun-a7ee3937): queue log-tail bug fixed
  failing-test-first (red 10/11 exit 1 → fix → 11/11; dead store removed,
  done.log = tail before writeMeta — coordinator verified the diff); flake
  deadline widened 15s→30s (file-local until default, oracle untouched);
  3 new SaaS test files (httputil 18, project 8, zip 30 cases), 22 mutation
  proofs, 0 bugs; orphan wrap on browser (file scope), guide, tour; doc gaps
  1+4 updated. Gates: tsc 0; static red round 1 (the spotlight canary's line
  pins — see below), round 2 exit 0. Fresh review: no blockers.
  OUT-OF-CLEARANCE, coordinator-verified and accepted: test/orphans.ts
  (comment-only: the wrap-topology contract) and test/spotlight-rect.test.ts
  (line re-pins only — wrap insertions shifted the two exempted sites; same
  sites/shapes/justifications, second test re-verifies at new lines; NOT a
  rule-8 loosening). Neither was in the fresh reviewer's brief — coordinator
  read both diffs in full instead.
- Shared-tree event: the studio lot LANDED as bafb43b while this lot ran —
  no foreign files remain on the tree; spawn-bounds 12-site row now matches
  HEAD.

## Landed

- **d6d0f0f — open-items lot** (2026-10-04, /docommit): 11 files, +2030/−56 —
  queue log-tail fix (red-first), 30 s deadline, 3 new SaaS test files (gap 1
  CLOSED: all seven saas/lib modules covered), orphan wrap (browser file-scope,
  guide, tour), doc gaps + "Working in lots" section. Fresh review: APPROVE,
  no blockers; its note 1 fixed pre-gate (TestContext premise corrected to
  call-ordering truth in orphans.ts, browser.test.ts, the doc row). FLAKE #3:
  same saas-queue success test starved past the WIDENED 30 s deadline in suite
  context (poll loop alive, job never done; solo 371 ms green) — until() now
  carries an evidence hook (last status, queue state, runner logs) so flake #4
  diagnoses itself; gate rerun 355/355 + smoke PASS. Not pushed.
- **1174ebf — lots c + micro + d combined** (2026-10-04, /docommit): 19 files,
  +3219/−30 — 8 canaries + scan-source + orphans extraction, the canary-respect
  section, the inert guardrails (.githooks/, executable hooks) and CLAUDE.md's
  discipline import. AGENTS.md deliberately EXCLUDED (half studio-lot content);
  its pointer + reference section land with the studio commit. Gate: full suite
  299/299 first-try green + smoke PASS. Review blocker (checkout -B/--orphan,
  --git-dir, paren bypasses) fixed pre-gate; docs-refs token re-sourced to the
  doc's own intro, verified under simulated HEAD. Not pushed.
- **6921d64 — lot b** (2026-10-03, /docommit): 13 files (test/assert-ran.ts,
  test/spawn-bounds.test.ts new; 10 rewired test files; doc row 45). Gate story:
  first full run RED (EXIT=1, correctly captured this time) — saas-queue success-path
  test timed out at its 15 s deadline in suite context; green ALONE (11/11, rule 6);
  full rerun GREEN 226/226 + smoke PASS. Fresh review: no code defects, one doc
  blocker (inverted supersession clause) fixed pre-gate. Not pushed.
  FLAKE PATTERN (2 occurrences): one-off suite-context timeout after heavy browser
  tests — lot a: unidentified; lot b: saas-queue success-path (green solo + rerun).
  If it recurs in CI, widen that test's until() deadline; candidate micro-lot.
- **f26d04d — lot a** (2026-10-03, /docommit): 7 files (4 saas test files, package.json
  wiring, CI comment, docs/testing-discipline.md), 1228 insertions. Commit-time gate:
  first full-suite run had 1 unidentified flake (220/221; coordinator's zsh exit
  capture bug masked it — PIPESTATUS is bash); clean rerun 221/221 + smoke PASS +
  EXIT=0, then committed. Fresh review before gates: no blockers; inert auth.d.ts
  deleted (tsc re-verified 0), doc's local path replaced by inline phase summary.
  Not pushed.

## Open lots (current)

- **Open-items lot (queue bug + flake, httputil/project/zip tests, orphan wrap)**
  (JF: "work to complete the open items", 2026-10-04):
  - CLEARED: saas/lib/queue.js + test/saas-queue.test.ts (bug fix failing-first +
    until-deadline widen); NEW test/saas-httputil.test.ts, test/saas-project.test.ts,
    test/saas-zip.test.ts; EDIT test/browser.test.ts, test/guide.test.ts,
    test/tour.test.ts (watchOrphans wrap); EDIT docs/testing-discipline.md (gaps 1+4).
  - NOT touched: studio set (cli.ts, AGENTS.md, README.md, test/spawn-bounds.test.ts,
    src/commands/studio.ts, src/studio/, test/studio.test.ts — foreign, in flight;
    studio's own orphan wrap is its lot's), .zcode*, pushes.
  - Conditions: phase 4 browser files run one at a time; mutations sequential with
    cp backups; gates tsc + test:static; NO COMMITS (await /docommit).
- 2026-10-04: coordinator-protocol section ("Working in lots") added to the
  discipline doc by coordinator (JF: "work to complete the open items" taken as
  the word on the offered section — it documents existing practice; disclosed).

- **Micro: canary-respect section** (JF: "do that", 2026-10-03): add the 7-point
  "When a canary goes red at you" protocol to docs/testing-discipline.md, right
  after the rules. Content as drafted in the 2026-10-03 exchange (red canary is a
  finding; read the message, fix-or-join; canary-fix needs re-proof; rule-8 list
  unchanged; run scope-touched canaries pre-READY; foreign-file reds are cross-lot
  events; new canaries carry the join-procedure in their failure message).
  WAITS for lot c's doc writer to release the file; lands as a coordinator edit
  (content dictated by JF), uncommitted until /docommit.
- **Lot c — one canary per « no canary yet » row** (JF: "go on to both lot c and d",
  2026-10-03):
  - CLEARED: NEW canary test files per the surveyor (src sync-spawn timeouts,
    CHILD_TIMEOUT_MS identity, exitWhenDrained identity, evaluate/waitForFunction
    inner functions, import-free runtime.js+tour-bridge.js, serial-suite flag,
    CI three steps, spotlight inline-style — plus feasibility verdicts where a row
    is honestly not automatable); NEW shared scan helper if the surveyor wants one;
    EDIT test/record.test.ts (orphans() self-test + wrap-around) by ONE coder;
    EDIT docs/testing-discipline.md rows + gap 4 by ONE doc writer, same change.
  - Conditions: mutations SEQUENTIAL (cp backup to /tmp, red, restore, rerun
    green); src/ ends clean (git diff --stat -- src/ empty); landed lots' files
    (assert-ran, spawn-bounds, saas tests) read-only; gates tsc + test:static;
    NO COMMITS.
- **Lot d — agent guardrails + pre-push check** (authorized same message; QUEUED
  behind c — same doc file, one heavy job at a time):
  - Scope per JF's original phases 2-3, adapted: PostToolUse type-check hook,
    PreToolUse commit-pathspec/stash guard, pre-push check (.githooks), guardrails
    canary (paths/commands in CLAUDE.md exist, hooks wired), gap 2 + doc rows.
  - Condition: SHIP but DO NOT ACTIVATE — no core.hooksPath flip, no global config;
    activation is JF's one-liner (hooks affect every tab on this checkout).
  - /docommit granularity for c+d (separate or combined, doc-file conflict noted)
    is JF's call when both reports are in.

## Shared-tree events (foreign lots)

- 2026-10-03, during lot c: ?? src/commands/studio.ts + M cli.ts — another session's
  IN-FLIGHT, UN-CLEARED lot (new `studio` CLI command; SerialRunner.run spawns the
  CLI at :113 with spawn-option timeout 10min + SIGKILL — not the CHILD_TIMEOUT_MS
  insist pattern). Coordinator ruling on the escalated question dwfq-a64e2f81-1:
  lot-c src-scanning canaries scope discovery to TRACKED files (git ls-files); the
  per-site oracle stays pinned to the insist block (no rule-8 loosening); the row
  records that studio.ts must join KNOWN_SITES when it lands — adopting the pattern
  or accepting its shape is JF's call. Consequence: the studio lot's own landing
  will trip this canary red BY DESIGN; its author reconciles (join list via pattern
  adoption) or asks JF for shape acceptance. JF informed in the lot-c interim report.

## Decisions log

- 2026-10-03: JF's note said "website/ has uncommitted changes that aren't
  yours" — the tree no longer has any; they are in `b4d314e`. Rule stands:
  website/ untouched either way.
- 2026-10-03: no per-row second confirmations in phase 0 (doc rows, low stakes);
  coordinator re-reads the final diff before reporting.
- 2026-10-03: script bug (unguarded .length on a malformed subagent result) killed run 1
  after the write. Fixed by normalizing every result through listOf(); reviewer ask also
  fixed — git diff shows nothing on an untracked file, so it now reads the doc itself.
- 2026-10-03: the writer's corrected inventory row 45 supersedes one AGENTS.md sentence
  (« each helper calling assertRan() » — 4 async spawn helpers do not). AGENTS.md is JF's
  uncommitted file: the one-sentence correction is his to type. Same for naming
  RESET_TIMEOUT_MS (src/reset.ts:4) beside FFMPEG/SAY_TIMEOUT_MS in the Contributor notes.
