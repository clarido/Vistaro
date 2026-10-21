# Bug findings — source audit, 2026-09-19

Findings from a read-through of the whole source tree (`cli.ts`, `src/engine/`, `src/commands/`,
`src/guide/`, `src/media/`, `src/tour/`, `src/*.ts`). **Nothing has been fixed.** Each entry gives
the location, the concrete failure mode, a reproduction path, and a suggested fix direction so
another agent can act without re-deriving the analysis.

Verification status per finding:

- **[verified]** confirmed by reading the code and (where noted) by running a probe against Node or a
  headless Chromium.
- **[code-read]** confirmed by reading the code; reproduction is by inspection (running it was not
  practical here), so re-check the cited lines first.

Severity: **High** = wrong output, crash, or silent data loss on a documented path; **Medium** =
degraded output, dropped commands, or a wrong-but-recoverable result; **Low** = cosmetic, latent, or
edge-case-only.

Line numbers refer to the working tree at commit `a297e95` (plus untracked `guides/`).

---

# Fix plan

This section is the working todo list for fixing B1–B29. Findings below are unchanged; findings with a
concrete implementation approach carry a **Plan note** inline. Nothing has been implemented yet.

## Status

All fixes below are **implemented and tested** in the working tree (uncommitted), with regression
tests failing-before/passing-after per batch. B29 is wontfix per the plan. See "Implementation
record" at the end of this file for the three places where the implementation diverged from (or
hardened) the plan note.

| ID | One-line summary | Batch | Status |
|----|------------------|-------|--------|
| B1 | build key ignores record target (stale skips) | A | done |
| B2 | positional step lookups crash on device gaps | B | done |
| B3 | `guide --device` never resolves the timeline | B | done |
| B4 | tour `play` while playing → two concurrent steps | C | done |
| B5 | tour `pause` doesn't stop the in-flight step | C | done |
| B6 | `restart()` drops page scripts' listeners | C | done |
| B7 | error caption overwritten by `paint()` | C | done |
| B8 | poster path recorded before the screenshot | B | done |
| B9 | dangling `crop` path on screenshot failure | B | done |
| B10 | `cropBox` emits out-of-image 1px clips | B | done |
| B11 | truncated `say` clip poisons the TTS cache | A | done |
| B12 | aborted run claims a previous run's `output` | A | done |
| B13 | `--tail`/`--duration` partial parses accepted | A | done |
| B14 | `<vistaro-tour>` caches a failed manifest forever | C | done |
| B15 | `_pending` single slot drops queued `goto` | C | done |
| B16 | unknown scenario slug → silent 404 frame | C | done |
| B17 | Space key hijacks focused buttons | C | done |
| B18 | `play-big` click during load is dropped | C | done |
| B19 | zero-step scenario: protocol goes silent | C | done |
| B20 | record reel + `embed` output can never succeed | C | done |
| B21 | `&amp;` decoded first (double-decode) | A | done |
| B22 | Claude branch: `content[0]` / truncation | A | done |
| B23 | `localize` merge never prunes dead keys | A | done |
| B24 | corrupt manifest silently wipes history | A | done |
| B25 | tours.json step index 0-based (rest are 1-based) | A | done |
| B26 | `init-config --kind` typo scaffolds silently | A | done |
| B27 | `state.timers` grows unbounded in driven mode | C | done |
| B28 | negative `meta.tailMs` unvalidated | A | done |
| B29 | `formatTime` rounds sub-100 ms | A | wontfix (display-only; accepted) |

## Batches and delivery

**Recommended: one PR, one commit per batch.** Each fix is small and independently testable; the
commit-per-batch split keeps review navigable while the single PR means one `OUTPUT_REVISION` bump
per affected area and no cross-PR ordering hazards. If the reviewer prefers smaller units, the batch
boundaries below are the PR boundaries — then each batch that changes emitted bytes carries its own
bump (see Cross-cutting rules).

- **Batch A — Node-side correctness (no browser):** B1, B11, B12, B13, B21, B22, B23, B24, B25,
  B26, B28, and the B29 decision. Lowest risk, no browser time, and removes the worst silent failure
  (B1) first.
- **Batch B — Guide capture & device resolution:** B2, B3, B8, B9, B10. Shares the
  `test/guide.test.ts` surface; needs one new `only`-gap fixture.
- **Batch C — Tour runtime, shell & embeds:** B4, B5, B6, B7, B14–B20, B27. Largest behavioural
  change (runtime.js, tour-bridge.js, shell, element, build-all plan) and lands last with the
  heaviest review. B4+B5 are designed together; B6 is the one genuine design decision.

## Cross-cutting rules

1. **`OUTPUT_REVISION`** (`build-all.ts:43`): bump once per landed batch that changes what a build
   emits. Planned: A → 2 (B21 changes `.vtt`/cue bytes), B → 3 (B2/B3 change which steps a guide
   captures, B10 changes crop edge behaviour), C → 4 (B6/B27 change the injected runtime, B4/B5 the
   bridge). If batches land in a different order, renumber in landing order — never land an
   emitted-output change without the bump, or `--changed-only` serves stale artifacts.
2. **Timing constants** (`schema.ts` ↔ `runtime.js` literals, pinned by `test/constants.test.ts`):
   no fix moves them. B27 in particular must only clean up bookkeeping, never change when a timer
   fires.
3. **Docs:** fixes that change documented behaviour update AGENTS.md in the same commit — B4/B5
   (message protocol), B6 (restart contract), B13 (flag grammar in the CLI reference), B23
   (localize merge), B25 (tours.json shape). `npm run docs:check` must pass (it also covers changed
   `--help` text in B13/B26).
4. **Test suite rules** (AGENTS.md, contributor notes): serial run, everything bounded, one
   browser-driven job at a time. No new spawns are planned; if one appears, it gets a timeout.
5. **Every fix lands with a regression test that fails before / passes after.** Where a failure is
   not practically reachable in a test (a real 60 s `say` wedge, a live API), extract the seam and
   test the seam instead (B11, B22).

## Testing strategy

- Batch A: `node --import tsx --test --test-concurrency=1 test/buildall.test.ts test/media.test.ts
  test/strings.test.ts test/schema.test.ts`, then `SKIP_BROWSER=1 npm test`.
- Batch B: `node --import tsx --test --test-concurrency=1 test/guide.test.ts test/browser.test.ts`
  (browser; run alone).
- Batch C: `node --import tsx --test --test-concurrency=1 test/tour.test.ts test/buildall.test.ts`
  (browser; run alone).
