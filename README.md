# HTML Video Editor CLI

A CLI designed to generate HTML mockup UI from screenshots using Vision LLMs, animate them with CSS via Text LLMs, and export to `.mp4` locally using headless Chromium and FFmpeg.

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
4. Create a `.env` file with `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`.

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
