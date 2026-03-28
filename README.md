# Screenshot Animator CLI

A CLI designed to generate HTML mockup UI from screenshots using Vision LLMs, animate them with CSS via Text LLMs, and export to `.mp4` locally using headless Chromium and FFmpeg.

Built by an AI, for an AI. Tell your AI to run `npx tsx cli.ts --help` to read the orchestration usage guide.

## Features
- **Screenshot to UI**: Feed it a static image, and it uses Vision LLMs to extract a pristine, responsive HTML/CSS markup reproduction.
- **AI-Driven Animation**: Orchestrate powerful CSS keyframes (typing, clicking, fading) purely from text prompts via a clean JSON timeline configuration.
- **Voiceovers & Subtitles**: Natively overlays styled subtitles that match your animation delays, and leverages macOS Text-to-Speech to synthesize voiceover audio directly into the final video.
- **Theme & Viewport Modes**: Natively forces `--device desktop|mobile` resolutions and triggers specific `--theme light|dark` media queries when recording.
- **Framework Targeting**: Render raw `html` blocks, or explicitly define `--framework react` to export responsive Tailwind TSX components.
- **Headless Pilot Ready**: Highly composable CLI perfectly suited for zero-touch interaction by terminal AI agents (Claude Code, Antigravity, Codex).

## Example

### Firm Profile Animation
Watch the CLI take a static dashboard screenshot and animate a complete, realistic user workflow sequence.

**Original Input Screenshot:**
> <img width="1414" height="716" alt="screenshot input" src="https://github.com/user-attachments/assets/744cd3d5-c4cd-4c15-b671-460667965def" />

**Generated Output Video:**
> https://github.com/user-attachments/assets/83137d30-9bb8-41c4-9dab-27328cedf36a

---

## Tech Stack
- **Runtime**: Node.js & TypeScript (`tsx`)
- **CLI Framework**: `commander`
- **Generative AI SDKs**: `@google/generative-ai`, `@anthropic-ai/sdk`
- **Render Engine**: Playwright Chromium (Headless)
- **Video Encoders**: `ffmpeg-static`

## Setup
1. Ensure `node` and `npm` are installed.
2. Run `npm install`
3. Run `npx playwright install chromium`
4. **Provide your LLM API Keys** (optional if using an AI agent)
   - Create a `.env` file or set environment variables:
     ```bash
     GEMINI_API_KEY="..."       # For Gemini provider
     ANTHROPIC_API_KEY="..."    # For Claude provider
     OPENAI_API_KEY="..."       # Optional, for TTS voiceovers
     ```
   - If the requested provider's key is missing but the other is available, the CLI automatically falls back.
   - To override default models, set `GEMINI_MODEL` or `CLAUDE_MODEL` (or use `--model` on each command).
   - **Using an AI agent?** Skip the `.env` entirely. Paste your screenshot directly into the agent's chat (Claude Code, Codex, Antigravity). The agent writes the HTML/CSS and animation files itself, then only calls `export` which needs no API key.

## Quick Start

### With an API key (standalone)
You need a screenshot **saved as a file on disk** to pass to the `extract` command:

```bash
# 1. Extract HTML/CSS from your screenshot file
npx tsx cli.ts extract app-screenshot.png ./demo-output

# 2. Generate an animation sequence
npx tsx cli.ts animate ./demo-output "Fade in the dashboard, wait 1 second, and click the primary button"

# 3. Render the animation to an MP4 video
npx tsx cli.ts export ./demo-output --duration 5 --output my-animated-demo.mp4
```

### With an AI agent (no API key)
**Paste your screenshot directly into the chat** -- no file path needed.
The agent sees the image, writes the HTML and animations itself, and only runs `export`:

> *"Look at this screenshot I just pasted, extract it, and generate an animation
> timeline that explains the main areas of the screen."*

The agent will create `index.html`, `anim.config.json`, and `animated.html` in
the output directory, then run:

```bash
npx tsx cli.ts export ./demo-output --duration 20 --output my-demo.mp4
```

## Usage
Extract HTML / CSS mockup from a screenshot:
```bash
npx tsx cli.ts extract <path_to_image> <output_directory> [options]
# Options:
# --provider gemini|claude
# --model <model_id>          (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001)
# --abstraction none|moderate|high
# --device desktop|mobile
# --framework html|react
# --theme light|dark
```
> **Tip:** Use `--abstraction high` if you want a minimal wireframe representation, or keep it `none` for a 1-to-1 match. Use `--framework react` to output a Tailwind-styled TSX component instead of plain HTML.

Animate the HTML elements based on text prompt:
```bash
npx tsx cli.ts animate <output_directory> "<animation prompt instruction...>" [options]
# Options:
# --provider gemini|claude
# --model <model_id>          (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001)
# --cursor mac|windows|none
# --loop                       (loop the animation endlessly)
```
> **Tip:** You can run `npx tsx cli.ts init-config <output_directory>` before animating to scaffold an `anim.config.json` file. 
> Example:
> ```json
> [
>   { "time": "0s", "action": "fadeIn", "target": "#screen1", "subtitle": "Welcome to the dashboard." },
>   { "time": "2s", "action": "click", "target": ".btn-primary", "subtitle": "Click to begin." }
> ]
> ```
> **Subtitles are fully supported!** The CLI reads the `subtitle` keys and drops an absolute-positioned DOM overlay onto the video, flawlessly tracking your CSS animation delays without the LLM needing to hallucinate it!

Capture the animating HTML via screen recording and save (MP4 or GIF):
```bash
npx tsx cli.ts export <output_directory> --duration 8 --output result.gif [options]
# Options:
# --device desktop|mobile
# --theme light|dark
# --voiceover script.txt
```
> **Tip:** Passing `--theme dark` natively enforces the active CSS media-query to dark mode during Playwright recording. If `--voiceover` is also provided, the CLI will pipe macOS native Text-to-Speech seamlessly through the final MP4.

## Running via AI Agents (Claude Code, Codex, Antigravity)
This CLI is designed to work as a toolkit for AI coding agents. The key difference
from standalone usage is that **the agent is the LLM** -- it doesn't need to call
an external API to understand your screenshot or generate animations.

**How it works:**
1. **Paste** your screenshot directly into the agent's chat window (no file path needed).
2. The agent looks at the image and writes `index.html`, `anim.config.json`, and `animated.html` directly.
3. The agent runs `npx tsx cli.ts export <dir>` to render the video -- this is the only command it needs.

**No `.env` file or API keys required.** The `extract` and `animate` commands exist
for standalone usage; agents skip them entirely.

**Example prompt:**
> *"Look at this screenshot I just pasted, extract it, generate an animation timeline
> where clicking the primary button causes a ripple, and export the final video."*
