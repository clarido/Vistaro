# Agent manual: Screenshot Animator CLI

This is the manual for an AI agent (Claude Code, Codex, Antigravity) or a person driving the CLI. It turns a **screen** (`index.html`) plus a **timeline** (`anim.config.json`) into a demo **video** (MP4 + subtitles + chapters, optional narration), a **step-by-step help guide** (`guide.json` / `guide.md` / `guide.html` + frames), and the same for **every language**, and it can do that against a **live web page** instead of a mockup. The same engine also produces **marketing reels**: short, silent, looping product clips for a homepage, shipped as video or as an embeddable page. `help.catalog.json` + `build-all` produce a whole help site's worth of guides in one command.

You are the LLM. You write the screen and the timeline yourself; the CLI needs **no API key** for anything below except the optional `extract`/`animate` commands.

## Setup

```bash
npm install
npx playwright install chromium
```

Node >= 20.6. TypeScript runs through `tsx` (no build step). ffmpeg is bundled (`ffmpeg-static`). Narration uses `OPENAI_API_KEY` when set, else macOS `say`.

## Workflow

Every command below prints what it wrote; `npx tsx cli.ts --help` and `npx tsx cli.ts <command> --help` are the reference.

1. **Write the screen.** Put a faithful mockup of the UI in `<dir>/index.html` (inline CSS, real element ids/classes; when the user pasted screenshots, reproduce each one; several screens can live in one file as sections you fade between). Media files referenced from `index.html` go next to it.
2. **Write the timeline.** `npx tsx cli.ts init-config <dir>` scaffolds `<dir>/anim.config.json` in object form; edit it to match your selectors. Give every step an explicit `id` (translations and guide frames attach to it) and every numbered step a `title` (its heading in the guide); keep a guide to about ten numbered steps and hide choreography with `"guide": false`.
3. **Check.** `npx tsx cli.ts check <dir>` validates the schema and timing statically, then replays the timeline in a headless browser and probes every target right before its step (missing, hidden, 0x0, clipped, off-screen). Fix errors; read the warnings.
4. **Build.** `npx tsx cli.ts build <dir>` writes `<dir>/animated.html`, a self-playing page with the cursor, spotlight, ripple, camera and subtitles injected, for humans to open in a browser (run `build` again after editing `index.html`; it is a generated file, not tracked). `export` does not read it: with an `anim.config.json` present it always records `index.html` with the runtime injected, so the video can never disagree with `check`/`preview`.
5. **Preview and iterate.** `npx tsx cli.ts preview <dir>` writes `<dir>/preview.png`, one labelled frame per step (`--step N` writes a single full-size `preview-step-N.png`). **Read the PNG** with your image tool, fix the timeline (a badly placed camera, a subtitle that overlaps, a step that fires too early), and repeat 3 to 5 until the frames look right.
6. **Export.** `npx tsx cli.ts export <dir> -o demo.mp4 --guide --narration` records the video (length computed from the timeline plus `meta.tailMs`), writes `demo.vtt`, embeds chapters for titled steps, mixes the narration, then captures the guide into `<dir>/guide/`. `--clips mp4` also cuts one clip per step; `--clips gif` keeps the master's full size on purpose, which is about 1.9 MB per 2 seconds at 1920x1080, so pick `mp4` unless a clip has to be a GIF. A `.gif` output skips audio, chapters and subtitles.
7. **Localize.** `npx tsx cli.ts localize <dir> fr` scaffolds `<dir>/locales/fr/` and a pre-filled `strings.fr.json`; translate the strings and the visible text of the copied `index.html`, then `check`, `build`, `export` that directory. See [Localization](#localization).
8. **Build everything.** Describe the guides once in `help.catalog.json` and run `npx tsx cli.ts build-all --changed-only --diff`. See [Catalog and build-all](#catalog-and-build-all).

For a **live app** replace steps 1 and 4 with selectors in the real page and use `record` instead of `export`. See [Live pages](#live-pages).

For a **marketing reel** set `"kind": "reel"` in `meta`. The guide chrome and the guide validations switch off, so steps need no `title` and the ten-step guideline does not apply; write the motion instead, mostly `animate` and `camera`. Step 6 loses `--guide` and `--narration` and ships an MP4, a WebM, a poster and a GIF in one command; step 4 gains `--embed` for the looping page. Steps 7 and 8 are unchanged, and one responsive mockup covers both form factors through `--device` plus per-step `mobile`/`desktop` overrides and `only`. **Read [Authoring a reel](#authoring-a-reel-four-constraints-that-are-not-guessable) before you write the screen**: all four constraints there fail silently, producing a plausible-looking clip that is wrong.

For an **interactive tour** -- a demo canvas with a rail of scenarios the visitor picks from, each playing step by step with play/pause and per-step navigation -- keep the timeline exactly as it is and replace steps 4 to 6 with `npx tsx cli.ts tour`. Nothing is captured and nothing is encoded: a scenario page is the mockup itself with the runtime and the tour scheduler injected, so it stays crisp at any size and weighs what its HTML weighs. Several scenarios normally share one screen; see [Tours](#tours).

Cinematic polish is built in: click/focus/type/highlight/hover steps get a glowing spotlight on the target and a click ripple, `camera` pushes in on an element, `scroll` brings it into view, the cursor glides with a slight drift, and subtitles are drawn as an overlay. There is nothing to paste into `index.html`. A reel turns the spotlight, ripple and subtitle bar off and carries its motion with `animate` and `camera` instead; set `"cursor": "none"` too unless the clip is demonstrating a click.

## Timeline: `anim.config.json`

Object form (a bare array of steps is still accepted):

```json
{
  "meta": { "title": "Create your first report", "slug": "create-first-report", "app": "My App", "locale": "en", "cursor": "mac", "tailMs": 2500 },
  "steps": [
    { "id": "intro",  "time": "0s",   "action": "fadeIn", "target": "body", "title": "Overview", "subtitle": "Welcome to the dashboard.", "narration": "Start on the dashboard to review your reports." },
    { "id": "open",   "time": "2s",   "action": "click", "target": ".btn-primary", "title": "Open the report builder", "subtitle": "Click the primary button to begin.", "note": "The button is in the top-right corner." },
    { "id": "prompt", "time": "3.5s", "action": "type", "target": ".chat-input", "value": "Generate a report", "title": "Describe the report", "translatable": true },
    { "id": "zoom",   "time": "5.5s", "action": "camera", "target": ".chat-input", "scale": 1.3, "duration": 2, "guide": false },
    { "id": "notice", "time": "8s",   "action": "highlight", "target": "#status", "title": "Watch the status" },
    { "id": "result", "time": "10s",  "action": "transitionScreen", "target": "#screen2", "duration": 0.8, "title": "Review the result" }
  ]
}
```

### `meta`

| Field | Meaning |
|---|---|
| `title` | Guide title (H1 of `guide.md`, `<title>` of `guide.html`, `meta.title` string key). |
| `slug` | Identifier used in `guide.json`; defaults to the directory name. |
| `app` | Application name shown in the guide. |
| `url` | Default page for `record` (live pages). |
| `locale` | Language of the inline text (default `en`). |
| `tailMs` | Hold after the last step, default 2500 (`--tail` overrides). |
| `cursor` | `mac`, `windows` or `none` (default `mac`). |
| `resetFocusStyles` | Before each step, reset every `.input` and `button` in the page to fixed light colours (border `#E2E8F0`, no shadow, `#FAFAFA` background, `#3B82F6` for `.btn-primary`): a crutch for mockups built with those classes, not a general focus-outline reset. |
| `drift` | Slight page drift while the cursor glides (default on for mockups; off on live pages, where a transformed `<body>` can break a real app's fixed layout, unless `"drift": true`). |
| `voice` | `{ "openai": "alloy", "say": "Samantha" }` narration voices per engine. |
| `kind` | `guide` (default) or `reel`. A reel is a silent marketing clip: no spotlight, ripple or subtitle bar, no guide-shaped validation, and `--guide` on it is an error. |
| `reel` | Overrides of whatever `kind` implies: `spotlight`, `ripple`, `subtitles`, `loop` (booleans), `autoplay` (`immediate`, `inview`, `message`), `poster` (`last` (default), `first`, or a time such as `"3.2s"`). An explicit value always beats the profile default. |
| `reset` | Live pages: a shell command run before each pass over the app (the recording, then the `--guide` replay), e.g. `"npm run db:seed"` or `"curl -X POST http://localhost:3000/api/test/reset"`. It runs in the shell, in the CLI's working directory, so a timeline is executable content: it runs only when you pass `--allow-reset`, and the command refuses rather than silently skipping a reset the timeline depends on. `--reset-cmd` gives your own command instead and never needs the flag. See [Live pages](#live-pages). |

### Steps

| Field | Meaning |
|---|---|
| `id` | Stable identifier. Strings files and guide frames attach to it; auto ids (`step-03`) shift when a step is inserted, so `check`/`localize` warn about them once a strings file exists. |
| `time` | **Moment of the interaction** (the click, the first typed character, the highlight pulse): `"2s"`, `"2000ms"` or a number of seconds. The cursor starts travelling up to 950 ms earlier (lead = min(950 ms, gap to the previous step, time)). Steps must be in order. |
| `action` | See the table below. |
| `target` | CSS selector. Required for click, focus, type, highlight, hover, scroll, fadeIn, transitionScreen. A 0x0 target (an empty caret span) is spotlighted through its sized ancestor. |
| `value` | Text for `type` (typed at `cps` characters per second, default 25) or the key for `press` (`Enter`, `Tab`, `Control+K`). |
| `title` | Step heading in the guide and the chapter name in the MP4. Every numbered guide step needs one: `check` warns, and `guide` / `export --guide` / `record --guide` refuse without it (the fallback verbs are English and would leak into a localized guide). Hide choreography steps with `"guide": false` instead. |
| `subtitle` | Shown in the video's subtitle bar from `time` until the next subtitle (held at most 4 s, at least 1 s) and written to the `.vtt`; also the narration text when `narration` is absent. `null` clears the bar. |
| `narration` | Text spoken at `time` with `--narration` (mixed into the MP4). |
| `note` | Extra sentence under the step in the guide. |
| `translatable` | `true` when `value` is user-visible text that must be translated (it becomes a string key). |
| `crop` | Guide crop padding in px for this step, or `false` for the full frame only. |
| `from` / `to` | `animate`: the start and end state. `x`, `y` (px), `scale`, `scaleX`, `scaleY`, `rotate` (deg) compose into one transform, applied in the order translate, scale, rotate; every other key (`opacity`, any CSS property) is passed through as-is. |
| `all` | `animate`: animate every match of `target`, not just the first. |
| `stagger` | `animate`: seconds between successive elements when `all` is set. |
| `count` | `animate`: how many elements `target` is expected to match, so the length estimate is right. `check` warns when the real count differs. |
| `ease` | Named easing for `animate` and `camera`: `linear`, `easeInCubic`, `easeOutCubic`, `easeInOutCubic`, `easeOutBack`, `easeOutExpo`, `spring`. |
| `spotlight` / `ripple` | `false` suppresses that chrome for this step alone (no ring is shown at all, not merely left where it was). |
| `only` | `"desktop"` or `"mobile"`: the step is dropped entirely for the other device. |
| `mobile` / `desktop` | An object shallow-merged into the step when rendering for that device; the key itself is then stripped. Fields the override omits are inherited. |
| `guide` | `false` hides the step from the guide (it still runs in the video). |
| `captureAt` | Override the guide/preview frame moment: `"interaction"` or `"completion"`. On a `type` step driven from the CLI both show the full text: the driver types through the keyboard and the step's interaction is only over once the last character has landed. |
| `waitFor` | Live pages: a selector to wait for (visible) or a number of ms before the cursor moves; the delay shifts the rest of the timeline. |
| `waitForTimeoutMs` | Live pages: how long a `waitFor` selector may wait before giving up (default 15000). A timeout is reported as a warning naming the step, not as a slow load; `record --fail-fast` abandons the recording at the first one. |
| `url` | `navigate` (live pages): the page to open. |
| `scale`, `x`, `y`, `xOffset`, `yOffset` | `camera`: zoom factor (default 1, a pan without zoom; 1.3 is a typical push-in) and framing; `x`/`y` centre the camera on a point instead of a target, `xOffset`/`yOffset` nudge the framing. |
| `duration` | Seconds. `camera`: length of the pan (default 2.5). `fadeIn`/`transitionScreen`: length of the fade (default: the element's own CSS transition, else 0.8 s). |

### Actions and the guide capture rule

| Action | What happens | Guide frame taken |
|---|---|---|
| `click` | Cursor travels, spotlight, press, ripple, real `el.click()` so the page's own handlers run. | At the interaction (+300 ms settle), spotlight held; a click that hides its own target (a screen swap, a navigation) is captured just before the click instead, and records `capturedAt: "arrival"`. |
| `focus` | Cursor travels, spotlight, `el.focus()`. | Interaction. |
| `type` | Cursor travels, focuses, types `value` character by character. Under `check`/`preview`/`export`/`record`/`guide` the driver types inputs, textareas and contenteditable through the real keyboard (`page.keyboard`), so the app's own key handlers and framework value trackers (React's controlled inputs) see genuine events; plain elements with a caret, and a self-playing `animated.html`, are typed by the page itself through the native value setter. | Completion (full text visible). |
| `highlight` | Spotlight pulse without a click ("notice this"). | Interaction. |
| `hover` | Cursor moves onto the element. | Interaction. |
| `press` | Keyboard key from `value` (no target). | Interaction. |
| `camera` | Pan/zoom the page toward the target (or `x`/`y`); `scale: 1` pulls back. The cursor and the spotlight ride along, staying on the element they were on. | Completion (zoomed framing). |
| `scroll` | Smooth-scroll the target into view. | Completion. |
| `fadeIn` | Reveal the target (display/opacity) with a fade. | Completion. |
| `transitionScreen` | Fade the current screen out and the target screen in. | Completion. |
| `navigate` | Live pages only: open `url`. | Arrival on the new page. |
| `animate` | Animate `target` from `from` to `to` with the Web Animations API (`fill: both`, so the end state persists). With `all` it runs on every match, `stagger` seconds apart. | Completion (all elements settled). |
| `wait` | Nothing visible; a beat, or a subtitle change. | Interaction (the moment of the step). |

Frames of completion-type steps are taken once the CSS animations on the target and the page have finished, so an unedited re-run reproduces the same pixels.

## Outputs

`export <dir> -o demo.mp4 --guide` writes, next to the video: `demo.vtt` (subtitles), chapters inside the MP4, and `<dir>/guide/`:

```
guide/
  guide.json          the contract below
  guide.md            H1, "## N. title", note, image, subtitle quote, video link
  guide.html          the same with the video inline (chapters + cues)
  assets/
    poster.png        first frame (no subtitle bar)
    step-01.png       full frame per guide step, numbered badge + spotlight
    step-01.crop.png  the spotlighted box with `crop` padding (absent when it would be the whole frame)
    step-01.mp4       with --clips (guide --clips; export --clips writes them next to the video instead)
    step-01.mp3       with --narration: the step's spoken narration (.aiff with macOS `say`)
```

Publishing a guide means copying `guide.*` and the whole `assets/` directory: the audio files are referenced from `guide.json` and can be a third of its size.

`--no-marks` keeps the frames clean: the ring and the badge are placed, measured, then removed before the screenshot, so `rect` and `callout` are still recorded but the image is a plain shot of the app. That is what a consumer drawing its own overlay wants -- an interactive tour or a click-through prototype -- where a pre-drawn ring on the frame would fight the hotspot on top of it.

### Reel outputs

`export <reel> -o clip.mp4` on a `kind: "reel"` timeline writes, beside the video, `clip.webm` (VP9, silent), `clip.poster.png` and `clip.gif` (long edge 720px at 15fps, roughly 2.2 to 2.9 MB in either orientation across the eight rows measured, since GIF weight tracks how much of the frame moves rather than its dimensions — the cap is on the **long** edge because a phone reel is portrait, and a 720px *width* would have made the mobile GIF 3.7x heavier than the desktop one it is meant to undercut). Each artifact's dimensions and weight are printed as it is written. The MP4 carries no audio stream, and no `.vtt` or chapters are written. `--narration`, `--voiceover` and `--clips` are warned about and ignored. The poster is the last step's completion by default, the composed payoff frame rather than the empty opening one; `meta.reel.poster` overrides it.

`build <reel> --embed --device <desktop|mobile>` additionally writes `embed-<device>.html`, a self-contained page with no margin or scrollbars, and `embed-<device>.snippet.html`, the parent-side snippet. **The names always carry the device** because a reel is genuinely two deliverables, and an unsuffixed pair would have the second build silently overwrite the first, leaving a desktop page inside a phone-shaped frame.

The embed plays when scrolled into view and loops by restarting in place (the runtime snapshots `<body>` at boot and restores it, rather than reloading). `prefers-reduced-motion: reduce` leaves the mockup in its authored static state and never plays.

### `guide.json` (version 1)

```jsonc
{
  "version": 1, "slug": "create-first-report", "title": "Create your first report", "app": "My App",
  "locale": "fr", "baseLocale": "en", "generatedAt": "2026-09-06T12:00:00.000Z",
  "source": { "dir": "demo", "contentHash": "sha256:…", "tool": "screenshot-animator@2.0.0" },
  "viewport": { "width": 1920, "height": 1080, "deviceScaleFactor": 2, "theme": "light" },
  "video": { "file": "../demo.mp4", "durationMs": 14200, "poster": "assets/poster.png", "subtitles": "../demo.vtt", "narration": true,
             "chapters": [{ "startMs": 2000, "endMs": 3500, "title": "Open the report builder" }],
             "cues": [{ "startMs": 2000, "endMs": 3500, "text": "Click the primary button to begin." }] },
  "steps": [{
    "index": 2, "number": 1, "id": "open", "action": "click", "target": ".btn-primary",
    "scheduledMs": 2000, "actualMs": 2004, "capturedAt": "interaction",
    "title": "Open the report builder", "subtitle": "Click the primary button to begin.", "narration": "…", "note": "…",
    "image": "assets/step-02.png", "crop": "assets/step-02.crop.png",
    "audio": "assets/step-02.mp3", "audioDurationMs": 2400,
    "rect": { "x": 1620, "y": 24, "width": 180, "height": 40 },
    "callout": { "number": 1, "x": 1606, "y": 10 }, "clip": "assets/step-02.mp4"
  }]   // targetRect, clip, audio, error and the crop are omitted when they do not apply
}
```

`index` is the position in the timeline, `number` the guide numbering (steps with `guide: false` are skipped). `actualMs` is measured in the page; `scheduledMs` is what the timeline said. `rect` is the box the spotlight framed (the sized ancestor of a 0x0 target), clamped to the part of it that survives any ancestor hiding overflow, so it matches the ring in the frame; `rect` and `callout` are `null` only for target-less or failed steps. `clip` appears when clips were cut: `export --clips` writes `<video>-step-NN.mp4|gif` next to the video and the guide points at them (`../demo-step-02.mp4`); `guide --clips` cuts them into `assets/`. `audio`/`audioDurationMs` appear when the video was narrated: the step's synthesized narration is copied to `assets/step-NN.mp3` (OpenAI) or `.aiff` (macOS `say`). Paths are relative to the guide directory; `source.dir` is a basename, never an absolute path.

## Localization

Text lives in two places: the visible copy of `index.html`, and the timeline's `title`, `subtitle`, `narration`, `note` and translatable `value` strings. The second set is externalized into flat `strings.<locale>.json` files:

```json
{ "meta.title": "Créer votre premier rapport", "steps.open.title": "Ouvrir le générateur", "steps.open.subtitle": "Cliquez sur le bouton principal.", "steps.prompt.value": "Générer un rapport" }
```

`npx tsx cli.ts localize <dir> fr`:
- regenerates `<dir>/strings.en.json` (the base locale) from the inline text and lists keys that changed since the last run;
- creates `<dir>/locales/fr/` with `index.html`, `anim.config.json` and the media `index.html` references, plus `strings.fr.json` pre-filled with the source text;
- re-running keeps the translator's `index.html`, `anim.config.json` and translations, adding new keys only (`--force` overwrites and says which files it replaced).

Then translate `strings.fr.json` and the visible text in `locales/fr/index.html`, keeping ids/classes unchanged, and run `check`, `build`, `preview`, `export` on `<dir>/locales/fr` as usual. Every command applies the strings file for the directory's locale, resolved as `--locale` > `anim.manifest.json` `locale` > `meta.locale`. Never edit `time`/`action`/`target` in a locale: the choreography is shared.

`--sibling` scaffolds the legacy `<dir>/../fr/` layout instead; `build-all` finds both, and an explicit `{ "fr": "path" }` map in the catalog wins over both.

**Reels localize the same way**, and steps 7 and 8 of the workflow are unchanged for them. A reel has less to translate, because it carries no `title`, `subtitle`, `narration` or `note`: its strings file is usually just `meta.title` plus any `translatable` typed `value`, and the rest of the copy lives in the locale's `index.html`. Two things to watch when you translate the screen. Localize the number and currency formats too, not only the words (`$2.4M` becomes `2,4 M$`, `31%` becomes `31 %`), since a marketing clip that shows American formatting to a French visitor reads as a translated American product. And leave room for text expansion: French runs roughly 15 to 20% longer than English, so a paragraph that fits on three lines in the base locale may take four, which changes the height of anything a `camera` step frames. `reels/ask-anything/locales/fr` is a worked example.

## Catalog and build-all

`help.catalog.json` lists the guides; `npx tsx cli.ts build-all` runs `check` → `build` → `export --guide` (or `check --live` → `record --guide`) for every guide × locale into `<outputDir>/<slug>/<locale>/` and merges `index.json` + `index.md` at the root of `outputDir`. `npx tsx cli.ts build-all --help` prints the full schema.

```json
{
  "outputDir": "help-out",
  "defaults": { "locales": ["en", "fr"], "outputs": ["guide"], "width": 1920, "height": 1080, "theme": "light", "narration": false, "crop": 120 },
  "guides": [
    { "slug": "draft-proposal-response", "dir": "demo", "title": "Draft a proposal response" },
    { "slug": "live-save", "dir": "live/save", "record": { "url": "https://app.local/save", "storageState": "auth.json" } }
  ]
}
```

- Paths are relative to the catalog file. `outputDir` may not be `/`, the home directory, the catalog directory, or overlap a guide directory. Every default is also valid per guide (the guide wins). `outputs` are the extras: `guide` (default for a guide), `gif`, `clips`, `webm`, `poster`, `embed`; the video is always produced and never listed as an output.
- A guide entry may set `kind: "reel"`, whose default outputs are `["webm", "poster", "gif"]` and which produces no guide. `devices: ["desktop", "mobile"]` expands it to one row per device, sharing `<slug>/<locale>/` with the device in every filename (`ask-anything-en-mobile.mp4`, `embed-mobile.html`). Render settings gain `device` and `scale`, both valid in `defaults` and per guide.
- The manifest key is the plain locale for a guide and `<locale>:<device>` for a device-expanded row, so manifests written before reels existed stay valid.
- `--changed-only` skips a guide × locale whose **build key** (content hash of `index.html`, `anim.config.json`, `strings.*.json` and referenced media + the effective render settings + the tool version) matches `buildKey[locale]` in its manifest and whose video still exists on disk. Changing a width in the catalog rebuilds; editing `locales/fr` rebuilds only `fr`.
- `--diff` keeps the previous step frames in `guide/.previous/`, compares them pixel by pixel with the new ones and marks the entry `stale` above `--diff-threshold` (default 2%), with `step-NN.diff.png` next to the previous frames.
- `--only <slug>` / `--locale <code>` build a subset; the other entries keep their previous index rows. `--dry-run` prints the plan and writes nothing. Failures mark the entry `failed`, exit 1, and stop unless `--continue-on-error`.

### `index.json` (version 1)

```jsonc
{ "version": 1, "generatedAt": "…", "tool": "screenshot-animator@2.0.0", "catalog": "../help.catalog.json",
  "guides": [{ "slug": "draft-proposal-response", "locale": "fr", "title": "…", "dir": "demo", "output": "draft-proposal-response/fr",
               "status": "ok", "builtAt": "…", "contentHash": "sha256:…", "buildKey": "sha256:…",
               "video": "draft-proposal-response/fr/draft-proposal-response-fr.mp4", "vtt": "…/draft-proposal-response-fr.vtt", "gif": "…", "poster": "…/guide/assets/poster.png",
               "guide": "…/guide/guide.json", "guideMd": "…/guide/guide.md", "guideHtml": "…/guide/guide.html",
               "durationMs": 14200, "steps": 5, "ms": 41000,
               "stale": false, "diff": { "maxFraction": 0.001, "threshold": 0.02, "steps": { "step-02": 0.001 } } }] }   // stale/diff only with --diff; error only on failed entries
```

Paths are relative to `outputDir`. `status` is `ok`, `failed` (with `error`) or `skipped` (unchanged; links, `builtAt` and `stale` carried from the last build).

## Tours

`npx tsx cli.ts tour [catalog]` turns `tour.catalog.json` into a self-contained tour site: a shell that lists the scenarios and a canvas that plays the one you pick.

```json
{
  "outputDir": "tour-out",
  "product":  { "name": "Clarido", "tagline": "Proposal writing for public-sector bids", "accent": "#2f6bff" },
  "rail":     { "title": "What would you like to see?", "subtitle": "Pick a scenario and it plays on the left." },
  "groups":   [{ "id": "writing", "label": "Writing a response" }],
  "defaults": { "width": 1920, "height": 1080, "locale": "en" },
  "scenarios": [
    { "slug": "draft-response", "dir": "demo", "label": "Draft a response", "blurb": "...", "group": "writing" },
    { "slug": "export-word", "dir": "demo", "config": "demo/scenarios/export-word.json", "label": "Export to Word" }
  ]
}
```

Output: `<outputDir>/index.html` + `app.css` + `app.js` (the shell, generic and data-driven), `tours.json` (what it renders and drives) and `scenarios/<slug>/index.html` per scenario. Paths in the catalog are relative to the catalog file, `config` included. Every scenario appends a `tour` event to its source directory's `anim.manifest.json`.

**One screen, many timelines.** `config` points at a timeline other than `<dir>/anim.config.json`, so several scenarios share one `index.html`: one product, several stories, and one place to edit the screen. Such a timeline is loaded exactly like any other -- locale resolution, device overrides, the same error messages -- and its strings live in **its own file beside it**: `scenarios/export-word.json` takes `scenarios/export-word.strings.fr.json`, while `anim.config.json` keeps `strings.fr.json`. They are per config rather than per directory because the keys are `steps.<id>.<field>`: one shared file would have two timelines silently translating each other's step of the same id.

A tour timeline is an ordinary `kind: "guide"` timeline -- the same file can still `export` a video and capture a guide. `kind: "reel"` is refused, because a reel carries no titles and the shell needs one per step.

### What is not guessable about a tour

- **A step without a `title` (or with `guide: false`) still plays, but is invisible to navigation**: no tick, no caption. That is how choreography rides along inside a scenario, and it is silent.
- **Seeking replays; it does not rewind.** Jumping to step N calls `__anim.restart()` to put the authored DOM back, re-runs every earlier step with `{instant: true}`, then plays N at full speed. That is why the page always agrees with itself -- there is no separate "state at step N" to drift -- and why a typed field really is empty again after you seek back past the step that filled it.
- **Media queries evaluate at the authored width, never the displayed width.** The shell renders the scenario at its authored viewport and transform-scales the whole frame, so a mockup that is right at 1920 is right in a 700px canvas. This is the opposite of the reel `--scale` rule; do not carry that intuition over.
- **Dwell between steps** is the authored gap between their `time`s minus the cursor lead, floored at 450 ms.
- **The legibility law.** The whole frame is scaled, so `on-screen px = authored px x (canvas width / authored width)`. A tour canvas is much smaller than a fullscreen video, which is why a mockup that reads perfectly as an exported MP4 can be unreadable in a tour: the 1920-wide `demo` screen has 13px body text, and in a ~1090px canvas that lands at 7.4px. **Author tour screens at 1280x720**, where the same canvas gives 11px. The rule is `canvas >= authored width x 11 / smallest authored text size`. Measured on a screen authored to it: canvas 1190, scale 0.929, 12px landing at 11.2px and 14px at 13.0px. The same screen authored at 1920 would have put that 12px at 6.9px.

## Authoring a reel: four constraints that are not guessable

1. **The media query breakpoint must sit above the widest viewport the reel is ever recorded at.** `--scale N` multiplies the CSS viewport and shrinks the layout box back with `:root { zoom: N }`, so a media query evaluates at the *scaled* width while the layout keeps its authored proportions. The law is `breakpoint >= device width x scale`, verified with no exceptions at mobile 1x/2x/3x (390/780/1170) and desktop 1x/2x (1920/3840). So a `max-width: 768px` breakpoint does not match a phone reel recorded at `--device mobile --scale 2`, which is a 780px viewport. `ask-anything` uses `max-width: 820px`, which covers mobile at 390 and 780 but would itself break at `--scale 3`: pick the breakpoint from the largest scale you intend to record, not from a number that happens to work today.
2. **An element animated from a `from` state must already be hidden in CSS.** The first keyframe is applied when the step runs, not at boot, so the element stays visible from page load right up to the step's `time`. A reveal at `0s` costs one frame; a reveal at `1s` shows the element for a full second, and a reveal at `2s` for two. Measured on a clip whose reveal fires at 1s, a card with no pre-hidden state was still fully painted in the exported MP4 at 0.2s, 0.5s and 0.8s. The reel mockup starts its cards at `opacity: 0` and its bars at `scaleY(0)` for exactly this reason.
3. **A `camera` push crops, and how far you can push is a property of your composition, not a fixed number.** The camera centres the viewport on the target's centre, so at scale `S` the visible window is `W/S` by `H/S` around that point. Nothing is sliced while

   ```
   S_max = min( W / (2 * max(cx - x0, x1 - cx)),
                H / (2 * max(cy - y0, y1 - cy)) )
   ```

   where `[x0,x1]` and `[y0,y1]` are the span of the content you want kept and `cx,cy` is the target's centre. The `max` is the distance to the *further* edge, which is why an off-centre target is penalised twice: the window shrinks and it is aimed away from the far side. For a centred target this collapses to `viewport / content width`, the gutter case.

   Validated against measurement, including the boundary: a fixture bound at 1.079 was clean at 1.06 and sliced at 1.12 and 1.18. For `ask-anything` on a phone the bound is **1.077** horizontally and 1.090 vertically, which is why both of its camera steps are `only: "desktop"` — not because phones cannot take a push, but because that particular composition runs to the frame edges and leaves no room for one. A design with real gutters can push hard on a phone.

   Compute this for your own screen rather than copying the number. It is the ceiling for "nothing is cropped"; deliberately cropping into a detail is a legitimate choice that ignores it.
4. **`--scale` does not apply to `record`, and is rejected as an unknown option rather than accepted and dropped.** A live app owns its own breakpoints, and zooming it would reflow it into a layout its CSS was never written for. Live captures therefore stay at 1x, which has a consequence worth planning around: a mockup reel recorded at `--scale 2` and a live capture of the same product will not match in pixel density, so two clips placed side by side on one marketing page will look different. Pick one source per page, or accept the mismatch deliberately.

## Live pages

`record` drives a real page instead of `index.html`: the same timeline, targets as selectors in the app, real navigations.

- Prefer stable `data-help="..."` attributes in the app (`[data-help="save"]`) over generated class names.
- `waitFor` on a step waits for a selector (or ms) after a navigation or an async load before the cursor moves; the wait shifts the rest of the timeline and the recording length. **It gates the start of its own step, not the aftermath of that step.** A click that navigates therefore takes its `waitFor` on the FOLLOWING step, naming something on the page being navigated to; putting the destination's selector on the navigating click itself waits for an element the current page will never have, and times out correctly.
- `navigate` opens a URL; a click that navigates (form submit, link) is detected and the runtime is re-injected on the new page.
- Sign in once and reuse the session: `npx playwright codegen --save-storage auth.json https://app.local/login`, then `--storage-state auth.json` (never put credentials in the timeline). `--ignore-https-errors` accepts local self-signed certificates.
- `npx tsx cli.ts check <dir> --live --url <url> --storage-state auth.json` is the cheap half of the loop: it opens the page like `record` does and replays the timeline in step mode, probing every target right before its step (after that step's `waitFor`), so a typo'd selector costs seconds instead of a recording. **The interactions run for real** -- it is a pass over the app, saves included, so it needs the same reset as any other pass (`--reset-cmd`, or `meta.reset` with `--allow-reset`). That is why the probe requires an explicit `--url`: a bare `--live` is the schema-only pass it has always been, even when `meta.url` is set. Unmatched `waitFor` selectors give up after 5 s here rather than the recording's 15 s. `record` does not stop at a missing target: it records the whole timeline, lists the failed steps at the end and exits 1 (`--force` turns that into a warning), so one broken selector costs one recording, not a partial video.
- `record <dir> --url <url> --storage-state auth.json -o demo.mp4 --guide` records, then **re-navigates and replays the whole timeline a second time** in step mode to capture the guide frames. A page that already defines `window.__anim` is refused.
- **A timeline that writes data is not idempotent.** On the guide replay the data is already saved, so a "Save" button that only enables with unsaved changes stays disabled and every later step fails; the error names the selector (`waitFor …: not found`), but the selector is fine. `record` says so when a step succeeded in the recording and failed on the replay. Put the app back into its starting state before each pass with `--reset-cmd "<shell command>"` (a seed script, a test-only reset endpoint), or with `meta.reset` in the timeline plus `--allow-reset` -- a config file that carries a shell command is content you may not have written, so it never runs on its own. Without a reset, run `record` without `--guide`, reset the app, then `guide <dir> --url <url> --storage-state auth.json` separately.
- A `waitFor` that never appears waits `waitForTimeoutMs` (default 15 s) and is reported as a **warning naming the step**, separately from the info line about real load shifts; the steps after it probably ran against the wrong page state. Lower the timeout per step, or pass `--fail-fast` to abandon the recording (exit 1, no video) at the first timeout instead of producing a video nobody will use.

## The manifest: what was done

Every command appends an event to `<dir>/anim.manifest.json` (paths relative to the directory, URLs without credentials). Read it before re-doing someone else's work:

```jsonc
{ "locale": "fr", "baseLocale": "en",
  "contentHash": { "fr": "sha256:…" }, "buildKey": { "fr": "sha256:…" },
  "history": [
    { "command": "localize", "timestamp": "…", "sourceDir": "../..", "locale": "fr", "baseLocale": "en" },
    { "command": "build", "timestamp": "…", "cursor": "mac", "locale": "fr", "output": "animated.html" },
    { "command": "export", "timestamp": "…", "output": "demo-fr.mp4", "duration": 14.2, "device": "desktop", "theme": "light", "locale": "fr",
      "narration": true, "subtitles": "demo-fr.vtt", "chapters": 5, "clips": [], "guide": "guide", "contentHash": "sha256:…", "driven": true,
      "steps": [{ "index": 2, "id": "open", "actualMs": 2004, "completedMs": 2004 }] },
    { "command": "record", "timestamp": "…", "url": "https://app.local/save", "storageState": "../../auth.json", "navigations": 1, "shiftMs": 1027, "reset": true, "output": "save.mp4", "duration": 15.2,
      "steps": [{ "index": 4, "id": "items", "actualMs": 4228, "completedMs": 4228, "waitedMs": 1813 }] },
    { "command": "build-all", "timestamp": "…", "catalog": "../../help.catalog.json", "locale": "fr", "output": "../../help-out/draft-proposal-response/fr", "contentHash": "…", "buildKey": "…", "stale": false, "builtAt": "…" }
  ] }
```

Events come from `extract`, `animate`, `build`, `export`, `record`, `guide`, `localize` and `build-all` (`check` and `preview` write nothing). `export`/`record` events carry the measured `actualMs`/`completedMs` per step, `navigated`/`waitedMs` on live steps, `shiftMs` when live waits stretched the recording, and `timedOutSteps` for the steps whose `waitFor` gave up. A driven run that ends early -- a `--fail-fast` abort, or a failure during the recording, the encode or the guide capture -- still appends an event: it carries `aborted` with the reason, the steps it managed to run, and `output` only when a file was actually left behind.

## Standalone use with an LLM API key

`extract <image> <dir>` (screenshot → `index.html`, Vision LLM) and `animate <dir> "<prompt>"` (prompt → `anim.config.json` + `animated.html`) need `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` (`.env` or environment; `--provider`, `--model`, `GEMINI_MODEL`, `CLAUDE_MODEL`). An agent skips both and writes the files itself.

## Contributor notes

- Layout: `cli.ts` (commander, `buildProgram()`), `src/engine/` (`schema.ts` parsing/validation, `runtime.js` the in-page engine, `inject.ts` builds `animated.html`, `tour-bridge.js` the message-driven scheduler a tour page runs on, `driver.ts` drives a Playwright page), `src/commands/`, `src/guide/` (capture, render, diff), `src/media/` (ffmpeg, tts, vtt, chapters, contact sheet), `src/tour/app/` (the tour shell: generic HTML/CSS/JS copied into the output verbatim), `src/catalog.ts`, `src/manifest.ts`, `src/browser.ts`.
- `runtime.js` and `tour-bridge.js` are plain browser JavaScript injected as text (no imports, must tolerate document-start injection). The bridge is the third scheduler over `runStep`: the other two are `play()` inside the runtime and `driver.ts` outside it, and neither can be seeked because both advance on a clock. The timing constants at the top of `schema.ts` are mirrored as literals there and `test/constants.test.ts` asserts they stay equal.
- The spotlight ring pulses by scaling itself, so its measured rect is a few px off wherever it was positioned. A test that asserts where the ring landed must read its inline style, not `getBoundingClientRect()`.
- `overflow: hidden` is still programmatically scrollable, and the runtime scrolls a clipped target into view before interacting, so content below such a container's fold is reachable and is not a crop. Only `overflow: clip` hides something for good. `check`'s crop warning and the spotlight clamp both draw the line there; a fixture meant to be unreachable must use `clip`.
- **Rule for `page.evaluate` callbacks:** no inner functions inside the callback. `tsx`/esbuild adds a `__name` helper that does not exist in the page, so the callback throws silently. Put helpers in `runtime.js` and call them by name (`__anim.markStep(...)`).
- Tests: `npm test` (`node:test` through `tsx`, serial: `--test-concurrency=1`, about 10 minutes with the browser tests; `SKIP_BROWSER=1` skips them, `SKIP_TTS=1` skips the macOS `say` narration test). `ANIM_DEBUG=1` makes `check` print every target probe and `export` print page/context close timings and trim details on stderr. Fixtures: `test/fixtures/basic/` (a mockup with every action), `test/fixtures/controlled/` (a React-style controlled input with a value tracker; served by the live app at `/controlled`) and `test/fixtures/live-app/server.ts` (a login/dashboard app for `record`, plus `/once`, a Save that works once per process, for the reset-hook checks).
- **Nothing in a run may wait forever.** `node:test`'s own default timeout is `Infinity`, and a pending `await` that holds any live handle (a Chromium, a socket) then hangs the suite with no output and no failure -- which reads as a loop, not a hang. Bounds, innermost first, and the inner ones must always fire before the outer ones or the useful message is lost: `FFMPEG_TIMEOUT_MS` (`media/ffmpeg.ts`, 10 min) and `SAY_TIMEOUT_MS` (`media/tts.ts`, 60 s) -- these two cannot be delegated upward, because `spawnSync`/`execFileSync` block the event loop, so no timer in the process can fire while they are stuck; `CLI_TIMEOUT_MS` (300 s) with `killSignal: 'SIGKILL'` on every `spawnSync`/`spawn` of the CLI in `test/`, each helper calling `assertRan()` so a kill reports as a named failure instead of `expected null to equal 0`; `CHILD_TIMEOUT_MS` in `build-all.ts` (15 min per child, SIGTERM then SIGKILL after a grace, reported at report time so a chatty death cannot push it out of `tail()`); `exitWhenDrained()` in `cli.ts`, which force-exits 5 s after the command resolves if handles or libuv requests still hold the process, naming them -- the backstop for a browser that would not close, since Playwright exposes no public handle on its browser process from a `Browser` (its own `process.on('exit')` hook kills the browser when the watchdog exits, so no orphan is left); and last `--test-timeout` in the `test` script, 30 min. **That last number is a last resort, not the real bound, and it is sized against a sum:** the cap is per test, `CLI_TIMEOUT_MS` is per call, and the slowest `buildall.test.ts` test makes 12 calls -- at 600 s the runner cancelled the test (losing the child's message) as soon as two children wedged. Raise it, or split the test, before adding calls to a long one. Add a new spawn, add its bound.
- **The browser-driven commands are sensitive to what else is running on the machine.** A step is abandoned after `stepTimeoutMs` (30 s, `driver.ts:243`) and the suite's orphaned-process check counts Chromium and ffmpeg machine-wide, so running exports beside `npm test`, or several exports beside a `preview`, produces timeouts and process-count failures that do not reproduce on an idle machine. Run one browser-driven job at a time before concluding a step is genuinely stuck. Non-fatal `context did not close within 10000ms` / `browser did not close within 10000ms` warnings belong to the same family and appear even serially, on a long `build-all`.
- Docs: `npm run docs` regenerates the CLI reference block below (and in README.md) from `cli.ts`; `npm run docs:check` and `test/docs.test.ts` fail when it is stale.
- CI: `.github/workflows/test.yml` runs `npm run docs:check`, `tsc --noEmit` and the suite on Ubuntu with a cached Chromium, about 12 to 15 minutes. It needs no secrets.

## CLI reference

<!-- cli-reference:start -->
Generated from `cli.ts` by `npm run docs`; do not edit by hand. `npx tsx cli.ts <command> --help` prints the same, plus the usage guide (`--help`) and the catalog schema (`build-all --help`).

[`init-config`](#init-config) · [`extract`](#extract) · [`animate`](#animate) · [`build`](#build) · [`check`](#check) · [`preview`](#preview) · [`export`](#export) · [`record`](#record) · [`guide`](#guide) · [`build-all`](#build-all) · [`tour`](#tour) · [`localize`](#localize)

### `init-config`

```bash
npx tsx cli.ts init-config <output_dir> [options]
```

Scaffold an anim.config.json timeline file in the target directory

| Argument | Description |
|---|---|
| `<output_dir>` | Directory to initialize the config in |

| Option | Description |
|---|---|
| `--kind <profile>` | Which profile to scaffold: guide (default) or reel (silent looping product clip) |
| `--force` | Overwrite an existing anim.config.json |

### `extract`

```bash
npx tsx cli.ts extract <image_path> <output_dir> [options]
```

Extract an HTML/CSS essence from a screenshot (needs an LLM API key)

| Argument | Description |
|---|---|
| `<image_path>` | Path to the screenshot image |
| `<output_dir>` | Directory to save the generated HTML essence |

| Option | Description |
|---|---|
| `-p, --provider <provider>` | LLM provider (gemini or claude) (default: `gemini`) |
| `-m, --model <model>` | LLM model ID (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001). Defaults per provider |
| `-a, --abstraction <level>` | Abstraction distillation level: none, moderate, high (default: `none`) |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `-f, --framework <type>` | Output framework: html or react (default: `html`) |
| `-t, --theme <mode>` | Color scheme mode: light or dark (default: `light`) |

### `animate`

```bash
npx tsx cli.ts animate <output_dir> <prompt> [options]
```

Write anim.config.json + animated.html from a prompt (needs an LLM API key; agents write the timeline themselves and run build)

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing the generated HTML essence |
| `<prompt>` | Prompt describing the desired animation |

| Option | Description |
|---|---|
| `-p, --provider <provider>` | LLM provider (gemini or claude) (default: `gemini`) |
| `-m, --model <model>` | LLM model ID (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001). Defaults per provider |
| `-c, --cursor <style>` | Cursor style: mac, windows, none (default: `mac`) |
| `-l, --loop` | Loop the generated HTML animation endlessly |
| `--locale <code>` | Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json |

### `build`

```bash
npx tsx cli.ts build <output_dir> [options]
```

Build animated.html from index.html + anim.config.json (no LLM, no API key)

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing index.html and anim.config.json |

| Option | Description |
|---|---|
| `-c, --cursor <style>` | Cursor style: mac, windows, none (default: meta.cursor or mac) |
| `--device <type>` | Which device's timeline to bake in (resolves "only"/"mobile"/"desktop" steps): desktop or mobile (default: `desktop`) |
| `--embed` | Also write embed.html (a framable, self-contained clip) and embed.snippet.html (the parent-side iframe snippet) |
| `-l, --loop` | Loop the animation endlessly when opened in a browser |
| `--locale <code>` | Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json |
| `--force` | Build even if the timeline has validation errors |
| `-o, --output <file>` | Write the built HTML somewhere other than <output_dir>/animated.html |

### `check`

```bash
npx tsx cli.ts check <output_dir> [options]
```

Validate anim.config.json: schema, timing, strings, and (unless --static/--live) every target selector in a headless browser

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing anim.config.json (and index.html unless --live) |

| Option | Description |
|---|---|
| `--static` | Schema and timing checks only, no browser |
| `--scale <n>` | Pixel density used for the recording: the viewport is multiplied by N and the page zoomed back, so media queries see the scaled width |
| `--live` | Validate a timeline meant for `record` (live page): navigate/waitFor allowed, no index.html needed; add --url to also probe every target against the page |
| `--url <url>` | With --live: probe every target against this page. The timeline is replayed for real (clicks, keystrokes and saves happen), so reset the app first when it writes data |
| `--storage-state <file>` | Live probe: Playwright storage state (cookies/localStorage) |
| `--ignore-https-errors` | Live probe: accept self-signed certificates |
| `--reset-cmd <command>` | Live probe: shell command run before the pass |
| `--allow-reset` | Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this) |
| `--guide` | Validate as a guide: a numbered step without a "title" is an error, not a warning |
| `--json` | Print the issues as JSON on stdout |
| `--locale <code>` | Locale code (e.g. en, fr) |
| `-w, --width <pixels>` | Viewport width for the browser pass |
| `-H, --height <pixels>` | Viewport height for the browser pass |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `-t, --theme <mode>` | Color scheme mode: light or dark (default: `light`) |

### `preview`

```bash
npx tsx cli.ts preview <output_dir> [options]
```

Render one labelled frame per step to <output_dir>/preview.png (or a single full-size frame with --step N)

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing index.html and anim.config.json |

| Option | Description |
|---|---|
| `-s, --step <n>` | Write only step N (1-based) at full resolution to preview-step-N.png |
| `--scale <n>` | Pixel density used for the recording: the viewport is multiplied by N and the page zoomed back, so media queries see the scaled width |
| `--at <when>` | Capture point per step: "auto" (like the guide: clicks at the interaction, typing/camera/fades at completion), "interaction", or "end" (default: `auto`) |
| `-o, --output <file>` | Output PNG path |
| `-c, --cursor <style>` | Cursor style: mac, windows, none (default: meta.cursor or mac) |
| `--locale <code>` | Locale code (e.g. en, fr) |
| `--force` | Preview even if the timeline has validation errors |
| `-w, --width <pixels>` | Viewport width in pixels |
| `-H, --height <pixels>` | Viewport height in pixels |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `-t, --theme <mode>` | Color scheme mode: light or dark (default: `light`) |

### `export`

```bash
npx tsx cli.ts export <output_dir> [options]
```

Record the timeline to an MP4/GIF (plus .vtt subtitles, chapters, optional narration and step guide); the length comes from the timeline

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing index.html + anim.config.json (or a legacy animated.html) |

| Option | Description |
|---|---|
| `-d, --duration <seconds>` | Override the export length in seconds (default: computed from the timeline; 5 without a config) |
| `-o, --output <file>` | Output video file path (.mp4 or .gif) (default: `output.mp4`) |
| `-w, --width <pixels>` | Width of the exported video in pixels |
| `-H, --height <pixels>` | Height of the exported video in pixels |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `--scale <n>` | Pixel density: multiply the viewport by N and zoom the page back, so the frame is N times denser (media queries then see the scaled width) |
| `-t, --theme <mode>` | Color scheme mode for Playwright: light or dark (default: `light`) |
| `--narration` | Synthesize each step's "narration" (or "subtitle") and mix it in at the step's time (OPENAI_API_KEY or macOS say) |
| `--voice <name>` | TTS voice (OpenAI voice name, or a macOS `say` voice) |
| `-v, --voiceover <path>` | Path to a text file with a whole-video voiceover script (legacy, starts at 0s) |
| `--no-subtitles` | Do not write <output>.vtt |
| `--no-chapters` | Do not embed MP4 chapters for titled steps |
| `--clips <format>` | Also cut one clip per step next to the video: mp4 or gif |
| `--tail <ms>` | Hold after the last step (overrides meta.tailMs, default 2500) |
| `--guide` | Also write the step-by-step guide (guide.json, guide.md, guide.html, assets/) after the video |
| `--guide-dir <dir>` | Guide output directory (default: <output_dir>/guide) |
| `--crop <px>` | Guide crops: padding around each step's box in px (default 120) |
| `--no-crop` | Guide: full frames only, no crops |
| `--hide-cursor` | Guide: hide the fake cursor in the step screenshots |
| `--force` | Export even if the timeline has validation errors; step failures then do not fail the command |
| `--locale <code>` | Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json |

### `record`

```bash
npx tsx cli.ts record <output_dir> [options]
```

Record the timeline against a live page (URL) instead of a local mockup: real navigations, waitFor, storage state

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing anim.config.json (targets are selectors in the live app, e.g. [data-help="save"]) |

| Option | Description |
|---|---|
| `--url <url>` | Page to open (default: meta.url in anim.config.json) |
| `--storage-state <file>` | Playwright storage state (cookies/localStorage), e.g. from `npx playwright codegen --save-storage auth.json` |
| `--ignore-https-errors` | Accept self-signed certificates (mkcert-style local HTTPS) |
| `--reset-cmd <command>` | Shell command run before each pass over the app (the recording, then the --guide replay); used instead of meta.reset, and never needs --allow-reset |
| `--allow-reset` | Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this) |
| `--fail-fast` | Abandon the recording at the first waitFor timeout instead of recording the rest against the wrong page state |
| `-o, --output <file>` | Output video file path (.mp4 or .gif) (default: `output.mp4`) |
| `-d, --duration <seconds>` | Override the recording length in seconds (default: computed from the timeline) |
| `-w, --width <pixels>` | Width of the recorded video in pixels |
| `-H, --height <pixels>` | Height of the recorded video in pixels |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `-t, --theme <mode>` | Color scheme mode: light or dark (default: `light`) |
| `--narration` | Synthesize each step's narration and mix it in |
| `--voice <name>` | TTS voice |
| `--no-subtitles` | Do not write <output>.vtt |
| `--no-chapters` | Do not embed MP4 chapters |
| `--clips <format>` | Also cut one clip per step: mp4 or gif |
| `--tail <ms>` | Hold after the last step (overrides meta.tailMs) |
| `--guide` | Also capture the step guide against the live page (re-navigates, replays in step mode) |
| `--guide-dir <dir>` | Guide output directory (default: <output_dir>/guide) |
| `--crop <px>` | Guide crops: padding around each step's box in px (default 120) |
| `--no-crop` | Guide: full frames only |
| `--hide-cursor` | Guide: hide the fake cursor in step screenshots |
| `--force` | Record even if the timeline has validation errors; step failures then do not fail the command |
| `--locale <code>` | Locale code for this output (e.g. en, fr) |

### `guide`

```bash
npx tsx cli.ts guide <output_dir> [options]
```

Write a Scribe-style step guide (guide.json, guide.md, guide.html + assets/) from index.html + anim.config.json; links the last exported video when present

| Argument | Description |
|---|---|
| `<output_dir>` | Directory containing index.html and anim.config.json |

| Option | Description |
|---|---|
| `-o, --output <dir>` | Guide output directory (default: <output_dir>/guide) |
| `--crop <px>` | Padding around each step's box for the cropped image, in px (default 120) |
| `--no-crop` | Full frames only, no crops |
| `--clips <format>` | Cut one clip per step from the last exported video: mp4 or gif |
| `--hide-cursor` | Hide the fake cursor in the step screenshots |
| `--no-marks` | Do not burn the spotlight ring and numbered badge into the frames (rect/callout are still recorded) |
| `--url <url>` | After a `record`: replay against this URL instead of the one in the manifest |
| `--storage-state <file>` | After a `record`: storage state for the live replay (default: the one the record used) |
| `--ignore-https-errors` | Accept self-signed certificates on the live replay |
| `--reset-cmd <command>` | After a `record`: shell command run before the live replay |
| `--allow-reset` | Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this) |
| `--locale <code>` | Locale code (e.g. en, fr) |
| `--force` | Capture even if the timeline has validation errors; step failures then do not fail the command |
| `-w, --width <pixels>` | Viewport width in pixels |
| `-H, --height <pixels>` | Viewport height in pixels |
| `--device <type>` | Device viewport constraints: desktop or mobile (default: `desktop`) |
| `-t, --theme <mode>` | Color scheme mode: light or dark (default: `light`) |

### `build-all`

```bash
npx tsx cli.ts build-all [catalog] [options]
```

Build every guide x locale of help.catalog.json (check, build, export|record --guide) into <outputDir>/<slug>/<locale>/ and merge index.json + index.md; exit 1 on any failure

| Argument | Description |
|---|---|
| `[catalog]` | Catalog file (default: `help.catalog.json`) |

| Option | Description |
|---|---|
| `--changed-only` | Skip a guide x locale whose build key (sources + render settings + tool version) matches what its manifest recorded |
| `--diff` | Keep the previous step frames and mark a guide stale when a frame changed beyond --diff-threshold |
| `--diff-threshold <fraction>` | Fraction of changed pixels that marks a guide stale (default: `0.02`) |
| `--only <slug>` | Build one guide |
| `--locale <code>` | Build one locale |
| `--continue-on-error` | Keep going after a failed guide (default: stop at the first failure) |
| `--dry-run` | Print the plan per guide x locale and stop: nothing is created, written or recorded |
| `--verbose` | Also stream the child commands' stdout (their stderr is always streamed, prefixed with slug/locale) |
| `--allow-reset` | Let each guide's "meta.reset" run before its passes (a shell command out of its anim.config.json) |

### `tour`

```bash
npx tsx cli.ts tour [catalog] [options]
```

Build an interactive tour site from tour.catalog.json: a scenario rail plus a canvas that plays any scenario step by step (no capture, no encoding)

| Argument | Description |
|---|---|
| `[catalog]` | Catalog file (default: `tour.catalog.json`) |

| Option | Description |
|---|---|
| `-o, --output <dir>` | Directory to write the tour into (default: the catalog's outputDir, else tour-out) |
| `--force` | Build scenarios that have validation errors |

### `localize`

```bash
npx tsx cli.ts localize <source_dir> <locale> [options]
```

Scaffold <source_dir>/locales/<locale>/ with index.html, anim.config.json, media and a pre-filled strings.<locale>.json; the choreography is reused as is

| Argument | Description |
|---|---|
| `<source_dir>` | Existing output directory to localize from (contains index.html, optionally anim.config.json) |
| `<locale>` | Target locale code, e.g. fr, es, pt-BR |

| Option | Description |
|---|---|
| `-o, --output-dir <dir>` | Directory to scaffold into (default: <source_dir>/locales/<locale>) |
| `--sibling` | Legacy layout: scaffold into a sibling directory named after the locale |
| `--force` | Overwrite the target's index.html, anim.config.json and strings.<locale>.json (translations are lost); by default they are kept and only new strings are added |
<!-- cli-reference:end -->
