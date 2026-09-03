# CLAUDE.md

## What is this project?

Screenshot Animator CLI -- a Node.js/TypeScript CLI that converts screenshots into animated HTML/CSS mockups and exports them as MP4 or GIF videos. It uses Vision LLMs to extract UI from images, Text LLMs to generate CSS animations, and Playwright + FFmpeg to record the result.

Built to be used **by AI agents directly**. When an agent (Claude Code, Codex, Antigravity) is driving, it skips the LLM API calls entirely -- the agent writes the HTML and animations itself, then only calls `export`.

## Setup

```bash
npm install
npx playwright install chromium
```

API keys are optional when used by an agent. For standalone usage, set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `.env` or as environment variables.

## Project structure

```
cli.ts                    # Entry point (commander CLI)
src/
  commands/
    extract.ts            # Screenshot -> HTML/CSS via Vision LLM
    animate.ts            # HTML -> animated HTML via Text LLM
    export.ts             # Playwright + FFmpeg recording to MP4/GIF
  providers.ts            # LLM provider abstraction (Gemini, Claude)
```

## Getting help

Run `npx tsx cli.ts --help` for the full usage guide, or get help for a specific command:

```bash
npx tsx cli.ts --help
npx tsx cli.ts extract --help
npx tsx cli.ts animate --help
npx tsx cli.ts export --help
```

## Key commands

```bash
# Extract HTML from a screenshot (needs API key)
npx tsx cli.ts extract <image_path> <output_dir> [--provider gemini|claude]

# Generate animations from a prompt (needs API key)
npx tsx cli.ts animate <output_dir> "<prompt>" [--provider gemini|claude]

# Export to video (no API key needed)
npx tsx cli.ts export <output_dir> --duration <seconds> --output <file.mp4>
```

## Multiple screenshots

Paste multiple screenshots directly into the agent's chat window. The agent sees all of them, reproduces each screen in HTML, and can combine them into a single animated flow with transitions.

Example prompts:

> "Here are 3 screenshots of our onboarding flow. Recreate each screen and animate a walkthrough that transitions between them with a fade."

> "I'm pasting the login page and the dashboard. Animate a user logging in on the first screen, then transition to the dashboard with the stats fading in."

The agent writes all screens into one `animated.html` (e.g. fade out screen 1, fade in screen 2) and exports a single video:

```bash
npx tsx cli.ts export ./output --duration 15 --output onboarding-flow.mp4
```

For standalone usage (with API keys), extract each screenshot into its own directory:

```bash
npx tsx cli.ts extract login.png ./output/login --provider gemini
npx tsx cli.ts extract dashboard.png ./output/dashboard --provider gemini
```

## Agent workflow (no API key)

When acting as the agent, skip `extract` and `animate`. Instead:

1. Write `index.html` with the UI markup into the output directory.
2. Write `anim.config.json` with the animation timeline:
   ```json
   [
     { "time": "0s", "action": "fadeIn", "target": "#screen1", "subtitle": "Welcome." },
     { "time": "2s", "action": "click", "target": ".btn-primary", "subtitle": "Click to begin." }
   ]
   ```
3. Write `animated.html` with CSS keyframe animations and subtitle overlays.
4. Run: `npx tsx cli.ts export <output_dir> --duration <seconds> --output <file.mp4>`

## Cinematic polish (Scribe-style output)

Two things separate a good demo video from an amateur one: a **spotlight highlight** on whatever the cursor is about to interact with, and a **cinematic camera** that pushes in on the relevant area instead of holding a static wide shot the whole time. Both are now first-class:

- `npx tsx cli.ts animate` (LLM-driven path, `--cursor mac|windows` + `anim.config.json`) injects all of this automatically: a glowing spotlight box around the target element on `click`/`focus`/`type`/`highlight` steps, an expanding ripple pulse on `click`, and support for `camera` and `scroll` steps.
- When you (the agent) hand-write `animated.html` directly -- the common path since you skip `extract`/`animate` -- replicate the same visual language so output quality stays consistent. Paste this before `</head>` and `</body>`:

```html
<style>
#anim-cli-highlight { position: fixed; border-radius: 10px; border: 2px solid #3B82F6; box-shadow: 0 0 0 4px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.35); pointer-events: none; z-index: 99996; opacity: 0; transition: left .5s cubic-bezier(.16,1,.3,1), top .5s cubic-bezier(.16,1,.3,1), width .5s cubic-bezier(.16,1,.3,1), height .5s cubic-bezier(.16,1,.3,1); }
#anim-cli-highlight.anim-cli-pulse { animation: anim-cli-highlightPulse 1.3s cubic-bezier(.16,1,.3,1) forwards; }
@keyframes anim-cli-highlightPulse { 0% { opacity:0 } 15% { opacity:1 } 75% { opacity:1 } 100% { opacity:0 } }
.anim-cli-ripple { position: fixed; width:14px; height:14px; margin:-7px 0 0 -7px; border-radius:50%; background: rgba(59,130,246,.35); border: 2px solid rgba(59,130,246,.65); pointer-events:none; z-index:99997; animation: anim-cli-rippleAnim .6s cubic-bezier(.16,1,.3,1) forwards; }
@keyframes anim-cli-rippleAnim { 0% { width:14px; height:14px; margin:-7px 0 0 -7px; opacity:.9 } 100% { width:80px; height:80px; margin:-40px 0 0 -40px; opacity:0 } }
</style>
```

Then, wherever your timeline script moves the fake cursor to an element and clicks/types into it, call a `highlight(el)` helper that positions `#anim-cli-highlight` over the element's `getBoundingClientRect()` (with ~6px padding) and re-triggers the `.anim-cli-pulse` class, and a `ripple(x, y)` helper that drops a `.anim-cli-ripple` div at the click point and removes it after ~700ms. For a camera push-in, transition `document.body.style.transform` (e.g. `scale(1.3) translate(Xpx, Ypx)` computed to center the target element) over 1.5-3s with `cubic-bezier(.65,0,.35,1)` -- see `src/commands/animate.ts` for the exact reference implementation if you want to copy it verbatim.

**Timeline action vocabulary** (works whether you write the timeline as JSON for `animate` or drive your own hand-written script):
- `fadeIn`, `click`, `focus`, `type` (types `value` char-by-char), `transitionScreen`
- `highlight` -- spotlight an element without clicking it (good for "notice this" beats)
- `camera` -- `{ "action": "camera", "target": "#el", "scale": 1.3, "duration": 2 }` pans/zooms the whole page to center on `target` (or use explicit `x`/`y` instead of `target`)
- `scroll` -- `{ "action": "scroll", "target": "#el" }` smooth-scrolls the element into view

## CLI options

- `--provider gemini|claude` -- select LLM provider (auto-falls back if key missing)
- `--model <id>` -- override default model (e.g. `gemini-2.5-flash`, `claude-haiku-4-5-20251001`)
- `--device desktop|mobile` -- viewport size for extract/export
- `--theme light|dark` -- forces CSS media query during recording
- `--framework html|react` -- output format for extract
- `--abstraction none|moderate|high` -- wireframe fidelity level
- `--cursor mac|windows|none` -- cursor style in animations
- `--loop` -- loop animation endlessly
- `--voiceover <script.txt>` -- macOS TTS voiceover in exported video
- `--width` / `--height` -- override the export resolution (defaults: 1920x1080 desktop, 390x844 mobile, recorded at 2x pixel density for crisp/retina-quality video; encoded with libx264 `-crf 18 -preset slow` for near-lossless output)

## Code style

- TypeScript with `tsx` runtime (no build step)
- No test suite currently
- CLI framework: `commander`
