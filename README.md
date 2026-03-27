# Screenshot Animator CLI

A CLI designed to generate HTML mockup UI from screenshots using Vision LLMs, animate them with CSS via Text LLMs, and export to `.mp4` locally using headless Chromium and FFmpeg.

## Features
- **🪄 Screenshot to UI**: Feed it a static image, and it uses Vision LLMs to extract a pristine, responsive HTML/CSS markup reproduction.
- **🎬 AI-Driven Animation**: Orchestrate powerful CSS keyframes (typing, clicking, fading) purely from text prompts via a clean JSON timeline configuration.
- **🎙️ Voiceovers & Subtitles**: Natively overlays styled subtitles that match your animation delays, and leverages macOS Text-to-Speech to synthesize voiceover audio directly into the final video.
- **🌗 Theme & Viewport Modes**: Natively forces `--device desktop|mobile` resolutions and triggers specific `--theme light|dark` media queries when recording.
- **⚛️ Framework Targeting**: Render raw `html` blocks, or explicitly define `--framework react` to export responsive Tailwind TSX components.
- **🤖 Headless Pilot Ready**: Highly composable CLI perfectly suited for zero-touch interaction by terminal AI agents (Claude Code, Antigravity, Codex).

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
4. **Provide your LLM API Keys**
   - *Manual mode*: Create a `.env` file with `GEMINI_API_KEY="..."` or `ANTHROPIC_API_KEY="..."` (and optionally `OPENAI_API_KEY="..."` for hyper-realistic TTS voiceovers).
   - *Agentic mode*: Skip this! If you run this project using **Claude Code**, **Antigravity**, or **Codex**, they will automatically pipe their own keys and execute the commands for you.

## Quick Start (End-to-End)
Want to see it in action quickly? Grab a screenshot of any UI (e.g. `app-screenshot.png`), lay it in this folder, and run these 3 commands:

```bash
# 1. Extract HTML/CSS from your screenshot
npx tsx cli.ts extract app-screenshot.png ./demo-output

# 2. Generate an Animation Sequence
npx tsx cli.ts animate ./demo-output "Fade in the dashboard, wait 1 second, and click the primary button"

# 3. Render the animation to an MP4 video
npx tsx cli.ts export ./demo-output --duration 5 --output my-animated-demo.mp4
```

Boom! `my-animated-demo.mp4` is ready! 

## Usage
Extract HTML / CSS mockup from a screenshot:
```bash
npx tsx cli.ts extract <path_to_image> <output_directory> [options]
# Options:
# --provider gemini|claude
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
# --cursor mac|windows|none
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

## 🤖 Running via AI Agents (Claude Code, Antigravity, Codex)
Because this is a completely headless CLI, you can hand it over entirely to an agentic coding assistant! If you use an assistant like **Claude Code**, **Antigravity**, or **Codex**, you can simply drop a screenshot in your folder and tell the agent:

> *"Take `app-screenshot.png`, extract it, generate an animation where clicking the primary button causes a ripple, and export the final video."*

The assistant will automatically execute the TSX commands on your behalf, pipe its own API keys if needed, and hand you the finished `.mp4`.
