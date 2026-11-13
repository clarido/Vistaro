# Next-level plan: professional-grade motion, brand control and showcase

**Status:** Lots 0-4 implemented, Lot 5 spiked (`docs/spikes/capture-quality.md`: go, behind a flag), Lot 6 engine side done (`showcase.catalog.json`; the website part is listed in `docs/website-showcase-note.md`) · **Owner:** JF · **Written:** 2026-11-12

**Open decisions as taken** (defaults, each reversible): 1. Lot 5 ran after Lot 4; 2. the shared-element morph is cut; 3. the brand file is wherever a timeline points (`meta.brand` takes a path; a tour catalog takes `brand` too), so it can be per repo or per catalog; 4. no music is bundled, the author brings the file; 5. `overlay` is a new action (discoverable through `capabilities`), and the studio palette also offers it as presets.

This is a plan, not a manual. Nothing described here exists yet unless the « Where we are » section says so. `AGENTS.md` stays the only source of truth for what the CLI can do today; each lot below updates it when it lands.

## Goal

Make the output look like it came from a professional motion team, and let a product manager ship and maintain demos without an engineer. The test for every item: does it raise the quality of what is produced, or remove a reason to ask someone else for help?

## Where we are (verified in the code on the date above)

| Area | Today | Source |
|---|---|---|
| Screen transitions | Two: `fadeIn`, and `transitionScreen`, which fades the old screen fully out and then the new one in. The default is 0.8 s, against a 200–400 ms norm for UI motion, and the sequential fade leaves a beat of empty background | `src/engine/runtime.js` (`transitionScreen`) |
| Studio presets | 7 reveals, 3 camera moves, 2 transitions, no exits | `src/studio/app/presets.json` |
| Easings | 7 named curves | `EASING_NAMES` in `src/engine/schema.ts` |
| Cursor | A fixed 0.8 s CSS transition whatever the distance | `CURSOR_CSS` in `src/engine/runtime.js` |
| Brand control | Tours have a `theme` map; videos and reels have none (spotlight colour, caption style and cursor are fixed) | `AGENTS.md`, Tours |
| Capture | Playwright's recorder, fixed 25 fps, real time | `src/commands/export.ts` (« Playwright records at a fixed 25fps ») |
| Agent-facing docs | Only the CLI reference is generated from code. The actions, step fields, `meta` fields and easings tables in `AGENTS.md` are hand-written | `scripts/gen-cli-reference.ts` |
| Cloud | Per-step analytics, draft review links, lead capture, stale-guide webhooks and versioned releases already exist | `saas/lib/cloud/` |

The cloud row is why review, approval and analytics are **out of scope** here: they are built. This plan covers the engine, the studio, the documentation and the website.

## Rules every lot follows

These come from `docs/testing-discipline.md` and are restated so a session reading only this file does not miss them.

1. One lot is one landing: a cleared file list before any code, and JF's go to commit.
2. A failing test first, from a real artifact; then a mutation check on every new test.
3. Existing timelines must produce the same output unless the lot says otherwise. New behaviour is opt-in through a new field or value.
4. A lot that changes what a build emits bumps `OUTPUT_REVISION` in `src/commands/build-all.ts`.
5. A constant added to `runtime.js` or `tour-bridge.js` is mirrored in `schema.ts` and covered by `test/constants.test.ts`. Both files stay import-free.
6. Every new action or transition has an instant path, because a tour seeks by replaying earlier steps with `{instant: true}`.
7. One browser-driven job at a time.

### Documentation is part of « done »

A lot is not finished until an agent that has never seen the change can discover and use it. For each lot:

- [ ] The generated capability tables are regenerated (`npm run docs`) and `npm run docs:check` exits 0.
- [ ] `AGENTS.md` prose covers anything that is not guessable from a table: defaults, constraints, what fails silently.
- [ ] The usage guide in `cli.ts` and `README.md` mention the feature if it changes the workflow.
- [ ] `website/llms.txt` is updated.
- [ ] The studio inspector's field registry (`src/studio/app/studio.js`) knows the new fields, and the palette offers the new presets.
- [ ] `init-config` scaffolds use the new feature where it is the better default.
- [ ] A worked example exists in a fixture or a showcase timeline.

## Sequencing

| Lot | What | Depends on |
|---|---|---|
| 0 | Capability reference | — |
| 1 | Motion tokens and brand kit | 0 |
| 2 | Transition set | 1 |
| 3 | Cursor and camera polish | 1 |
| 4 | Audio and channel presets | 0 |
| 5 | Capture quality spike | — (run after 4 unless smoothness is the main complaint) |
| 6 | Website showcase | 1–4 |

