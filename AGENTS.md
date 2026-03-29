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

## Code style

- TypeScript with `tsx` runtime (no build step)
- No test suite currently
- CLI framework: `commander`
