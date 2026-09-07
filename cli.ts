#!/usr/bin/env tsx
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { extractCommand } from './src/commands/extract';
import { animateCommand } from './src/commands/animate';
import { exportCommand } from './src/commands/export';
import { localizeCommand } from './src/commands/localize';
import { buildCommand } from './src/commands/build';
import { checkCommand } from './src/commands/check';
import { previewCommand } from './src/commands/preview';
import { initConfigCommand } from './src/commands/init-config';
import { guideCommand } from './src/commands/guide';
import { recordCommand } from './src/commands/record';

dotenv.config({ quiet: true });

const program = new Command();

program
  .name('anim-cli')
  .description('HTML Video Editor CLI powered by LLMs')
  .version('1.1.0');

program.addHelpText('after', `
=========================================
USAGE GUIDE
=========================================
This CLI tool builds and records animated UI mockups. It can be used standalone
with an API key, or as a toolkit for LLM agents (like Claude Code) who generate
the HTML themselves.

WORKFLOW A — WITH API KEY (standalone):
  Requires GEMINI_API_KEY or ANTHROPIC_API_KEY (env var or .env file).

  1. EXTRACT: Convert a screenshot to HTML/CSS.
     => npx tsx cli.ts extract <image_path> <output_dir> --provider <gemini|claude>

  2. ANIMATE: Add animations via natural language prompt.
     => npx tsx cli.ts animate <output_dir> "<prompt>" --provider <gemini|claude>

  3. EXPORT: Record to MP4 or GIF.
     => npx tsx cli.ts export <output_dir> --duration <seconds> --output <file.mp4>

WORKFLOW B — WITHOUT API KEY (LLM agent like Claude Code):
  The agent acts as the brain — no API key needed. Just paste or provide a
  screenshot in the chat. The agent will:

  1. Look at the screenshot and write index.html directly into <output_dir>.
  2. Write anim.config.json with the timeline (npx tsx cli.ts init-config <output_dir>).
  3. Validate it:      npx tsx cli.ts check <output_dir>
  4. Build it:         npx tsx cli.ts build <output_dir>      (writes animated.html, no LLM)
  5. Review frames:    npx tsx cli.ts preview <output_dir>    (writes preview.png, one frame per step)
  6. Record the video: npx tsx cli.ts export <output_dir> --duration <seconds> --output <file.mp4>

MODEL CONFIGURATION:
  Override the default model via CLI flag or environment variable:
  - CLI:  --model gemini-2.5-flash  or  --model claude-haiku-4-5-20251001
  - Env:  GEMINI_MODEL=gemini-2.5-flash  or  CLAUDE_MODEL=claude-haiku-4-5-20251001
  - Defaults: gemini-2.5-pro (Gemini), claude-sonnet-4-6 (Claude)

  If the requested provider's API key is missing but the other is available,
  the CLI will automatically fall back to the available provider.

RECORDING & MULTI-LANGUAGE EXPORTS:
  Every animate/build/export/localize call appends a timestamped entry to
  <output_dir>/anim.manifest.json automatically -- a record of what was done.

  To reuse a timeline for another language instead of rebuilding it:
    => npx tsx cli.ts localize <output_dir> <locale>
  This scaffolds <output_dir>/locales/<locale>/ with index.html + anim.config.json + media
  copied over and a pre-filled strings.<locale>.json (titles, subtitles, narration, notes,
  translatable typed text). Translate the strings file and the visible text of index.html
  only -- targets are CSS selectors, not text, so the same choreography (clicks, camera
  pans, highlights) replays correctly. Every command applies strings.<locale>.json for the
  directory's locale (--locale > anim.manifest.json > meta.locale).

CONFIG TIMELINES (anim.config.json):
  Run \`npx tsx cli.ts init-config <dir>\` to scaffold the JSON timeline schema:
  {
    "meta": { "title": "Create your first report", "cursor": "mac" },
    "steps": [
      { "time": "0s", "action": "fadeIn", "target": "body", "title": "Overview", "subtitle": "First step..." },
      { "time": "2s", "action": "click", "target": ".btn-primary", "title": "Open", "subtitle": "Click the button." },
      { "time": "4s", "action": "camera", "target": ".btn-primary", "scale": 1.3, "duration": 2 },
      { "time": "7s", "action": "scroll", "target": "#footer" }
    ]
  }
  A bare array of steps (no "meta") is also accepted. "time" is the moment the interaction
  happens ("2s", "2000ms" or a number of seconds); the cursor starts moving up to 950ms earlier.
  Actions: wait, click, focus, type (with "value"), highlight, hover, camera, scroll, fadeIn,
  transitionScreen. click/focus/type/highlight steps get a spotlight highlight + click ripple;
  camera pans/zooms the page toward a target; scroll smooth-scrolls an element into view.
`);

