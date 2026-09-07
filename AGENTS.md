# Agent manual: Screenshot Animator CLI

This is the manual for an AI agent (Claude Code, Codex, Antigravity) or a person driving the CLI. It turns a **screen** (`index.html`) plus a **timeline** (`anim.config.json`) into a demo **video** (MP4 + subtitles + chapters, optional narration), a **step-by-step help guide** (`guide.json` / `guide.md` / `guide.html` + frames), and the same for **every language**, and it can do that against a **live web page** instead of a mockup. `help.catalog.json` + `build-all` produce a whole help site's worth of guides in one command.

You are the LLM. You write the screen and the timeline yourself; the CLI needs **no API key** for anything below except the optional `extract`/`animate` commands.

## Setup

```bash
npm install
npx playwright install chromium
```

Node >= 20. TypeScript runs through `tsx` (no build step). ffmpeg is bundled (`ffmpeg-static`). Narration uses `OPENAI_API_KEY` when set, else macOS `say`.

## Workflow

Every command below prints what it wrote; `npx tsx cli.ts --help` and `npx tsx cli.ts <command> --help` are the reference.

1. **Write the screen.** Put a faithful mockup of the UI in `<dir>/index.html` (inline CSS, real element ids/classes; when the user pasted screenshots, reproduce each one; several screens can live in one file as sections you fade between). Media files referenced from `index.html` go next to it.
2. **Write the timeline.** `npx tsx cli.ts init-config <dir>` scaffolds `<dir>/anim.config.json` in object form; edit it to match your selectors. Give every step an explicit `id` (translations and guide frames attach to it).
3. **Check.** `npx tsx cli.ts check <dir>` validates the schema and timing statically, then replays the timeline in a headless browser and probes every target right before its step (missing, hidden, 0x0, clipped, off-screen). Fix errors; read the warnings.
4. **Build.** `npx tsx cli.ts build <dir>` writes `<dir>/animated.html`, a self-playing page with the cursor, spotlight, ripple, camera and subtitles injected, for humans to open in a browser (run `build` again after editing `index.html`; it is a generated file, not tracked). `export` does not read it: with an `anim.config.json` present it always records `index.html` with the runtime injected, so the video can never disagree with `check`/`preview`.
5. **Preview and iterate.** `npx tsx cli.ts preview <dir>` writes `<dir>/preview.png`, one labelled frame per step (`--step N` writes a single full-size `preview-step-N.png`). **Read the PNG** with your image tool, fix the timeline (a badly placed camera, a subtitle that overlaps, a step that fires too early), and repeat 3 to 5 until the frames look right.
6. **Export.** `npx tsx cli.ts export <dir> -o demo.mp4 --guide --narration` records the video (length computed from the timeline plus `meta.tailMs`), writes `demo.vtt`, embeds chapters for titled steps, mixes the narration, then captures the guide into `<dir>/guide/`. `--clips mp4` also cuts one clip per step. A `.gif` output skips audio, chapters and subtitles.
7. **Localize.** `npx tsx cli.ts localize <dir> fr` scaffolds `<dir>/locales/fr/` and a pre-filled `strings.fr.json`; translate the strings and the visible text of the copied `index.html`, then `check`, `build`, `export` that directory. See [Localization](#localization).
8. **Build everything.** Describe the guides once in `help.catalog.json` and run `npx tsx cli.ts build-all --changed-only --diff`. See [Catalog and build-all](#catalog-and-build-all).

For a **live app** replace steps 1 and 4 with selectors in the real page and use `record` instead of `export`. See [Live pages](#live-pages).

Cinematic polish is built in: click/focus/type/highlight/hover steps get a glowing spotlight on the target and a click ripple, `camera` pushes in on an element, `scroll` brings it into view, the cursor glides with a slight drift, and subtitles are drawn as an overlay. There is nothing to paste into `index.html`.

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

### Steps

| Field | Meaning |
|---|---|
| `id` | Stable identifier. Strings files and guide frames attach to it; auto ids (`step-03`) shift when a step is inserted, so `check`/`localize` warn about them once a strings file exists. |
| `time` | **Moment of the interaction** (the click, the first typed character, the highlight pulse): `"2s"`, `"2000ms"` or a number of seconds. The cursor starts travelling up to 950 ms earlier (lead = min(950 ms, gap to the previous step, time)). Steps must be in order. |
| `action` | See the table below. |
| `target` | CSS selector. Required for click, focus, type, highlight, hover, scroll, fadeIn, transitionScreen. A 0x0 target (an empty caret span) is spotlighted through its sized ancestor. |
| `value` | Text for `type` (typed at `cps` characters per second, default 25) or the key for `press` (`Enter`, `Tab`, `Control+K`). |
| `title` | Step heading in the guide and the chapter name in the MP4. |
| `subtitle` | Shown in the video's subtitle bar from `time` until the next subtitle (held at most 4 s, at least 1 s) and written to the `.vtt`; also the narration text when `narration` is absent. `null` clears the bar. |
| `narration` | Text spoken at `time` with `--narration` (mixed into the MP4). |
| `note` | Extra sentence under the step in the guide. |
| `translatable` | `true` when `value` is user-visible text that must be translated (it becomes a string key). |
| `crop` | Guide crop padding in px for this step, or `false` for the full frame only. |
| `guide` | `false` hides the step from the guide (it still runs in the video). |
| `captureAt` | Override the guide/preview frame moment: `"interaction"` or `"completion"`. |
| `waitFor` | Live pages: a selector to wait for (visible) or a number of ms before the cursor moves; the delay shifts the rest of the timeline. |
| `url` | `navigate` (live pages): the page to open. |
| `scale`, `x`, `y`, `xOffset`, `yOffset` | `camera`: zoom factor (default 1, a pan without zoom; 1.3 is a typical push-in) and framing; `x`/`y` centre the camera on a point instead of a target, `xOffset`/`yOffset` nudge the framing. |
| `duration` | Seconds. `camera`: length of the pan (default 2.5). `fadeIn`/`transitionScreen`: length of the fade (default: the element's own CSS transition, else 0.8 s). |

### Actions and the guide capture rule

| Action | What happens | Guide frame taken |
|---|---|---|
| `click` | Cursor travels, spotlight, press, ripple, real `el.click()` so the page's own handlers run. | At the interaction (+300 ms settle), spotlight held; a click that hides its own target (a screen swap, a navigation) is captured just before the click instead, and records `capturedAt: "arrival"`. |
| `focus` | Cursor travels, spotlight, `el.focus()`. | Interaction. |
| `type` | Cursor travels, focuses, types `value` character by character (inputs, textareas, contenteditable, plain elements with a caret). | Completion (full text visible). |
| `highlight` | Spotlight pulse without a click ("notice this"). | Interaction. |
| `hover` | Cursor moves onto the element. | Interaction. |
| `press` | Keyboard key from `value` (no target). | Interaction. |
| `camera` | Pan/zoom the page toward the target (or `x`/`y`); `scale: 1` pulls back. The cursor and the spotlight ride along, staying on the element they were on. | Completion (zoomed framing). |
| `scroll` | Smooth-scroll the target into view. | Completion. |
| `fadeIn` | Reveal the target (display/opacity) with a fade. | Completion. |
| `transitionScreen` | Fade the current screen out and the target screen in. | Completion. |
| `navigate` | Live pages only: open `url`. | Arrival on the new page. |
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

`index` is the position in the timeline, `number` the guide numbering (steps with `guide: false` are skipped). `actualMs` is measured in the page; `scheduledMs` is what the timeline said. `rect` is the box the spotlight framed (the sized ancestor of a 0x0 target); `rect` and `callout` are `null` only for target-less or failed steps. `clip` appears when clips were cut: `export --clips` writes `<video>-step-NN.mp4|gif` next to the video and the guide points at them (`../demo-step-02.mp4`); `guide --clips` cuts them into `assets/`. `audio`/`audioDurationMs` appear when the video was narrated: the step's synthesized narration is copied to `assets/step-NN.mp3` (OpenAI) or `.aiff` (macOS `say`). Paths are relative to the guide directory; `source.dir` is a basename, never an absolute path.

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

- Paths are relative to the catalog file. `outputDir` may not be `/`, the home directory, the catalog directory, or overlap a guide directory. Every default is also valid per guide (the guide wins). `outputs` are the extras: `guide` (default), `gif`, `clips`; the video is always produced.
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

## Live pages

`record` drives a real page instead of `index.html`: the same timeline, targets as selectors in the app, real navigations.

- Prefer stable `data-help="..."` attributes in the app (`[data-help="save"]`) over generated class names.
- `waitFor` on a step waits for a selector (or ms) after a navigation or an async load before the cursor moves; the wait shifts the rest of the timeline and the recording length.
- `navigate` opens a URL; a click that navigates (form submit, link) is detected and the runtime is re-injected on the new page.
- Sign in once and reuse the session: `npx playwright codegen --save-storage auth.json https://app.local/login`, then `--storage-state auth.json` (never put credentials in the timeline). `--ignore-https-errors` accepts local self-signed certificates.
- `npx tsx cli.ts check <dir> --live` validates the timeline without a page (it reports a "static, live timeline" check: there is no browser pass, because the targets live in the app). `record` does not stop at a missing target: it records the whole timeline, lists the failed steps at the end and exits 1 (`--force` turns that into a warning), so one broken selector costs one recording, not a partial video.
- `record <dir> --url <url> --storage-state auth.json -o demo.mp4 --guide` records, then replays the timeline in step mode on the live page to capture the guide frames. A page that already defines `window.__anim` is refused.

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
    { "command": "record", "timestamp": "…", "url": "https://app.local/save", "storageState": "../../auth.json", "navigations": 1, "shiftMs": 1027, "output": "save.mp4", "duration": 15.2,
      "steps": [{ "index": 4, "id": "items", "actualMs": 4228, "completedMs": 4228, "waitedMs": 1813 }] },
    { "command": "build-all", "timestamp": "…", "catalog": "../../help.catalog.json", "locale": "fr", "output": "../../help-out/draft-proposal-response/fr", "contentHash": "…", "buildKey": "…", "stale": false, "builtAt": "…" }
  ] }
```

Events come from `extract`, `animate`, `build`, `export`, `record`, `guide`, `localize` and `build-all` (`check` and `preview` write nothing). `export`/`record` events carry the measured `actualMs`/`completedMs` per step, `navigated`/`waitedMs` on live steps, and `shiftMs` when live waits stretched the recording.

## Standalone use with an LLM API key

`extract <image> <dir>` (screenshot → `index.html`, Vision LLM) and `animate <dir> "<prompt>"` (prompt → `anim.config.json` + `animated.html`) need `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` (`.env` or environment; `--provider`, `--model`, `GEMINI_MODEL`, `CLAUDE_MODEL`). An agent skips both and writes the files itself.

## Contributor notes

- Layout: `cli.ts` (commander, `buildProgram()`), `src/engine/` (`schema.ts` parsing/validation, `runtime.js` the in-page engine, `inject.ts` builds `animated.html`, `driver.ts` drives a Playwright page), `src/commands/`, `src/guide/` (capture, render, diff), `src/media/` (ffmpeg, tts, vtt, chapters, contact sheet), `src/catalog.ts`, `src/manifest.ts`, `src/browser.ts`.
- `runtime.js` is plain browser JavaScript injected as text (no imports, must tolerate document-start injection). The timing constants at the top of `schema.ts` are mirrored as literals there and `test/constants.test.ts` asserts they stay equal.
- **Rule for `page.evaluate` callbacks:** no inner functions inside the callback. `tsx`/esbuild adds a `__name` helper that does not exist in the page, so the callback throws silently. Put helpers in `runtime.js` and call them by name (`__anim.markStep(...)`).
- Tests: `npm test` (`node:test` through `tsx`, serial: `--test-concurrency=1`, about 10 minutes with the browser tests; `SKIP_BROWSER=1` skips them, `SKIP_TTS=1` skips the macOS `say` narration test). `ANIM_DEBUG=1` makes `check` print every target probe and `export` print page/context close timings and trim details on stderr. Fixtures: `test/fixtures/basic/` (a mockup with every action) and `test/fixtures/live-app/server.ts` (a login/dashboard app for `record`).
- Docs: `npm run docs` regenerates the CLI reference block below (and in README.md) from `cli.ts`; `npm run docs:check` and `test/docs.test.ts` fail when it is stale.
- CI: `.github/workflows/test.yml` runs `npm run docs:check`, `tsc --noEmit` and the suite on Ubuntu with a cached Chromium, about 12 to 15 minutes. It needs no secrets.

## CLI reference

<!-- cli-reference:start -->
Generated from `cli.ts` by `npm run docs`; do not edit by hand. `npx tsx cli.ts <command> --help` prints the same, plus the usage guide (`--help`) and the catalog schema (`build-all --help`).

[`init-config`](#init-config) · [`extract`](#extract) · [`animate`](#animate) · [`build`](#build) · [`check`](#check) · [`preview`](#preview) · [`export`](#export) · [`record`](#record) · [`guide`](#guide) · [`build-all`](#build-all) · [`localize`](#localize)

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
| `--live` | Validate a timeline meant for `record` (live page): navigate/waitFor allowed, no index.html needed, no browser probe |
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
| `--url <url>` | After a `record`: replay against this URL instead of the one in the manifest |
| `--storage-state <file>` | After a `record`: storage state for the live replay (default: the one the record used) |
| `--ignore-https-errors` | Accept self-signed certificates on the live replay |
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
