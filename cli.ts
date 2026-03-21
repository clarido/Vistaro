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
🤖 LLM ORCHESTRATOR USAGE GUIDE
=========================================
This CLI tool allows AI agents (like Claude Code) to build and record animated UI mockups.

RECOMMENDED WORKFLOW:
1. EXTRACT: Analyze a UI screenshot and generate a clean HTML/CSS mockup.
   => npx tsx cli.ts extract <image_path> <output_dir> --provider <gemini|claude> [--abstraction none|moderate|high]

2. ANIMATE: Inject CSS animations into the mockup based on a natural language prompt.
   => npx tsx cli.ts animate <output_dir> "<prompt_describing_animation>" --provider <gemini|claude>

3. EXPORT: Load the HTML in a headless browser and record it as an MP4 or GIF.
   => npx tsx cli.ts export <output_dir> --duration <seconds> --output <video.mp4|result.gif>
   
NOTES FOR LLM AGENTS:
- Let the CLI commands do the work! Avoid editing the HTML/CSS manually unless it's a small structural fix.
- Always run \`extract\` first to establish the baseline DOM structure.
- You can run \`animate\` multiple times on the same directory to incrementally add animations.
- Use \`--abstraction high\` or \`--abstraction moderate\` during extraction if the prompt requests a wireframe or simplified structural mockup instead of 1-to-1 text matching.

CONFIG TIMELINES (anim.config.json):
If you need strict execution, run \`npx tsx cli.ts init-config <dir>\` to scaffold the JSON timeline schema. Example:
[
  { "time": "0s", "action": "fadeIn", "target": "#screen1", "subtitle": "First step..." },
  { "time": "2s", "action": "click", "target": ".btn-primary", "subtitle": "Now click the button." }
]
The \`animate\` command will ingest this file exactly if it exists!
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