- Gate before every commit/PR: `npm run docs:check && npx tsc --noEmit && npm test` (10–15 min,
  serial).

## Decision points for the reviewer

1. **B6 — how far to go restoring page scripts after `restart()`.** Option A (recommended):
   auto re-execute classic scripts with per-script try/catch and an opt-out; Option B: opt-in
   `__vistaro.onRestore(fn)` hook only. Options and hazards spelled out under B6.
2. **B29 — propose wontfix.** Display-only rounding; fixing it churns every human-readable timing
   line for no functional gain. Say the word and it gets fixed instead.
3. **B13 — accepted flag grammar.** Recommended: `--tail` accepts bare ms or explicit-unit time
   strings; `--duration` stays strict bare seconds. Details under B13.
4. **Delivery split** — single PR with commit-per-batch (recommended) vs one PR per batch.
5. **B24 — corrupt-manifest aside file.** The fix renames an unparsable manifest to
   `vistaro.manifest.json.corrupt-<timestamp>` (recovery over silent wipe). Check you're happy with that
   file appearing beside the manifest.

## Definition of done (per finding)

Fix implemented · regression test failing-before/green-after · AGENTS.md / `--help` updated when
documented behaviour changes · `docs:check`, `tsc --noEmit`, targeted tests, full suite green ·
`OUTPUT_REVISION` bumped if the batch emits bytes · status row above flipped to done.

---

## High

### B1 · `--changed-only` build key ignores the record target entirely — stale rows are skipped as "unchanged" [verified]

**Where:** `src/commands/build-all.ts:50-61` (`buildKeyFor`)

```ts
return 'sha256:' + createHash('sha256').update(JSON.stringify(facts, Object.keys(facts).sort())).digest('hex');
```

`JSON.stringify`'s second argument filters keys **at every depth**, not just the top level. The nested
`record` object's keys (`url`, `ignoreHttpsErrors`, `storageState`) are not in the top-level key list,
so `record` serializes as `{}`. Verified in Node: two fact objects differing only in `record.url`
produce byte-identical JSON and identical hashes. (`outputs` is an array and survives — array indices
are exempt — so that part is fine.) The comment above the line explicitly claims the record target is
covered, so the code contradicts its own intent.

**Failure mode:** change `record.url` (or the storage state / HTTPS flag) in `help.catalog.json` and
run `build-all --changed-only`. `recordedKey === buildKey` (`build-all.ts:290`) plus a still-existing
video file → the row is skipped and the video recorded against the **old** URL stays published, with
the `=` unchanged message asserting it is up to date. This is exactly the "looks like success" failure
the `OUTPUT_REVISION` machinery was built to prevent.

**Repro:** catalog row with `record: { url: "https://a.example" }` → `build-all --changed-only` →
change the URL → `build-all --changed-only` again → row prints `unchanged …, skipped`.

**Fix direction:** hash the record fields as flat top-level primitives (`recordUrl: record?..url`,
`recordAuth: !!record?.storageState`, …), or replace the key-array replacer with an explicit
stable-stringify that recurses.

**Plan note (Batch A):** flat fields it is — `recordUrl`, `recordIgnoresHttpsErrors`,
`recordHasStorageState`. Rows without a `record` serialize byte-identically to today (JSON.stringify
drops `undefined` properties), so their keys are unchanged and no mass rebuild happens; record rows
rebuild once, which is the point. Regression test: `test/buildall.test.ts:116` already asserts record
*presence* changes the key — that passes even today, because `{}` vs `undefined` differ. Add the
value assertion `buildKeyFor(h, st, { url: 'http://x' }) !== buildKeyFor(h, st, { url: 'http://y' })`:
red today, green after. No `OUTPUT_REVISION` bump needed here — the key inputs themselves change.

### B2 · Positional `steps[c.index - 1]` lookups crash or misattribute data when a device-resolved timeline has gaps [code-read]

**Where:** `src/commands/guide.ts:157-161` (clip windows) and `guide.ts:186` (narration); contract
created by `src/engine/schema.ts:444-446`.

`applyDevice` drops `only` steps **in place** and `schema.ts:442` documents that `index` "keeps the
authored numbering and can be non-contiguous". `buildGuide` nevertheless indexes the resolved array by
position:

```ts
const i = c.index - 1;
const s = steps[i];
const start = Math.max(0, actualOf(s) - leadMsFor(s, steps[i - 1]));
...
narration: narrationOf(timeline.steps[c.index - 1]),
```

With authored steps 1,2,3,4 where step 2 is `only: "mobile"` and a desktop export runs, the resolved
array is `[1,3,4]`. For captured step `c.index === 3`, `steps[2]` is step 4 → wrong lead, wrong clip
boundary, wrong narration. For `c.index === 4`, `steps[3]` is `undefined` → `narrationOf(undefined)`
throws `TypeError`, killing `export --guide` **after** the recording has completed. With `--clips` it
dies earlier, in `actualOf(s)`.

**Repro:** `vistaro.config.json` with 4 numbered steps, step 2 given `"only": "mobile"`; run
`npx tsx cli.ts export <dir> -o demo.mp4 --guide` (desktop). Guide build crashes on the last step;
earlier steps carry the wrong step's narration.

**Fix direction:** look steps up by `index` (`Map` keyed by `s.index`), the way
`capture.ts:309` already does (`timeline.steps.find(s => s.index === index)`).

**Plan note (Batch B):** subtle point the one-liner hides: the *neighbour* lookups (`steps[i - 1]`,
`steps[i + 1]` feeding `leadMsFor`) must stay positional in the resolved array, because the driver
computes the step's actual lead against the previous **resolved** step (`driver.ts:511`) — switching
the lead's `prev` to the authored `index - 1` would compute a different clip start across a gap than
the video really has. So: resolve `s` (and the narration lookup at `:186`) through an index→step
`Map`; keep prev/next positional. If `c.index` matches no step (capture/timeline divergence), log a
warning and skip the clip rather than throw. Test: new fixture in `test/guide.test.ts` with an
`only` gap mid-timeline; assert guide.json narration maps to the right steps and the last captured
step no longer crashes.

### B3 · `guide --device` changes the viewport but never the timeline [code-read]

**Where:** `src/commands/guide.ts:225` vs `cli.ts:278` (the flag is declared) and the four sibling
commands that do it right: `build.ts:83`, `check.ts:322`, `export.ts:161`, `preview.ts:43`.

```ts
const timeline = loadTimeline(dir, { locale: options.locale, config: configAbs });   // no `device`
```

