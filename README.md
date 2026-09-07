# Screenshot Animator CLI

Turn a UI mockup (`index.html` + `anim.config.json`) or a live web page into a **demo video**, a **step-by-step help guide**, and their **translations**, from the terminal, with headless Chromium and FFmpeg.

Built for AI agents: you (or your agent) write the screen and the timeline, the CLI does the recording, the guide capture, the localization scaffolding and the batch builds. No API key is needed for any of that. **Agents: read [AGENTS.md](AGENTS.md), the manual with the file contracts.**

## What you get

- **Video**: MP4 (or GIF) with a moving cursor, spotlight and click ripple on every interaction, typing, camera pushes, screen transitions, a subtitle bar, `.vtt` subtitles, MP4 chapters per step and optional narration (OpenAI TTS or macOS `say`).
- **Step guide**: `guide.json`, `guide.md` and `guide.html` with a numbered frame and crop per step, the video inline, and measured timings.
- **Languages**: `localize` scaffolds `locales/<code>/` with a `strings.<code>.json`; the choreography is shared, only the text changes.
- **Batch builds**: `help.catalog.json` + `build-all` produce every guide × locale into one output tree with an `index.json`, rebuilding only what changed and flagging guides whose frames drifted.
- **Live pages**: `record` drives a real app (navigations, async waits, saved login state) with the same timeline.

## Example

**Input screenshot:**
> <img width="1414" height="716" alt="screenshot input" src="https://github.com/user-attachments/assets/744cd3d5-c4cd-4c15-b671-460667965def" />

**Output video:**
> https://github.com/user-attachments/assets/83137d30-9bb8-41c4-9dab-27328cedf36a

## Setup

```bash
npm install
npx playwright install chromium
```

Node >= 20. Optional keys in `.env` or the environment: `OPENAI_API_KEY` (narration; falls back to macOS `say`), `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` (only for the standalone `extract` and `animate` commands).

## Quick start

```bash
npx tsx cli.ts init-config ./demo        # scaffold anim.config.json next to your index.html
npx tsx cli.ts check ./demo              # schema, timing, and every target in a headless browser
npx tsx cli.ts build ./demo              # animated.html, a self-playing page
npx tsx cli.ts preview ./demo            # preview.png: one labelled frame per step
npx tsx cli.ts export ./demo -o demo.mp4 --guide --narration
```

`export` writes `demo.mp4`, `demo.vtt`, chapters, and `./demo/guide/` (`guide.json`, `guide.md`, `guide.html`, `assets/step-NN.png`). The length comes from the timeline.

A timeline is a list of timed interactions on CSS selectors:

```json
{
  "meta": { "title": "Create your first report", "cursor": "mac" },
  "steps": [
    { "id": "intro", "time": "0s", "action": "fadeIn", "target": "body", "title": "Overview", "subtitle": "Welcome to the dashboard." },
    { "id": "open",  "time": "2s", "action": "click", "target": ".btn-primary", "title": "Open the report builder", "narration": "Click the primary button." },
    { "id": "zoom",  "time": "4s", "action": "camera", "target": ".btn-primary", "scale": 1.3, "duration": 2 }
  ]
}
```

### With an AI agent

Paste your screenshots into the agent's chat and ask for the demo:

> *"Here are the three screens of our onboarding. Recreate them, write a timeline that walks through signing up, and export the video with a guide, in English and French."*

The agent writes `index.html` and `anim.config.json`, runs `check`, `build` and `preview` (it reads the PNG and fixes the timeline), exports with `--guide`, then `localize`s and exports each language. The workflow and every file format are in [AGENTS.md](AGENTS.md).

### Other languages

```bash
npx tsx cli.ts localize ./demo fr        # ./demo/locales/fr/ + strings.fr.json, pre-filled
# translate strings.fr.json and the visible text of locales/fr/index.html
npx tsx cli.ts export ./demo/locales/fr -o demo-fr.mp4 --guide
```

### A whole help site

```bash
npx tsx cli.ts build-all                 # every guide x locale of help.catalog.json -> help-out/
npx tsx cli.ts build-all --changed-only --diff
npx tsx cli.ts build-all --help          # catalog schema
```

### A live app instead of a mockup

```bash
npx playwright codegen --save-storage auth.json https://app.local/login   # sign in once
npx tsx cli.ts record ./guides/save --url https://app.local/save --storage-state auth.json -o save.mp4 --guide
```

### Standalone, with an LLM API key

```bash
npx tsx cli.ts extract screenshot.png ./demo --provider gemini      # screenshot -> index.html
npx tsx cli.ts animate ./demo "Fade in, then click the primary button" --provider claude
npx tsx cli.ts export ./demo -o demo.mp4
```

## Tech

Node.js + TypeScript through `tsx` (no build step), `commander`, Playwright Chromium, `ffmpeg-static` (libx264, crf 18), `pixelmatch` for the staleness diff. Desktop exports record at 1920x1080 (mobile 390x844) at 2x pixel density; `--width`/`--height` override.

Contributing: `npm test` runs the suite (serial, with browser tests; `SKIP_BROWSER=1` to skip them); `npm run docs` regenerates the CLI reference below from `cli.ts`, and `npm run docs:check` fails when it is stale.

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
| `-c, --cursor <style>` | Cursor style: mac, windows, none (default: `none`) |
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
