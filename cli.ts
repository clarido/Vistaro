#!/usr/bin/env tsx
import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { extractCommand } from './src/commands/extract';
import { animateCommand } from './src/commands/animate';
import { exportCommand } from './src/commands/export';

dotenv.config();

const program = new Command();

program
  .name('anim-cli')
  .description('HTML Video Editor CLI powered by LLMs')
  .version('1.0.0');

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
  2. Optionally create anim.config.json with a timeline.
  3. Write animated.html with CSS animations and subtitles.
  4. Run only the export command to record the video:
     => npx tsx cli.ts export <output_dir> --duration <seconds> --output <file.mp4>

MODEL CONFIGURATION:
  Override the default model via CLI flag or environment variable:
  - CLI:  --model gemini-2.5-flash  or  --model claude-haiku-4-5-20251001
  - Env:  GEMINI_MODEL=gemini-2.5-flash  or  CLAUDE_MODEL=claude-haiku-4-5-20251001
  - Defaults: gemini-2.5-pro (Gemini), claude-sonnet-4-6 (Claude)

  If the requested provider's API key is missing but the other is available,
  the CLI will automatically fall back to the available provider.

CONFIG TIMELINES (anim.config.json):
  Run \`npx tsx cli.ts init-config <dir>\` to scaffold the JSON timeline schema:
  [
    { "time": "0s", "action": "fadeIn", "target": "#screen1", "subtitle": "First step..." },
    { "time": "2s", "action": "click", "target": ".btn-primary", "subtitle": "Click the button." }
  ]
  The \`animate\` command ingests this file if it exists.
`);

program
  .command('init-config')
  .description('Scaffold an anim.config.json timeline file in the target directory')
  .argument('<output_dir>', 'Directory to initialize the config in')
  .action((dir) => {
      const fs = require('fs');
      const path = require('path');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const config = [
          { time: '0s', action: 'fadeIn', target: '#screen1', subtitle: 'Welcome to the dashboard.' },
          { time: '2s', action: 'click', target: '.btn-primary', subtitle: 'Click the primary button to begin.' },
          { time: '3s', action: 'transitionScreen', target: '#screen2', subtitle: null }
      ];
      fs.writeFileSync(path.join(dir, 'anim.config.json'), JSON.stringify(config, null, 2));
      console.log('Created anim.config.json timeline schema!');
  });

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
  .action((dir, prompt, opts) => animateCommand(dir, prompt, opts));

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
  .action((dir, opts) => exportCommand(dir, opts));

program.parse(process.argv);