program
  .command('init-config')
  .description('Scaffold an anim.config.json timeline file in the target directory')
  .argument('<output_dir>', 'Directory to initialize the config in')
  .option('--force', 'Overwrite an existing anim.config.json')
  .action((dir, opts) => initConfigCommand(dir, opts));

program
  .command('extract')
  .description('Extract an HTML/CSS essence from a screenshot')
  .argument('<image_path>', 'Path to the screenshot image')
  .argument('<output_dir>', 'Directory to save the generated HTML essence')
  .option('-p, --provider <provider>', 'LLM provider (gemini or claude)', 'gemini')
  .option('-m, --model <model>', 'LLM model ID (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001). Defaults per provider')
  .option('-a, --abstraction <level>', 'Abstraction distillation level: none, moderate, high', 'none')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-f, --framework <type>', 'Output framework: html or react', 'html')
  .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
  .action((img, dir, opts) => extractCommand(img, dir, opts));

program
  .command('animate')
  .description('Animate the extracted HTML essence based on a prompt')
  .argument('<output_dir>', 'Directory containing the generated HTML essence')
  .argument('<prompt>', 'Prompt describing the desired animation')
  .option('-p, --provider <provider>', 'LLM provider (gemini or claude)', 'gemini')
  .option('-m, --model <model>', 'LLM model ID (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001). Defaults per provider')
  .option('-c, --cursor <style>', 'Cursor style: mac, windows, none', 'none')
  .option('-l, --loop', 'Loop the generated HTML animation endlessly')
  .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
  .action((dir, prompt, opts) => animateCommand(dir, prompt, opts));

program
  .command('build')
  .description('Build animated.html from index.html + anim.config.json (no LLM, no API key)')
  .argument('<output_dir>', 'Directory containing index.html and anim.config.json')
  .option('-c, --cursor <style>', 'Cursor style: mac, windows, none (default: meta.cursor or mac)')
  .option('-l, --loop', 'Loop the animation endlessly when opened in a browser')
  .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
  .option('--force', 'Build even if the timeline has validation errors')
  .option('-o, --output <file>', 'Write the built HTML somewhere other than <output_dir>/animated.html')
  .action((dir, opts) => buildCommand(dir, opts));

program
  .command('check')
  .description('Validate anim.config.json: schema, timing, and (unless --static) every target selector in a headless browser')
  .argument('<output_dir>', 'Directory containing index.html and anim.config.json')
  .option('--static', 'Schema and timing checks only, no browser')
  .option('--json', 'Print the issues as JSON on stdout')
  .option('--locale <code>', 'Locale code (e.g. en, fr)')
  .option('-w, --width <pixels>', 'Viewport width for the browser pass')
  .option('-H, --height <pixels>', 'Viewport height for the browser pass')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
  .action((dir, opts) => checkCommand(dir, opts));

program
  .command('preview')
  .description('Render one labelled frame per step to <output_dir>/preview.png (or a single full-size frame with --step N)')
  .argument('<output_dir>', 'Directory containing index.html and anim.config.json')
  .option('-s, --step <n>', 'Write only step N (1-based) at full resolution to preview-step-N.png')
  .option('--at <when>', 'Capture point per step: "auto" (like the guide: clicks at the interaction, typing/camera/fades at completion), "interaction", or "end"', 'auto')
  .option('-o, --output <file>', 'Output PNG path')
  .option('-c, --cursor <style>', 'Cursor style: mac, windows, none (default: meta.cursor or mac)')
  .option('--locale <code>', 'Locale code (e.g. en, fr)')
  .option('--force', 'Preview even if the timeline has validation errors')
  .option('-w, --width <pixels>', 'Viewport width in pixels')
  .option('-H, --height <pixels>', 'Viewport height in pixels')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
  .action((dir, opts) => previewCommand(dir, opts));

program
  .command('export')
  .description('Record the timeline to an MP4/GIF (plus .vtt subtitles, chapters, optional narration)')
  .argument('<output_dir>', 'Directory containing index.html + anim.config.json (or a legacy animated.html)')
  .option('-d, --duration <seconds>', 'Override the export length in seconds (default: computed from the timeline; 5 without a config)')
  .option('-o, --output <file>', 'Output video file path (.mp4 or .gif)', 'output.mp4')
  .option('-w, --width <pixels>', 'Width of the exported video in pixels')
  .option('-H, --height <pixels>', 'Height of the exported video in pixels')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode for Playwright: light or dark', 'light')
  .option('--narration', 'Synthesize each step\'s "narration" (or "subtitle") and mix it in at the step\'s time (OPENAI_API_KEY or macOS say)')
  .option('--voice <name>', 'TTS voice (OpenAI voice name, or a macOS `say` voice)')
  .option('-v, --voiceover <path>', 'Path to a text file with a whole-video voiceover script (legacy, starts at 0s)')
  .option('--no-subtitles', 'Do not write <output>.vtt')
  .option('--no-chapters', 'Do not embed MP4 chapters for titled steps')
  .option('--clips <format>', 'Also cut one clip per step next to the video: mp4 or gif')
  .option('--tail <ms>', 'Hold after the last step (overrides meta.tailMs, default 2500)')
  .option('--guide', 'Also write the step-by-step guide (guide.json, guide.md, guide.html, assets/) after the video')
  .option('--guide-dir <dir>', 'Guide output directory (default: <output_dir>/guide)')
  .option('--crop <px>', 'Guide crops: padding around each step\'s box in px (default 120)')
  .option('--no-crop', 'Guide: full frames only, no crops')
  .option('--hide-cursor', 'Guide: hide the fake cursor in the step screenshots')
  .option('--force', 'Export even if the timeline has validation errors; step failures then do not fail the command')
  .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
  .action((dir, opts) => exportCommand(dir, opts));