`loadTimeline` only calls `applyDevice` when `opts.device` is set (`schema.ts:418`). So a step with
`only: "mobile"` (dropped from the exported video) is still captured and numbered by a standalone
`guide`, and `mobile: { … }` overrides stay inert. guide.html then disagrees with the video it links:
different step count, different numbering, different choreography.

**Repro:** timeline with an `only: "desktop"` step → `export <dir> --device mobile` drops it, then
`guide <dir> --device mobile` still captures it.

**Fix direction:** pass `device: deviceKind(options.device)` to `loadTimeline`, matching the other
commands.

**Plan note (Batch B):** one line at `guide.ts:225`. Out of scope but worth a comment in the PR:
after a `record`, `videoFromManifest` links the last video regardless of the device the guide was
built for — a `guide --device mobile` after a desktop record still links the desktop video. That is
pre-existing and separate from this fix.

### B4 · Tour `play` while playing starts a second step concurrently [code-read]

**Where:** `src/engine/tour-bridge.js:125-129`

```js
case 'play':
  playing = true;
  if (index < 0) seek(0);
  else if (index + 1 < steps.length) { seq++; advance(seq, index + 1); }
  else seek(0);
```

There is no `if (playing) return;` guard. A `play` arriving while step N's `runStep` is still in
flight bumps `seq` (orphaning N's completion continuation) and immediately starts N+1. `runStep` in
`runtime.js` is unqueued — cursor travel, spotlight, typing and interaction timers for step N are
already scheduled in `state.timers` and nothing cancels them — so two steps run at once: two
interactions fire, the cursor is fought over by two moves.

Realistic triggers: an `<vistaro-tour autoplay="inview">` bouncing around the 0.4 intersection threshold
re-fires `play` mid-step; a host button wired to `element.play()` double-clicked; a host sending
`play` twice over the message protocol.

**Repro:** play a scenario containing a `type` step; while the typing is mid-flight deliver a second
`play` (scroll an embed out and back quickly at the threshold, or call `element.play()` twice). Step
N+1 starts while N is still animating.

**Fix direction:** make `play` a no-op when `playing` is already true (or route it through `seek()`
like the other re-entry paths).

**Plan note (Batch C — B4+B5 are one design, implement together):** the bridge tracks in-flight
state: `inFlight = true` before `runOne`, cleared in both of its settling callbacks. Then:
- `play`: `if (playing) return;` — plus `if (inFlight) { seek(index); break; }` so resuming after a
  mid-step pause replays the interrupted step (the seek path already restarts the DOM) instead of
  skipping to `index + 1` with the interaction never landed. Paused during the dwell *between*
  steps (`inFlight === false`) keeps the current "advance to next" resume.
- `pause` (see B5): add `window.__vistaro.stop()` to cancel the runtime's travel/press/typing timers.
Tests in `test/tour.test.ts` against the served scenario page: second `play` mid-`type` starts
nothing new (single interaction fires); `pause` mid-`type` stops the text; resume replays the
interrupted step. The protocol comment at the top of tour-bridge.js is updated in the same commit.

### B5 · Tour `pause` does not stop the in-flight step — typing and the click still land while paused [code-read]

**Where:** `src/engine/tour-bridge.js:131-133`

```js
case 'pause':
  playing = false; seq++; clearTimer(); emit();
```

`clearTimer()` only cancels the bridge's own dwell timer. The runtime step's timers (cursor travel,
`typeInto`'s interval, the interaction) are registered in `state.timers` precisely so `__vistaro.stop()`
can cancel them (`runtime.js:877-882` comment, `stop()` at `runtime.js:1236-1241`) — the bridge never
calls it. `seq++` abandons the promise continuation but not the animation. Press pause during a long
`type` step and the text keeps appearing and the click still fires while the shell shows "paused".
Compounds with B4: the abandoned step's interaction fires on top of the next one.

**Repro:** play a scenario with a multi-second `type` step; press pause mid-typing; watch the text
continue and the interaction fire.

**Fix direction:** on `pause`, also call `window.__vistaro.stop()`; on `play` after a pause, `seek(index)`
(replay the interrupted step) instead of jumping to `index + 1`.

**Plan note (Batch C):** accepted consequence, to be documented: `stop()` clears `typeInto`'s
interval, so the interrupted step's completion promise stalls — benign, because the resume path
(seek → `restart()`) resets `state.completions` wholesale (`runtime.js:1169`). Note it in the
bridge comment so nobody "fixes" the stall by re-arming the step underneath a paused UI.

### B6 · `restart()` permanently drops the page's own `addEventListener` handlers — tour seeks and loop restarts silently no-op click steps [verified empirically]

**Where:** `src/engine/runtime.js:1154-1161` (`restart`), snapshot taken at `runtime.js:1135-1140`.

`restart()` wipes `<body>` and re-appends `cloneNode(true)` clones of the boot snapshot. Tested in
headless Chromium: after such a restore, a listener the page's own `<script>` attached with
`addEventListener` does **not** fire on the cloned element (0 clicks after restore), and the script
does **not** re-execute (`already-started`), while inline `onclick="…"` attributes do survive
(they are attributes). So any mockup whose click steps depend on page behavior added by script —
which `export`'s docs explicitly support ("real `el.click()` so the page's own handlers run") — loses
that behavior after the first `restart()`.

**Failure mode:** a tour seek (tour-bridge `seek()` always calls `__vistaro.restart()`), an
`vistaro-tour`/reel embed loop restore, or `animated.html`'s loop replay all rebuild the DOM without
listeners. A replayed `click` step then calls `el.click()` into the void: the guide's claim that
"the page always agrees with itself" (AGENTS.md, Tours) is broken for script-driven mockups, and
worst of all the replay **succeeds silently** — no error anywhere.

**Repro:** mockup with `<script>btn.addEventListener('click', …)</script>` reacting to the clicked
step; build a tour; play past the click; seek back before it and replay — the button no longer
reacts. (Or: `build --loop` and let it loop once.)

**Fix direction:** preserve script behavior across restart — e.g. re-execute the snapshot's inline
scripts after re-appending (create fresh `<script>` clones so they run), or snapshot/restore an
explicit "wiring" hook the mockup can register (`__vistaro.onRestore(fn)`), and document the constraint
for mockup authors.

**Plan note (Batch C — the one real design decision):**
- **Option A (recommended): auto re-execute.** At `snapshot()` time, keep the original script
  elements' source; on `restart()`, after re-appending the clones, re-run each *classic* script by
  creating a fresh `<script>` clone (a re-appended clone of an already-executed script does not run —
  verified in the audit probe — so a fresh node is required). Skip `type="module"`, importmaps and
  JSON types; wrap each in try/catch so one failing script cannot kill the restore; opt-out via
  `data-vistaro-rerun="false"` on the script tag or a boot flag. Documented hazard: a script that
  appends nodes to `<body>` at load will append a second copy on every restart, because the snapshot
  already contains its output — authors opt out or append outside `<body>`.
- **Option B (most conservative): opt-in hook only.** `__vistaro.onRestore(fn)`; nothing auto-reruns.
  No double-apply hazard, but existing broken mockups stay broken silently — the status quo this bug
  exists to fix.
Test: browser test with an `addEventListener` mockup: click step → seek back → replay → the handler's
effect is present after restore (the audit probe is the template). AGENTS.md (Tours + the `build
--loop`/embed loop sections) updated with whatever contract lands.

### B7 · Tour shell overwrites a failed step's error message with the caption immediately [code-read]

**Where:** `src/tour/app/app.js:239-244` (error handler), `app.js:270-277` (`paint`), trigger in
`src/engine/tour-bridge.js:96-97` (and the seek-replay path at `:117-118`).

The bridge posts `error` and then, synchronously, a `state` (`emit()`). The shell processes both in
order: the `error` handler writes `cap-body` ("This step could not run: …"), then the `state` handler
calls `paint()`, which unconditionally rewrites `cap-body` with `c.subtitle || c.note || ''`. The
error survives at most one frame; the user sees a tour that silently stopped with an ordinary
caption.

**Repro:** break a step selector in a scenario, open the tour, press play — the caption flashes the
error and immediately shows the step's subtitle.

**Fix direction:** render errors into a dedicated element, or set an `errorShown` flag that `paint()`
respects until the next successful step.

**Plan note (Batch C):** take the bridge-side fix instead — drop the trailing `emit()` after
`post('error', …)` in both failure paths (`tour-bridge.js:96-97` and `:117-118`). The shell's error
handler already sets `playing = false` and calls `syncButtons()` itself, so the state message after
an error carries nothing the shell still needs, and removing it cannot desync anything. Smaller than
a shell-side flag and needs no protocol addition; the protocol comment is updated to say `error`
replaces `state` for that turn. Test: assert `cap-body` still shows the error text a tick after the
(state that no longer) arrives.

---

## Medium

### B8 · Guide poster path recorded before the screenshot; one failure loses the poster for the whole run [code-read]

**Where:** `src/guide/capture.ts:161-165`, catch at `:214-217`.

`poster` is assigned, then the awaited `page.screenshot` runs. If it throws (e.g. the page navigates
mid-shot), the catch recovers `entry.image` but never resets `poster`, so no later step retakes it and
`GuideCapture.poster` names a missing (or truncated) file that `guide.ts:197` writes into `guide.json`
and `render.ts` renders as `<video poster>`. Note the asymmetry: `entry.image` gets an `existsSync`
cleanup, `poster` gets none.

**Repro:** `export --guide` where the poster screenshot races a navigation; check
`guide/assets/poster.png` vs `guide.json`'s `video.poster`.

**Fix direction:** assign `poster` only after the screenshot resolves (or clear it in the catch when
the file is missing so a later step retakes it).

### B9 · Dangling `crop` path when the crop screenshot fails [code-read]

**Where:** `src/guide/capture.ts:190-198`, catch at `:214-217`.

`entry.crop = base + '.crop.png'` is assigned before the awaited screenshot; the catch cleans only
`entry.image`. On failure, guide.json/md/html reference a crop that was never written (`render.ts:83,
118` prefer `crop` over `image`), producing broken `<img>`s in the published guide.

**Repro:** a step whose measured rect sits outside the viewport with cropping on (see B10), so
`page.screenshot({ clip })` rejects; inspect `guide/guide.md`.

**Fix direction:** assign `entry.crop` only after the screenshot succeeds, or extend the catch's
existsSync cleanup to `entry.crop`.

**Plan note (Batch B — B8+B9 same shape, one commit):** prefer assign-after-await for both `poster`
and `crop` (clearer than cleanup-in-catch), plus the catch-side `existsSync` cleanup as a belt for
partially-written files. Keep the B8 retake semantics: clearing `poster` on failure lets a later
step's `renderFrame` retake it.

### B10 · `cropBox` has no intersection test — emits 1px clips located outside the image [code-read]

**Where:** `src/guide/capture.ts:107-113`.

Clamping is per-edge, not an intersection: a rect entirely right of/below the viewport yields
`x > right`, and `Math.max(1, right - x)` masks the empty intersection as a 1×1 box outside the page.
Playwright then rejects the clip ("clip area is either empty or outside the resulting image") — the
practical trigger for B8/B9. The caller's guard (`rect.width > 0 && rect.height > 0`, line 191) does
not check viewport intersection, and `visibleRect` (runtime) clamps to overflow ancestors but not to
the viewport.

**Repro:** a completion-captured step (`fadeIn`/`animate`) whose target sits below the fold and was
never scrolled; `export --guide` logs a capture failure for the step.

**Fix direction:** intersect `rect+pad` with the viewport and skip the crop when empty.

**Plan note (Batch B):** change `cropBox` to return `Box | null` (null on empty intersection) and have
the caller skip. **`test/guide.test.ts:61` pins the current clamping** ("cropBox clamps") — update it
and add the fully-off-viewport case asserting `null`. `render.ts` and `guide.ts` need no change (they
only consume the produced path).

### B11 · TTS cache is poisoned by a truncated `say` clip [code-read]

**Where:** `src/media/tts.ts:55-61` (`saySpeech`) and `:113` (cache lookup).

`say -o` writes the AIFF incrementally; when `execFileSync` hits `SAY_TIMEOUT_MS` (60 s) it kills the
child and throws, leaving a partial `.aiff`. The run fails loudly — but the next run's
`[base + '.mp3', base + '.aiff'].find(fs.existsSync)` treats the truncated file as a valid cache hit
with no size/duration sanity check, and the shortened narration is reused forever.

**Repro:** without `OPENAI_API_KEY` on macOS, make `say` exceed 60 s on a long narration (or kill it
mid-write); re-run `export --narration` — the truncated clip is silently reused.

**Fix direction:** delete `outFile` when synthesis throws (or write to a temp name and rename on
success).

**Plan note (Batch A):** temp-name-then-rename (`.aiff.part` → rename on success) — it also fixes the
"partially written file that exists" variant, which delete-on-throw only half covers. Test seam:
`synthesize()` gains an optional internal runner parameter (defaults to the real `execFileSync`/`fetch`)
so `test/media.test.ts` can inject a throwing runner and assert no `*.part` survives and no final
file appears; respects the existing `SKIP_TTS` convention.

### B12 · An aborted run can record the *previous* run's video as its `output` in the manifest [code-read]

**Where:** `src/commands/export.ts:363-372` (`recordAbandoned`).

```ts
const out = path.resolve(options.output);
...
output: fs.existsSync(out) ? relPosix(path.resolve(outputDir), out) : undefined,
```

The existence check is on the output **path**, not on a file this run produced. If `-o demo.mp4`
already exists from an earlier export and this run aborts before encoding (page crash, `--fail-fast`
waitFor abort), the `aborted` manifest event names the old, unrelated video as its output.
`videoFromManifest` (`guide.ts:78-111`) and build-all's artifact scans can then pick it up.

**Repro:** `export <dir> -o demo.mp4` (succeeds) → run again with a broken selector and
`--fail-fast` → the new `aborted` event lists `output: demo.mp4`.

**Fix direction:** track whether this run actually wrote the output (a flag set in `encodeAndFinish`)
instead of `fs.existsSync`.

**Plan note (Batch A):** a local `encodedOutput = false` in `runExport`, set to true immediately after
the encode call returns (all three branches in `encodeAndFinish`); `recordAbandoned` then requires
`encodedOutput && fs.existsSync(out)`. Test via the live-app fixture in `test/record.test.ts`
(`--fail-fast` + a `waitFor` timeout, with a pre-existing file at `-o`): assert the appended aborted
event carries **no** `output`.

### B13 · `--tail` / `--duration` parsed with bare `parseFloat` — unit suffixes silently change meaning [code-read]

**Where:** `src/commands/export.ts:168-171` and `:178-181`.

`parseFloat("2s")` is `2`. Since `--tail` is in **ms** and the timeline's own `time` grammar accepts
`"2s"`, a user writing `--tail 2s` gets a 2 **millisecond** tail with no diagnostic;
`--duration 5x` silently means 5. The guards only reject `NaN`/negative, not partial parses.

**Repro:** `npx tsx cli.ts export <dir> -o demo.mp4 --tail 2s` — the video ends at the last step.

**Fix direction:** full-match parse like `parseTime` (`schema.ts:274-283`), rejecting anything with a
stray suffix.

**Plan note (Batch A — grammar decision):** `--tail` accepts a bare integer (ms, the documented form)
**or** an explicit-unit time string (`"2500ms"`, `"2.5s"` — the grammar timeline authors already
use); a bare value stays ms per the flag's documentation, so `--tail 2500` does not change meaning.
`--duration` stays strict bare seconds (`/^\d+(\.\d+)?$/`), rejecting `"30s"` with an error naming
the unit — one accepted grammar per flag, no silent unit inference. Implement as small exported
helpers (e.g. `parseTailMs`, `parseDurationS`) so they unit-test without a browser; update both
`--help` strings (regenerates via `npm run docs`).

### B14 · `<vistaro-tour>`: a failed `tours.json` fetch is cached for the life of the page [code-read]

**Where:** `src/tour/app/vistaro-tour.js:122-132`.

```js
VistaroTour._manifests[root] = fetch(root + 'tours.json')
    .then(r => (r.ok ? r.json() : Promise.reject(...)))
    .catch(() => null);
```

The `.catch(() => null)` result is stored in the per-root cache and never evicted. One transient
failure while the first embed loads (offline blip, 502) means every `<vistaro-tour>` with that root, for
the whole session, gets `built = null` and requests the raw wanted device (`vistaro-tour.js:151`) — a 404
blank frame on a phone for a desktop-only tour, with no retry.

**Fix direction:** on failure, `delete VistaroTour._manifests[root]` before returning null so the next
embed retries.

### B15 · `<vistaro-tour>`: `_pending` is a single slot — a queued `goto` is lost [code-read]

**Where:** `src/tour/app/vistaro-tour.js:169-177`.

Before `ready`, `_send` stores `{ type, extra }` — last write wins, not a queue. A host calling
`element.goto(2)` then `element.play()` before the frame boots plays from step 0; `next()` followed by
`pause()` loses the `next()`.

**Fix direction:** keep a small array of pending commands (or merge a `goto` with a later transport
command instead of overwriting).

### B16 · Unknown `scenario` attribute on `<vistaro-tour>` → silent 404 blank frame [code-read]

**Where:** `src/tour/app/vistaro-tour.js:129-131` and `:149-155`.

For a slug that is not in the manifest, `_builtDevices` returns `null` — indistinguishable from
"manifest unreadable" — so `_load` happily sets `src` to `embed-<typo>-desktop.html` → 404 → a blank
620px frame. No `console.error` and no `tourerror` event (the only diagnostic, line 66, covers a
*missing* attribute, not an unknown one). The full shell handles this case (`app.js:51-54`); the
element does not.

**Repro:** `<vistaro-tour src="…" scenario="draft-responce">` → empty frame, nothing in the console from
the element, no `tourerror`.

**Fix direction:** when the manifest loaded but the slug is absent, fire `tourerror`/`console.error`
instead of loading a URL that cannot exist.

### B17 · Space key hijacks focused buttons in the tour shell [code-read]

**Where:** `src/tour/app/app.js:326-331`.

```js
if (/^(INPUT|TEXTAREA)$/.test((e.target || {}).tagName || '')) return;
if (e.key === ' ') { e.preventDefault(); send(playing ? 'pause' : 'play'); }
```

The guard excludes only text inputs. When a `.card`, `.tick`, or `#play-big` `<button>` has focus,
Space is intercepted: `preventDefault()` cancels the button's activation and the handler toggles tour
playback instead. Keyboard users can Tab to a scenario card but cannot activate it with Space.

**Fix direction:** also return early when the target is a `BUTTON` (or only handle Space when the
target is the document body).

### B18 · Big play button click while the scenario loads is silently dropped [code-read]

**Where:** `src/tour/app/app.js:313` (handler), `:293` (veil is visible while loading), `:162`
(`load` → play), `:236` (`ready` → no replay).

`play-big` is clickable while the scenario iframe is still loading, but `send()` posts into
`frame.contentWindow` with no queue — before the bridge script (end of body, after the whole mockup
DOM) has run, the message is delivered to a document with no listener and dropped. `ready` does not
replay the lost click. `vistaro-tour.js` solves exactly this with `_pending` (`:174`); the shell has no
equivalent.

**Repro:** open the tour page and click the big ▶ while the iframe is still fetching — nothing
happens; a second click after boot works.

**Fix direction:** queue commands until `ready` (as the element does), or disable `play-big` until
`ready`.

**Plan note (Batch C):** port the element's `_pending` pattern into the shell's `send()` —
`if (!ready) { pending = { type: type, extra: extra }; return; }`, flushed in the `ready` branch at
`app.js:236`. Queuing beats disabling: a click that works slightly late beats a dead-looking button.

### B19 · Zero-step scenario: the tour protocol goes silent — dead controls [code-read]

**Where:** `src/engine/tour-bridge.js:79` (guard in `advance`), `:102-120` (`seek`), `:122-147`
(`handle`).

With `steps.length === 0`, `play` → `seek(0)` → empty replay chain → `advance(token, 0)` early-returns
(`0 >= 0`) without `emit()` or `post('end')`. The shell has `ready = true` (buttons enabled at
`app.js:294-299`) but every press of play/restart is a no-op forever; an autoplaying embed never
clears `starting`, leaving the veil hidden with no state ever arriving.

**Fix direction:** in `boot`, if `steps.length === 0`, post `end` (or a `state` with `total: 0`)
immediately.

**Plan note (Batch C):** both halves: `boot` posts `end` when `steps.length === 0`, **and**
`handle('play')` replies with `post('end')` on every press against an empty timeline (idempotent), so
buttons stay consistent no matter when the scenario emptied. Shell needs no change — its `end`
handler already settles `playing`/buttons.

### B20 · `build-all`: a reel recorded live with `outputs: ["embed"]` can never succeed [code-read]

**Where:** `src/commands/build-all.ts:254-257` (plan skips `build` for record rows), `:332-336`
(post-run assert demands the embed), `:350-356` (copy).

For `record` rows the plan omits the `build` step, so `build --embed` never runs and
`embed-<device>.html` is never written into `srcDir` — but the post-run assert unconditionally demands
it for any reel whose outputs include `embed`. The row fails every run with
"embed-desktop.html missing", regardless of the recording. (Related: for a **guide** row with
`outputs: ["embed"]`, `build --embed` writes `embed.html` into `srcDir` and only the reel branch at
`:350` ever publishes a copy into the output tree, so the guide's embed is built but never shipped.)

**Repro:** catalog entry `{ "kind": "reel", "outputs": ["embed"], "record": { "url": "…" } }` →
`build-all --only <slug>` fails at the assert every time.

**Fix direction:** run `build --embed` for record rows too (it does not need the recording), or skip
the embed assert/copy for `guide.record` rows; publish the guide embed copy as well.

**Plan note (Batch C):** prefer the **early-refusal** half: `readCatalog` rejects
`outputs: ["embed"]` on a `record` row with a clear message (consistent with how it already rejects
unknown outputs — see the `outputs: ["pdf"]` case in `test/buildall.test.ts:73`), rather than
running `build --embed` for record rows, because a live-only directory has no `index.html` and
`build` would fail there anyway. Separately, extend the publish copy at `build-all.ts:350` from
`reel && outputs.includes('embed')` to any row with `embed` in its outputs, so a guide's embed pair
stops being built-then-dropped. Dry-run test for the refusal; the publish fix rides the existing
catalog tests.

### B21 · `plainText` decodes `&amp;` first — escaped markup is double-decoded into cue text [code-read]

**Where:** `src/media/vtt.ts:21-23`.

```js
.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
```

`&amp;` must be decoded **last**. Decoded first, `&amp;lt;b&amp;gt;` becomes `&lt;b&gt;` and then a
literal `<b>` — text the author escaped to show literally. The result feeds `buildVtt` and guide.html's
`VTTCue` text (`render.ts`), where cue text is parsed as cue markup: the escaped tag becomes a real
bold tag in the rendered subtitle. Output corruption, not an injection (cuesJson is `<`-escaped).

**Repro:** step `subtitle: "Use &lt;b&gt;bold&lt;/b&gt; &amp;amp; care"` → the VTT/cue shows real bold
and a bare `&`.

**Fix direction:** reorder so `&amp;` is replaced after `&lt;`/`&gt;`.

**Plan note (Batch A):** one-line reorder in `plainText`; add a `test/media.test.ts` case feeding
`Use &lt;b&gt;bold&lt;/b&gt; &amp;amp; care` through `subtitleCues` and asserting the literal text
survives. Trivial, but it changes emitted `.vtt` bytes — it's what triggers Batch A's
`OUTPUT_REVISION` bump.

### B22 · Claude provider branch: `content[0]` assumed to exist and to be the whole answer [code-read]

**Where:** `src/providers.ts:98-107`.

```ts
max_tokens: 8000,
...
const block = msg.content[0];
if (block.type !== 'text') throw new Error('Unexpected response type: ' + block.type);
return block.text;
```

(a) an empty `content` array (refusal, or `max_tokens` hit before any block) makes `content[0]`
`undefined` → `TypeError` instead of a readable error; (b) the SDK can split a long answer into
multiple `text` blocks — only the first is returned, so a generated `vistaro.config.json` is silently
truncated mid-JSON; (c) `stop_reason` is never checked, so a `max_tokens` truncation of a long
timeline is reported as success and fails later as a JSON parse error.

**Fix direction:** join all `type === 'text'` blocks, fail with a clear message when there are none,
and surface a non-`end_turn` `stop_reason`.

**Plan note (Batch A):** extract the response-shaping into a pure helper
(`textFromClaudeResponse(msg): string`) so `test/media.test.ts` (or a new `providers` test) can cover
empty content, multi-block joins and `max_tokens` stop reasons without an API key. The `gemini`
branch already returns `.text()` (which concatenates) — leave it alone.

### B23 · `localize` merge never prunes strings of deleted steps [code-read]

**Where:** `src/commands/localize.ts:120-129`.

```ts
writeStrings(targetStringsFile, { ...seed, ...existing });
```

Every key in `existing` survives, including keys whose steps or fields were deleted from the timeline
(the base file is regenerated cleanly at `:91`; locale files accumulate orphans forever). Because keys
are matched by step id, a deleted-then-re-added step id also silently resurrects the outdated
translation instead of the fresh source text.

**Repro:** `localize <dir> fr`, translate, delete a step from `vistaro.config.json`, re-run
`localize <dir> fr` — the removed step's keys are still in `locales/fr/strings.fr.json`.

**Fix direction:** intersect `existing` with `Object.keys(seed)` before merging, and report the
dropped keys.

**Plan note (Batch A):** scope statement for the reviewer: the fix **prunes** keys whose step/field
no longer exists and reports them (`Pruned N keys for steps that no longer exist: …`), but keeps the
current "translator's value wins for surviving keys" contract — a changed base value still does
*not* overwrite an existing translation; surfacing that is `diffStrings`' job (already reported via
the base-file churn message at `localize.ts:92-96`). Changing that contract would be a new feature,
not a bug fix. Test in `test/strings.test.ts` / the localize tests: deleted step's keys vanish,
surviving translations survive.

### B24 · A corrupt `vistaro.manifest.json` silently wipes the whole audit trail [code-read]

**Where:** `src/manifest.ts:21-38` (read with silent fallthrough; non-atomic `writeFileSync`).

A truncated/interrupted write (there is no temp-file rename) or any JSON corruption makes the next
`recordEvent` start from `{ history: [] }` and overwrite the file: every past event — including the
`buildKey`/`contentHash` slots build-all reads (`build-all.ts:286-287`) — is destroyed with no
warning. `localize`'s `locale`/`baseLocale` fields reset too, changing subsequent locale resolution.
The manifest is the documented "record of what was done" (AGENTS.md), so silent loss contradicts the
contract.

**Repro:** truncate `vistaro.manifest.json` to invalid JSON, run `build <dir>`, observe the file now
holds exactly one history event.

**Fix direction:** warn loudly when an existing manifest fails to parse, and write atomically (temp
file + rename).

**Plan note (Batch A):** atomic write = `vistaro.manifest.json.tmp` in the same directory + `renameSync`
(same-volume rename is atomic); on unparsable existing content, rename it aside to
`vistaro.manifest.json.corrupt-<ISO timestamp>` with a stderr warning before starting fresh, so the
damaged file is recoverable instead of silently overwritten. Test in a fast fs test: corrupt the
file, run `recordEvent`, assert the aside exists, the new manifest has one event, and a warning was
printed; plus a crash-safety sanity check that no `.tmp` file is left behind by a successful write.

---

## Low

### B25 · `tours.json` step `index` is 0-based; every other artifact is 1-based [code-read]

**Where:** `src/commands/tour.ts:302-307` (`steps: timeline.steps.map((st, i) => ({ index: i, …`).

`parseTimeline` sets `step.index = i + 1` (schema.ts:313) and guide.json, chapters, manifest events
and `--step N` are all 1-based on it. tours.json publishes the 0-based array position instead —
consistent with the tour-bridge message protocol (which is 0-based by design, `state.index` starts at
-1), but a trap for any consumer correlating tours.json steps with guide.json steps or the manifest.
Currently latent: the shipped shell reads only `stepCount`/`durationMs`.

**Fix direction:** use `st.index`, or document the field as protocol-position explicitly.

**Plan note (Batch A):** use `st.index`. Consumer check done during the audit: `embed.html` has no
step list, the shipped shell reads only `stepCount`/`durationMs` out of variants, and the bridge's
own `state.index` / `ready.steps[].index` stay 0-based as the protocol's native positions — only the
published tours.json changes. No existing test pins the old value (`test/tour.test.ts` asserts only
`steps.length`); add an assertion that the first step's `index` is 1. One sentence in AGENTS.md
(Tours) notes tours.json steps are 1-based like guide.json.

### B26 · `init-config --kind <typo>` silently scaffolds the guide profile [code-read]

**Where:** `src/commands/init-config.ts:53-55`.

`const reel = options.kind === 'reel'` — any other value (`reels`, `Reel`) falls through to the guide
scaffold, exit 0, no warning. The author discovers the mismatch only after authoring against the wrong
template.

**Fix direction:** validate against `['guide', 'reel']` and error otherwise.

**Plan note (Batch A):** reject with exit 1 and a message naming the valid values; the existing
`buildall.test.ts` `cli()` spawn-helper pattern covers it (assert nonzero exit, no file written).

### B27 · `state.timers` grows without bound in driven mode [code-read]

**Where:** `src/engine/runtime.js:883-909` (two `push`es per step), `:592-595` (`typeInto` intervals),
`:1236-1241` (`stop` is the only cleaner).

Every `runStepReady` pushes its travel and press timeouts (and `typeInto` its interval) into
`state.timers`/`state.intervals`; fired timers are never removed, only cleared wholesale by `stop()`.
The driver-driven paths (check/preview/export/record, tour replay) never call `stop()`, so a long
timeline accumulates thousands of stale handles. Memory growth only — cleared timers are no-ops — but
it is the kind of thing a profile shows as steady growth during a long `record`.

**Fix direction:** remove each handle from the array once it fires (or store a generation counter and
compact on each step).

**Plan note (Batch C):** wrap, don't scan: a `setRunTimeout(fn, ms)` helper whose callback removes
its own id (splice by indexOf) before running, used at the `runStepReady` push sites; `typeInto`
removes its interval when it clears it. `stop()` unchanged. Add a test-only debug accessor
(`__vistaro._pendingHandles()` or similar, named with the leading underscore and documented as
non-public) so a browser test can assert the count returns to baseline after a timeline completes —
timing semantics must not move (see Cross-cutting rule 2).

### B28 · `meta.tailMs` accepts negatives — the computed duration can undercut the content [code-read]

**Where:** `src/engine/schema.ts:497-505` (`computeDurationMs`); `validateTimeline` never checks
`tailMs`, and `export.ts`'s `--tail` guard (`:170`) rejects negatives only for the flag, not for
`meta.tailMs`.

`tailMs: -10000` can make `durationMs` shorter than the last step's interaction, clipping the payoff
and desynchronizing chapters/cues (which are clamped to `durationMs`).

**Fix direction:** validate `meta.tailMs >= 0` in `validateTimeline`, or clamp in
`computeDurationMs`.

**Plan note (Batch A):** validate (error), don't clamp — the file's own philosophy is that silent
correction hands back behaviour the config doesn't describe. One `validateTimeline` case +
`test/schema.test.ts` entry; `--tail`'s flag guard at `export.ts:170` already covers the CLI side.

### B29 · `formatTime` rounds sub-100 ms remainders [code-read]

**Where:** `src/engine/schema.ts:285-288`.

`(ms / 1000).toFixed(2)` rounds: 1234 ms prints as "1.23s" in check/preview/manifest messages.
Display-only, but it can make two close steps print identically while debugging timing.

**Fix direction:** `toFixed(3)` (or keep as-is and accept; noted for completeness).

**Plan note (Batch A):** proposed **wontfix** — display-only, and the change would churn every
check/preview/manifest timing line (and any assertions on them) for no functional gain. Struck from
the todo list unless the reviewer says otherwise.

---

## Checked and found clean (so the next agent does not re-audit these)

- **VTT timestamps** (`vtt.ts:11-19`): dot decimal, ms carry, hours, negative guard — correct.
- **`parseTime`/order validation** (`schema.ts:274-288`, `:611`): units, negatives, chronological
  order (equal times allowed) — correct.
- **ffmpeg args** (`ffmpeg.ts`): `-ss`/`-t` before `-i` everywhere (input seek + re-encode =
  frame-accurate); `amix normalize=0` + `adelay` is valid; `listChapters`' regex is pinned by
  `test/export.test.ts`. `cutClip` is synchronous (`spawnSync`), so `guide.ts:163` calling it without
  `await` is fine.
- **Chapters/subtitle windows** (`chapters.ts:19`, `schema.ts:512-525`): end-clamping and
  `SUBTITLE_MIN_MS` handling — correct.
- **Diff** (`guide/diff.ts`): size mismatch → fraction 1, `pixelmatch` accepts the `undefined` output;
  previousDir cleanup covers `.diff.png`.
- **`applyStrings`** (`strings.ts:91-126`): known/unknown key reporting, `translatable` gating,
  meta.title fallback; the device merge does re-parse `timeMs` when an override replaces `time`
  (`schema.ts:451`).
- **Browser lifecycle in `export.ts`**: inner `finally` closes page/context, outer `finally` closes
  the browser on every path; `runCli`'s timeout/kill double-resolve handling; `reset.ts` bounds.
- **tour-bridge `gapAfter` math** (`tour-bridge.js:52-56`) matches runtime's `leadFor`
  (`min(950, span)` mirrors the lead cap; 450 floor intentional).
- **Embed height reporting** (`app.js:209-214`, `vistaro-tour.js:183-185`): measured from `main`, cannot
  ratchet; file:// origin handling (`UP`/`DOWN`) correct; `vistaro-tour` listener add/remove balanced;
  768px breakpoint consistent between `app.js:131` and `vistaro-tour.js:29`.
- **Tour outDir guards** (`tour.ts:212-225`): root/home/catalog-dir/overlap refusals all present.

## Notes for whoever fixes these

**Superseded — the fixes are implemented.** This section stays for the audit history; see the
Status table above and the Implementation record below for what actually happened.

- B2/B3 are the same root area (device resolution reaching `buildGuide`); they are independent
  failure modes though — B2 also fires via `export --guide`, where B3 does not apply. Implement
  B2's index-based lookups with the prev/next-positional subtlety from its Plan note.
- B4+B5 are one re-entry problem and B6 changes what a seek-replay can rely on; all three land in
  Batch C with their tests written against the same served-scenario-page harness.
- B1 is the sneakiest: it ships as "fast, successful, up-to-date build" while the artifact is wrong.
  It is the first commit of Batch A. (No `OUTPUT_REVISION` bump for B1 itself — the key inputs
  change, which already invalidates the poisoned record rows; see the Cross-cutting rules for which
  batches do bump.)
- Verification probes used during the audit (both re-runnable one-liners): plain `node -e` for B1
  (JSON replacer semantics), and a Playwright `cloneNode`-restore snippet against
  `chromium.launch()` for B6 (listeners lost, scripts not re-run).

## Implementation record (2026-09-19)

Where the landed code diverged from or hardened the plan notes above — read this before reviewing
the diff:

1. **B6 needed a marker the plan did not foresee.** The vistaro-injected script block
   (runtime + bridge + boot) is itself a `<script>` inside `<body>`, so the first version of
   `rerunScripts()` re-executed **it** on restart, re-creating `window.__tour` and re-booting the
   runtime (observed as a second `ready` after `play` and a scheduler whose index read -1 while
   typing ran). Fix: `buildAnimatedHtml`/`buildTourPage` now emit their block with
   `data-vistaro-rerun="false"`, and `rerunScripts()` additionally skips any inline script whose text
   contains `window.__vistaro.boot(` — a belt for tour/reel pages built before the marker existed.
2. **B4/B5's `inFlight` spans more than `runStep`.** `runStep` resolves at the *interaction* (first
   typed character), not at completion, so clearing `inFlight` there made `pause` skip `stop()` while
   typing was still running (caught by the test: the field kept growing). `inFlight` now clears only
   after `settle()` (`whenIdle`), and `seek(n)` sets `index = n` optimistically at its start —
   without that, a `play` queued behind a `goto` re-seeked to the stale pre-seek index.
3. **B14's regression test filters by Referer.** The embed page's own iframe also fetches
   `tours.json`, which masked the element's cache behaviour; the test server counts only requests
   whose Referer is the host page.
4. Delivered as one working tree (no commits made — the repo owner commits); the three
   `OUTPUT_REVISION` steps (2 → 3 → 4) collapsed into a single bump to **4**, which carries the same
   meaning: every cached build key is invalid once. Docs regenerated with `npm run docs`
   (`--tail`/`--duration` help text) and AGENTS.md updated for B4/B5 (protocol), B6 (restart
   contract), B23 (localize pruning).

## Review round (fresh-context reviewer, post-implementation)

An independent reviewer audited the finished diff against this file and returned 7 findings; all 7
triaged as real and fixed in place:

1. **Important — B6 only re-ran top-level `<body>` scripts.** A script nested in a wrapper section
   (the documented "several screens as sections" shape) kept losing its wiring after restart.
   `snapshot()` now collects scripts at any depth, in authored order, and the B6 test covers a
   nested section's wiring end to end.
2. **Low — `play` during the gaps between a seek's instant-replay steps** took the
   `advance(index + 1)` branch, abandoning the seek half-done and skipping the requested step. A
   `seeking` flag now routes such a `play` through `seek(index)`; cleared by `advance()` entry, the
   replay's error path, and `pause`. Regression test: `goto(3)` + `play()` must show step 3 playing.
3. **Low — the shell's `end` handler never cleared `starting`**, so a zero-step autoplaying embed
   would have kept its veil hidden (B19's symptom surviving its own fix). One line.
4. **Nit — the B2 plan-mandated warning** on a captured index matching no timeline step was a silent
   `continue`; it now warns through the command's warn channel.
5. **Nit — docs:** AGENTS.md gained the tours.json 1-based sentence; `build --embed`'s help text now
   says `embed-<device>.html` (the name build.ts has always written for guides too, and which the
   B20 assert/publish depend on); CLI reference regenerated.
6. **Nit — localize prune detection** used prototype-chain `in`; now `Object.hasOwn`.
7. **Nit — manifest quarantine** aside names could collide within a millisecond (counter added);
   the test now asserts the warning is actually printed.
