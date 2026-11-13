# Spike: frame-stepped capture at 60 fps (Lot 5)

**Status:** measured, not merged · **Date:** 2026-11-13 · **Plan:** `docs/next-level-plan.md`, Lot 5

The question from the plan: can a recording be frame-stepped at 60 fps under a controlled clock, instead of Playwright's real-time recorder at a fixed 25 fps? This page records what was measured and ends with a recommendation. Nothing here changes the CLI.

## Method

`docs/spikes/capture-spike.mjs` runs the same timeline (`test/fixtures/basic`, 1280x720, a 6.3 s clip: click, two type steps, two camera moves, a highlight, a fade, a screen swap, subtitles) two ways, twice each, on an otherwise idle machine:

- **A, today:** `cli.ts export`. Playwright records the page in real time; the encode keeps its 25 fps timing.
- **B, frame-stepped:** the self-playing `animated.html` under Playwright's fake clock (`page.clock`: `setTimeout`, `requestAnimationFrame`, `performance.now`, `Date`). Per frame: advance the clock 1/60 s, pin every Web Animation and CSS transition to that virtual time (they follow the compositor's real clock otherwise), take a PNG screenshot, pipe it to ffmpeg.

Reproduce with `node docs/spikes/capture-spike.mjs test/fixtures/basic /tmp/spike` (one browser job at a time).

## Results

| | A: real time, 25 fps | B: frame-stepped, 60 fps |
|---|---|---|
| Frames for the clip | 200-201 | 378 (exactly 6.3 s x 60) |
| Frame interval, mean / sd / max | 40 / 0 / 40 ms | 16.67 / 0 / 16.7 ms |
| Repeated (frozen) frames | 20 in run 1, 1 in run 2 | 28 in run 1 (counted once; at 60 fps the holds between steps and the tail are runs of identical frames, so this is content, not stalls) |
| Wall time | 10.6 s | 15.0-15.5 s (about 2.4x the clip at 720p, screenshots dominate) |
| Identical frames between two runs | 0% (real-time sampling never lines up) | 53% of screenshots byte-identical |

What the numbers say:

1. **The timing problem is solved by a controlled clock.** B's output is a strict 60 fps grid regardless of load: no frame is ever late, and the 20 frozen frames A produced in its first run (a stall while the machine was busy, the cause of the timeouts `AGENTS.md` warns about) cannot happen, because nothing advances until the frame is taken. Motion is 2.4x smoother by frame count alone, and motion blur becomes possible (render N sub-frames, average them) without touching the page.
2. **It costs wall time, not quality.** About 2.4x real time at 1280x720 on this machine; screenshots dominate, so 1920x1080 should land near 5x (2.25x the pixels). Acceptable for `build-all` and CI, where an export is not watched live; a guide's frames are already captured in step mode, so their cost does not change.
3. **Determinism is not there yet, and the reasons are specific.** Diffing the two B runs frame by frame:
   - The subtitle chip's entry animation (`anim-cli-subFade`) differs from frame 0: it is a CSS keyframe animation the runtime restarts by resetting `style.animation`, so its start is resolved by style recalc in real time, and pinning it at "first seen" does not erase the difference.
   - The page drift (a 16 s CSS transition on `<body>`), the cursor's CSS transition and the spotlight's position transitions have the same shape: started by a style change, so their start time is the compositor's.
   - The caret blink and `scroll-behavior: smooth` run on real time and are not Animation objects at all. Turning drift off, hiding the caret and forcing `scroll-behavior: auto` did **not** raise the identical share (171 differing frames instead of 162): the CSS-started chrome is the dominant source, not those.
   - Once a clip's motion has settled (frame 200 onward here) the frames are byte-identical between runs: the pipeline itself is deterministic.

## Constraints checked

- CSS transitions, CSS animations and the Web Animations API can all be driven from the virtual clock, but only by pinning them; the reliable form is an animation the runtime creates itself with a known start (`element.animate(...)` at a virtual time), not one a style change implies.
- `requestAnimationFrame`, timers and `performance.now()` follow `page.clock` with no change to the runtime.
- **Live pages (`record`) are out of scope**, as the plan expected: a real app's network responses, its own timers and its server do not follow a virtual clock, and pausing the clock would stall the app's own loading.

## Recommendation: go, behind a flag, in two steps

1. **`export --fps 60` (frame-stepped), mockups only** -- 2 to 3 days. The spike's loop moved into `export`: fake clock, per-frame pin, PNG to ffmpeg, the existing trim/chapters/VTT logic fed from virtual timestamps (exact, so the first-paint trim disappears). Default stays the real-time recorder; `record` refuses the flag. Tests: a strict 60 fps grid (pts deltas), the clip length to the frame, the existing export assertions under the flag.
2. **Deterministic frames** -- 2 to 3 more days. Move the runtime's own chrome (cursor glide, spotlight moves, subtitle fade, drift, scroll) from CSS transitions/keyframes to `element.animate()` started at known times, and hide the caret during capture. Target: byte-identical frames between two runs of the same timeline, which makes `build-all --diff` exact and lets CI compare videos, not just guide stills.

Motion blur (sub-frame accumulation with ffmpeg `tmix`) is a small follow-up once step 1 lands. Estimate for both steps with tests and docs: about one week.