program
  .command('record')
  .description('Record the timeline against a live page (URL) instead of a local mockup: real navigations, waitFor, storage state')
  .argument('<output_dir>', 'Directory containing anim.config.json (targets are selectors in the live app, e.g. [data-help="save"])')
  .option('--url <url>', 'Page to open (default: meta.url in anim.config.json)')
  .option('--storage-state <file>', 'Playwright storage state (cookies/localStorage), e.g. from `npx playwright codegen --save-storage auth.json`')
  .option('--ignore-https-errors', 'Accept self-signed certificates (mkcert-style local HTTPS)')
  .option('-o, --output <file>', 'Output video file path (.mp4 or .gif)', 'output.mp4')
  .option('-d, --duration <seconds>', 'Override the recording length in seconds (default: computed from the timeline)')
  .option('-w, --width <pixels>', 'Width of the recorded video in pixels')
  .option('-H, --height <pixels>', 'Height of the recorded video in pixels')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
  .option('--narration', 'Synthesize each step\'s narration and mix it in')
  .option('--voice <name>', 'TTS voice')
  .option('--no-subtitles', 'Do not write <output>.vtt')
  .option('--no-chapters', 'Do not embed MP4 chapters')
  .option('--clips <format>', 'Also cut one clip per step: mp4 or gif')
  .option('--tail <ms>', 'Hold after the last step (overrides meta.tailMs)')
  .option('--guide', 'Also capture the step guide against the live page (re-navigates, replays in step mode)')
  .option('--guide-dir <dir>', 'Guide output directory (default: <output_dir>/guide)')
  .option('--crop <px>', 'Guide crops: padding around each step\'s box in px (default 120)')
  .option('--no-crop', 'Guide: full frames only')
  .option('--hide-cursor', 'Guide: hide the fake cursor in step screenshots')
  .option('--force', 'Record even if the timeline has validation errors; step failures then do not fail the command')
  .option('--locale <code>', 'Locale code for this output (e.g. en, fr)')
  .action((dir, opts) => recordCommand(dir, opts));

program
  .command('guide')
  .description('Write a Scribe-style step guide (guide.json, guide.md, guide.html + assets/) from index.html + anim.config.json; links the last exported video when present')
  .argument('<output_dir>', 'Directory containing index.html and anim.config.json')
  .option('-o, --output <dir>', 'Guide output directory (default: <output_dir>/guide)')
  .option('--crop <px>', 'Padding around each step\'s box for the cropped image, in px (default 120)')
  .option('--no-crop', 'Full frames only, no crops')
  .option('--clips <format>', 'Cut one clip per step from the last exported video: mp4 or gif')
  .option('--hide-cursor', 'Hide the fake cursor in the step screenshots')
  .option('--url <url>', 'After a `record`: replay against this URL instead of the one in the manifest')
  .option('--storage-state <file>', 'After a `record`: storage state for the live replay (default: the one the record used)')
  .option('--ignore-https-errors', 'Accept self-signed certificates on the live replay')
  .option('--locale <code>', 'Locale code (e.g. en, fr)')
  .option('--force', 'Capture even if the timeline has validation errors; step failures then do not fail the command')
  .option('-w, --width <pixels>', 'Viewport width in pixels')
  .option('-H, --height <pixels>', 'Viewport height in pixels')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
  .action((dir, opts) => guideCommand(dir, opts));

program
  .command('localize')
  .description('Scaffold <source_dir>/locales/<locale>/ with index.html, anim.config.json, media and a pre-filled strings.<locale>.json; the choreography is reused as is')
  .argument('<source_dir>', 'Existing output directory to localize from (contains index.html, optionally anim.config.json)')
  .argument('<locale>', 'Target locale code, e.g. fr, es, pt-BR')
  .option('-o, --output-dir <dir>', 'Directory to scaffold into (default: <source_dir>/locales/<locale>)')
  .option('--sibling', 'Legacy layout: scaffold into a sibling directory named after the locale')
  .option('--force', 'Overwrite an existing strings.<locale>.json in the target instead of merging')
  .action((src, locale, opts) => localizeCommand(src, locale, opts));

program.parseAsync(process.argv).catch((e) => {
  console.error(`Error: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