Lots 2, 3 and 4 touch different parts of the engine and can be worked by separate sessions, but lots 2 and 3 both edit `runtime.js`, so they land one after the other.

## Lot 0: capability reference

**Problem.** An agent learns what is available from `AGENTS.md`. Most of that file is hand-written, so a new action can ship without the manual knowing about it.

**Change.**

- A `capabilities` command. Plain output for people, `--json` for agents. It lists: actions (with whether a target is required and when the guide frame is taken), step fields, `meta` fields, easings, transitions, studio presets, brand and motion tokens, devices, subtitle placements.
- The data comes from one registry in `src/engine/schema.ts` plus `src/studio/app/presets.json`. Descriptions move into the registry so the tables and the command cannot disagree.
- `scripts/gen-cli-reference.ts` also generates the actions, step fields, `meta` fields and easings tables in `AGENTS.md` between markers, the way it generates the CLI reference today.
- The hub's `/agents.md` already serves the manual, so it picks this up with no further work; confirm with a test.

**Files.** `cli.ts`, `src/commands/capabilities.ts` (new), `src/engine/schema.ts`, `scripts/gen-cli-reference.ts`, `AGENTS.md`, `README.md`, `test/docs.test.ts`, `docs/testing-discipline.md` (inventory row).

**Tests.** A canary: every member of `ACTIONS`, `EASING_NAMES` and the step-field registry appears in the generated block and in `capabilities --json`; a planted action missing a description goes red; an empty registry goes red. The studio registry is compared with the schema registry so the two cannot drift.

**Risk.** Moving the hand-written tables into generated blocks loses nuance. Keep the prose sections (« What is not guessable », the reel constraints) hand-written; only the tables are generated.

## Lot 1: motion tokens and brand kit

**Problem.** Every demo picks its own durations and curves, and a video cannot wear a customer's colours.

**Change.**

- `meta.motion`: named durations (`fast`, `base`, `slow`) and a default easing. Any action without an explicit `duration` or `ease` reads from it. Unset, the values are today's, so nothing moves.
- `meta.brand`: `accent` (spotlight and ripple), `caption` (font, colours, radius), `cursor` tint, optional `logo`, optional `intro` and `outro` cards (title, subtitle, duration).
- A shared brand file that several timelines point at, so a team sets its brand once. Tours' existing `theme` keeps working and reads the same tokens where they overlap.
- Values go in verbatim, as with the tour theme. `check` warns on an unknown token and on a caption contrast ratio below 4.5:1.

**Files.** `src/engine/schema.ts`, `src/engine/runtime.js`, `src/engine/inject.ts`, `src/commands/check.ts`, `src/commands/init-config.ts`, `src/studio/app/studio.js`, `test/schema.test.ts`, `test/browser.test.ts`, `test/constants.test.ts`.

**Tests.** A timeline with no `meta.motion` and no `meta.brand` renders the same frames as before (pixel comparison on the `basic` fixture). A branded timeline's spotlight reads the accent from its inline style (not `getBoundingClientRect()`, per the spotlight rule).

## Lot 2: transition set

**Change.** `transitionScreen` gains a `transition` field. Omitted, it behaves exactly as today.

| Value | Behaviour | Use |
|---|---|---|
| `fade` | Today's sequential fade (default) | Backward compatibility |
| `cut` | Instant swap | The professional default between unrelated screens |
| `crossfade` | Old and new overlap, no empty beat | Related screens |
| `slide` | New screen slides in over the old; `direction` left, right, up, down | Forward and back navigation |
| `push` | New screen pushes the old one out; same `direction` | Tabs, steppers, mobile navigation |

New actions for the overlay patterns that are hand-built with `animate` today:

- `overlay`: reveals a modal, drawer, sheet or toast (`variant`), with an optional scrim, and `dismiss` to reverse it.

Studio palette: exit presets matching the seven reveals, and the new transitions.

Last and optional: a shared-element morph between two targets. Cut it unless a showcase clip needs it.

**Checks.** `check` warns when a transition's incoming screen is not pre-hidden (the same rule as `animate` reveals), when `direction` is set on a transition that ignores it, and when a `slide` or `push` runs under an active camera push.

**Files.** `src/engine/schema.ts`, `src/engine/runtime.js`, `src/engine/tour-bridge.js` (only if seeking needs it), `src/commands/check.ts`, `src/studio/app/presets.json`, `src/studio/app/studio.js`, `test/fixtures/basic/`, `test/browser.test.ts`, `test/tour.test.ts`, `test/schema.test.ts`.

