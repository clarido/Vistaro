#!/usr/bin/env tsx
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { extractCommand } from './src/commands/extract';
import { animateCommand } from './src/commands/animate';
import { exportCommand } from './src/commands/export';
import { localizeCommand } from './src/commands/localize';
import { buildCommand } from './src/commands/build';
import { initConfigCommand } from './src/commands/init-config';

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
  4. Build it:         npx tsx cli.ts build <output_dir>      (writes animated.html, no LLM)
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
  This scaffolds <locale>/ with index.html + anim.config.json copied over. Translate
  the visible text and "subtitle" strings only -- targets are CSS selectors, not
  text, so the same choreography (clicks, camera pans, highlights) replays correctly.

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
  .command('export')
  .description('Export the animated HTML to an MP4 video using Playwright')
  .argument('<output_dir>', 'Directory containing the animated HTML essence')
  .option('-d, --duration <seconds>', 'Duration of the export in seconds', '5')
  .option('-o, --output <file>', 'Output video file path (.mp4 or .gif)', 'output.mp4')
  .option('-w, --width <pixels>', 'Width of the exported video in pixels')
  .option('-H, --height <pixels>', 'Height of the exported video in pixels')
  .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
  .option('-t, --theme <mode>', 'Color scheme mode for Playwright: light or dark', 'light')
  .option('-v, --voiceover <path>', 'Path to a text file containing the voiceover script')
  .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
  .action((dir, opts) => exportCommand(dir, opts));

program
  .command('localize')
  .description('Scaffold a translated locale directory from an existing output dir, reusing the same timeline/choreography')
  .argument('<source_dir>', 'Existing output directory to localize from (contains index.html, optionally anim.config.json)')
  .argument('<locale>', 'Target locale code, e.g. fr, es, ja')
  .option('-o, --output-dir <dir>', 'Directory to scaffold into (default: a sibling directory named after the locale)')
  .action((src, locale, opts) => localizeCommand(src, locale, opts));

program.parseAsync(process.argv).catch((e) => {
  console.error(`Error: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