**Tests.** Per transition: the end state is identical whichever transition was used (same DOM visibility); the instant path reaches the same state; a tour seek back and forward across the step leaves the right screen showing; `prefers-reduced-motion` falls back to `cut`. Guide frames are still taken at completion.

## Lot 3: cursor and camera polish

- **Cursor travel scaled to distance**, within a floor and a ceiling, with a slight arc on long moves. The lead before a step (`min(950 ms, …)`) stays the upper bound so timelines keep their timing.
- **`camera` gains `follow`**: the camera tracks the next interaction target on its own, so a demo gets the auto-zoom look without a camera step per interaction. Off by default; it respects the no-crop bound documented under « Authoring a reel ».
- `check --trace` records the cursor path and the follow window per step.

**Files.** `src/engine/runtime.js`, `src/engine/schema.ts`, `src/commands/check.ts`, `test/browser.test.ts`, `test/constants.test.ts`.

**Tests.** A short hop and a long hop take measurably different times; neither exceeds the lead. With `follow` on, the trace shows each target inside the camera window at its step's time.

## Lot 4: audio and channel presets

- **Audio**: optional click sound and music bed (`meta.audio`), ducked under narration, with loudness normalised on the final mix. Reels stay silent unless they opt in.
- **Aspect presets**: `--aspect 16:9|1:1|9:16` on `export`, as a shorthand over width and height, valid in the catalog.
- **Burned-in subtitles**: `--burn-subtitles` for channels that do not read a `.vtt`.
- **Transcript**: a plain-text transcript beside the `.vtt`, for accessibility and search.

**Files.** `src/media/ffmpeg.ts`, `src/commands/export.ts`, `src/commands/build-all.ts`, `src/catalog.ts`, `cli.ts`, `test/media.test.ts`, `test/export.test.ts`.

**Tests.** Real ffmpeg encodes, per the discipline: the mixed file has one audio stream at the target loudness; a reel without `meta.audio` still has none; each aspect preset produces the stated dimensions. Any new spawn carries its timeout and joins the spawn canaries' lists.

## Lot 5: capture quality spike

**Question.** Can the recording be frame-stepped at 60 fps under controlled time, instead of real-time at a fixed 25 fps?

**Why it matters.** 25 fps caps smoothness, rules out motion blur, and ties the output to how busy the machine is, which is the source of the timeouts noted in `AGENTS.md`.

**What the spike produces.** A measurement, not a merge: the same timeline exported both ways, with frame-timing variance, encode time, and whether two runs give identical frames. It ends with a written go or no-go and an estimate.

**Constraints to test.** CSS transitions, the Web Animations API and `requestAnimationFrame` all advance under the controlled clock; live pages (`record`) are probably out of scope because a real app's network does not follow a virtual clock.

## Lot 6: website showcase

**Goal.** Show each new capability on vistaro.dev with a clip the tool made itself, so the site proves the claim.

**Change.**

- A showcase set in `reels.catalog.json` (or a new catalog beside it): one short clip per capability — transitions, brand kit, auto-zoom, vertical format, audio. Built by `build-all`, so they rebuild when the engine changes instead of going stale.
- A gallery on `website/animations.html`: each clip beside the timeline snippet that produced it, with a copy button.
- A row in the home page's outputs section (`website/index.html`) linking to the gallery.
- `website/sitemap.xml` and `website/llms.txt` updated.
- The `deploy-website` job in `.github/workflows/test.yml` builds the set; `test/ci-workflow.test.ts` must still pass.

**Standards.** Posters in WebP, `preload="none"`, captions on, a poster-only fallback under `prefers-reduced-motion`, no autoplay with sound, and a page-weight budget agreed before building.

**Tests.** Every clip the gallery references exists after the build; the showcase timelines pass `check` with no warnings.

## Open decisions for JF

1. **Lot 5 timing.** It may take as long as the other lots combined. Default: after lot 4. Move it first if smoothness is the main complaint from viewers.
2. **Shared-element morph.** Default: cut.
3. **Brand file location.** One file per repo, or per catalog?
4. **Music bed licensing.** Ship none and let the customer bring a file, or bundle a small licensed set?
5. **Naming.** `overlay` as a new action, or as `animate` presets only? A new action is discoverable; presets add nothing to the schema.

## Out of scope

- Review, approval, analytics and lead capture: already in `saas/lib/cloud/`.
- Free-form keyframing and editing rendered pixels: ruled out by the studio brief's guardrails.
- PII redaction on live recordings: worth doing, but it is a `record` feature with its own risks and deserves its own plan.
