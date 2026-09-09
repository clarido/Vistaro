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
import { buildAllCommand } from './src/commands/build-all';

import { toolPackage } from './src/catalog';

/**
 * The commander program with every command registered. Exported (without parsing) so
 * scripts/gen-cli-reference.ts can render the CLI reference from the same definitions.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('anim-cli')
    .description('Turn a UI mockup (index.html + anim.config.json) or a live web page into a demo video, a step-by-step help guide, and their translations')
    .version(toolPackage().version);

  program.addHelpText('after', `
=========================================
USAGE GUIDE
=========================================
Inputs: a directory with index.html (the screen) and anim.config.json (the timeline:
what the cursor does, when, with titles/subtitles/narration per step). Outputs: an MP4
(with .vtt subtitles and chapters), a step guide (guide.json/md/html + frames), and the
same for every language. Read AGENTS.md for the full manual and the file contracts.

WORKFLOW (an AI agent or a person writes the screen and the timeline; no API key):
  1. Write <dir>/index.html (a faithful mockup of the screen) and the timeline:
       npx tsx cli.ts init-config <dir>        # scaffolds anim.config.json (object form)
  2. Validate: selectors, timing, strings, and every target in a headless browser:
       npx tsx cli.ts check <dir>
  3. Build the self-playing page (no LLM):
       npx tsx cli.ts build <dir>              # writes animated.html
  4. Look at one frame per step, fix the timeline, repeat:
       npx tsx cli.ts preview <dir>            # writes preview.png (contact sheet)
       npx tsx cli.ts preview <dir> --step 3   # one full-size frame
  5. Record the video and the guide (length comes from the timeline):
       npx tsx cli.ts export <dir> -o demo.mp4 --guide --narration
  6. Other languages reuse the same choreography:
       npx tsx cli.ts localize <dir> fr        # <dir>/locales/fr/ + strings.fr.json
       npx tsx cli.ts export <dir>/locales/fr -o demo-fr.mp4 --guide
  7. Many guides x languages at once, from help.catalog.json:
       npx tsx cli.ts build-all [--changed-only] [--diff]   # see build-all --help

MARKETING REELS (a silent product clip instead of a help guide):
  Set "kind": "reel" in meta. The spotlight, click ripple and subtitle bar switch off, the
  guide-shaped validation stops applying, and \`--guide\` on a reel is refused.
    npx tsx cli.ts check   reels/ask-anything --device mobile --scale 2
    npx tsx cli.ts preview reels/ask-anything --device mobile
    npx tsx cli.ts export  reels/ask-anything -o clip.mp4 --device mobile --scale 2
    npx tsx cli.ts build   reels/ask-anything --embed --device mobile
  \`export\` writes clip.mp4 (silent), clip.webm, clip.poster.png and clip.gif, with no .vtt and no
  chapters. \`build --embed\` adds embed-<device>.html, a self-contained page that plays when scrolled
  into view and loops, plus embed-<device>.snippet.html for the hosting page.
  \`--scale N\` records N times denser by multiplying the viewport and zooming the page back; media
  queries evaluate at the scaled width, so a reel's breakpoint must sit above it. One responsive
  index.html covers both form factors: "only": "desktop" drops a step on mobile, and a
  "mobile": {...} block overrides fields for that device.
  New step action: "animate", with "from"/"to" (opacity, x, y, scale, rotate or any CSS property),
  "all" + "stagger" for a sequence, and "ease" (linear, easeInCubic, easeOutCubic, easeInOutCubic,
  easeOutBack, easeOutExpo, spring). "ease" also applies to "camera".

LIVE PAGES (a real app instead of a mockup):
  anim.config.json targets are selectors in the app (prefer data-help="..." attributes);
  steps may carry "waitFor" and "navigate". Sign in once with
    npx playwright codegen --save-storage auth.json <url>
  then: npx tsx cli.ts record <dir> --url <url> --storage-state auth.json -o demo.mp4 --guide

TIMELINE (anim.config.json, object form):
  {
    "meta": { "title": "Create your first report", "slug": "create-first-report", "cursor": "mac" },
    "steps": [
      { "id": "intro", "time": "0s",  "action": "fadeIn", "target": "body", "title": "Overview", "subtitle": "Welcome." },
      { "id": "open",  "time": "2s",  "action": "click", "target": ".btn-primary", "title": "Open the builder", "narration": "Click the button." },
      { "id": "zoom",  "time": "4s",  "action": "camera", "target": ".btn-primary", "scale": 1.3, "duration": 2 },
      { "id": "note",  "time": "7s",  "action": "type", "target": "#prompt", "value": "Generate a report", "translatable": true }
    ]
  }
  "time" is the moment the interaction happens ("2s", "2000ms" or seconds as a number); the
  cursor starts moving up to 950ms earlier. Give every step an "id": translations and guide
  frames attach to it. Actions: wait, click, focus, type (with "value"), highlight, hover,
  camera, scroll, fadeIn, transitionScreen, press (with "value"), navigate (with "url", live
  pages only). click/focus/type/highlight/hover get a spotlight and a click ripple; camera
  pans/zooms toward the target; scroll brings it into view.

STANDALONE WITH AN LLM API KEY (GEMINI_API_KEY or ANTHROPIC_API_KEY, .env or env):
  npx tsx cli.ts extract <image> <dir> --provider gemini|claude   # screenshot -> index.html
  npx tsx cli.ts animate <dir> "<prompt>" --provider gemini|claude # prompt -> anim.config.json + animated.html
  Override the model with --model, GEMINI_MODEL or CLAUDE_MODEL.

RECORD OF WHAT WAS DONE:
  Every command that writes something (extract, animate, build, export, record, guide,
  localize, build-all; not check, preview or init-config) appends an event to
  <dir>/anim.manifest.json (command, options, locale, step timings, content hash / build
  key). Read it before re-doing someone else's work.
`);

  program
    .command('init-config')
    .description('Scaffold an anim.config.json timeline file in the target directory')
    .argument('<output_dir>', 'Directory to initialize the config in')
    .option('--kind <profile>', 'Which profile to scaffold: guide (default) or reel (silent looping product clip)', 'guide')
    .option('--force', 'Overwrite an existing anim.config.json')
    .action((dir, opts) => initConfigCommand(dir, opts));

  program
    .command('extract')
    .description('Extract an HTML/CSS essence from a screenshot (needs an LLM API key)')
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
    .description('Write anim.config.json + animated.html from a prompt (needs an LLM API key; agents write the timeline themselves and run build)')
    .argument('<output_dir>', 'Directory containing the generated HTML essence')
    .argument('<prompt>', 'Prompt describing the desired animation')
    .option('-p, --provider <provider>', 'LLM provider (gemini or claude)', 'gemini')
    .option('-m, --model <model>', 'LLM model ID (e.g. gemini-2.5-flash, claude-haiku-4-5-20251001). Defaults per provider')
    .option('-c, --cursor <style>', 'Cursor style: mac, windows, none', 'mac')
    .option('-l, --loop', 'Loop the generated HTML animation endlessly')
    .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
    .action((dir, prompt, opts) => animateCommand(dir, prompt, opts));

  program
    .command('build')
    .description('Build animated.html from index.html + anim.config.json (no LLM, no API key)')
    .argument('<output_dir>', 'Directory containing index.html and anim.config.json')
    .option('-c, --cursor <style>', 'Cursor style: mac, windows, none (default: meta.cursor or mac)')
    .option('--device <type>', 'Which device\'s timeline to bake in (resolves "only"/"mobile"/"desktop" steps): desktop or mobile', 'desktop')
    .option('--embed', 'Also write embed.html (a framable, self-contained clip) and embed.snippet.html (the parent-side iframe snippet)')
    .option('-l, --loop', 'Loop the animation endlessly when opened in a browser')
    .option('--locale <code>', 'Locale code for this output (e.g. en, fr) -- recorded in anim.manifest.json')
    .option('--force', 'Build even if the timeline has validation errors')
    .option('-o, --output <file>', 'Write the built HTML somewhere other than <output_dir>/animated.html')
    .action((dir, opts) => buildCommand(dir, opts));

  program
    .command('check')
    .description('Validate anim.config.json: schema, timing, strings, and (unless --static/--live) every target selector in a headless browser')
    .argument('<output_dir>', 'Directory containing anim.config.json (and index.html unless --live)')
    .option('--static', 'Schema and timing checks only, no browser')
    .option('--scale <n>', 'Pixel density used for the recording: the viewport is multiplied by N and the page zoomed back, so media queries see the scaled width')
    .option('--live', 'Validate a timeline meant for `record` (live page): navigate/waitFor allowed, no index.html needed; add --url to also probe every target against the page')
    .option('--url <url>', 'With --live: probe every target against this page. The timeline is replayed for real (clicks, keystrokes and saves happen), so reset the app first when it writes data')
    .option('--storage-state <file>', 'Live probe: Playwright storage state (cookies/localStorage)')
    .option('--ignore-https-errors', 'Live probe: accept self-signed certificates')
    .option('--reset-cmd <command>', 'Live probe: shell command run before the pass')
    .option('--allow-reset', 'Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this)')
    .option('--guide', 'Validate as a guide: a numbered step without a "title" is an error, not a warning')
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
    .option('--scale <n>', 'Pixel density used for the recording: the viewport is multiplied by N and the page zoomed back, so media queries see the scaled width')
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
    .description('Record the timeline to an MP4/GIF (plus .vtt subtitles, chapters, optional narration and step guide); the length comes from the timeline')
    .argument('<output_dir>', 'Directory containing index.html + anim.config.json (or a legacy animated.html)')
    .option('-d, --duration <seconds>', 'Override the export length in seconds (default: computed from the timeline; 5 without a config)')
    .option('-o, --output <file>', 'Output video file path (.mp4 or .gif)', 'output.mp4')
    .option('-w, --width <pixels>', 'Width of the exported video in pixels')
    .option('-H, --height <pixels>', 'Height of the exported video in pixels')
    .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
    .option('--scale <n>', 'Pixel density: multiply the viewport by N and zoom the page back, so the frame is N times denser (media queries then see the scaled width)')
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
    .option('--reset-cmd <command>', 'Shell command run before each pass over the app (the recording, then the --guide replay); used instead of meta.reset, and never needs --allow-reset')
    .option('--allow-reset', 'Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this)')
    .option('--fail-fast', 'Abandon the recording at the first waitFor timeout instead of recording the rest against the wrong page state')
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
    .option('--reset-cmd <command>', 'After a `record`: shell command run before the live replay')
    .option('--allow-reset', 'Let "meta.reset" from anim.config.json run (a shell command out of a file; --reset-cmd never needs this)')
    .option('--locale <code>', 'Locale code (e.g. en, fr)')
    .option('--force', 'Capture even if the timeline has validation errors; step failures then do not fail the command')
    .option('-w, --width <pixels>', 'Viewport width in pixels')
    .option('-H, --height <pixels>', 'Viewport height in pixels')
    .option('--device <type>', 'Device viewport constraints: desktop or mobile', 'desktop')
    .option('-t, --theme <mode>', 'Color scheme mode: light or dark', 'light')
    .action((dir, opts) => guideCommand(dir, opts));

  program
    .command('build-all')
    .description('Build every guide x locale of help.catalog.json (check, build, export|record --guide) into <outputDir>/<slug>/<locale>/ and merge index.json + index.md; exit 1 on any failure')
    .argument('[catalog]', 'Catalog file', 'help.catalog.json')
    .option('--changed-only', 'Skip a guide x locale whose build key (sources + render settings + tool version) matches what its manifest recorded')
    .option('--diff', 'Keep the previous step frames and mark a guide stale when a frame changed beyond --diff-threshold')
    .option('--diff-threshold <fraction>', 'Fraction of changed pixels that marks a guide stale', '0.02')
    .option('--only <slug>', 'Build one guide')
    .option('--locale <code>', 'Build one locale')
    .option('--continue-on-error', 'Keep going after a failed guide (default: stop at the first failure)')
    .option('--dry-run', 'Print the plan per guide x locale and stop: nothing is created, written or recorded')
    .option('--verbose', 'Also stream the child commands\' stdout (their stderr is always streamed, prefixed with slug/locale)')
    .option('--allow-reset', 'Let each guide\'s "meta.reset" run before its passes (a shell command out of its anim.config.json)')
    .addHelpText('after', `
CATALOG SCHEMA (help.catalog.json; paths are relative to the catalog file):
  {
    "outputDir": "help-out",                 // required; not the root, your home dir, a literal "~", the catalog dir, or overlapping a guide dir
    "defaults": {                            // optional; every key is also valid per guide (the guide wins)
      "locales": ["en", "fr"],               // locale codes to produce (default: the base locale only)
      "outputs": ["guide"],                  // extras: guide, gif, clips, webm, poster, embed; the video is always produced
      "width": 1920, "height": 1080,         // viewport in px
      "theme": "light",                      // light | dark
      "narration": false,                    // synthesize step narration (OPENAI_API_KEY or macOS say)
      "crop": 120,                           // guide crop padding in px, or false for full frames only
      "hideCursor": false,                   // hide the fake cursor in guide frames
      "device": "desktop",                   // render device: desktop | mobile
      "scale": 1                             // pixel density, as --scale on export
    },
    "guides": [
      { "slug": "draft-proposal", "dir": "demo", "title": "Draft a proposal" },
      { "slug": "settings", "dir": "guides/settings", "locales": { "fr": "guides/settings-fr" } },
      { "slug": "live-save", "dir": "live/save", "record": { "url": "https://app.local/save", "storageState": "auth.json", "ignoreHttpsErrors": true } },
      { "slug": "ask-anything", "dir": "reels/ask-anything", "kind": "reel",
        "devices": ["desktop", "mobile"], "scale": 2, "outputs": ["webm", "poster", "gif", "embed"] }
    ]
  }
  slug: lowercase-kebab, unique; it names <outputDir>/<slug>/<locale>/ and <slug>-<locale>.mp4.
  dir: contains anim.config.json and index.html (index.html not needed with "record").
  locales: a list of codes (found at <dir>/locales/<code>/, or the legacy sibling <dir>/../<code>/)
           or a { code: path } map; the base locale is the guide directory itself.
  record: build against a live page (check --live, then record); no build step.
  kind: guide (default) or reel. A reel produces no guide and defaults its outputs to
        ["webm", "poster", "gif"].
  devices: reels only; one row per device into the same <slug>/<locale>/, with the device in every
        filename (ask-anything-en-mobile.mp4, embed-mobile.html). Such a row's manifest key is
        <locale>:<device>, while a guide keeps the plain locale key.

WHAT IT WRITES:
  <outputDir>/<slug>/<locale>/<slug>-<locale>.mp4 (+ .vtt, + .gif with "gif"), guide/guide.json|md|html,
  guide/assets/ (poster.png, step-NN.png, step-NN.crop.png, clips), and <outputDir>/index.json + index.md.
  A reel writes <slug>-<locale>-<device>.mp4 plus .webm, .poster.png, .gif and the embed pair, and no guide.
  index.json entries: slug, locale, kind, device, title, dir, output, status (ok|failed|skipped), contentHash,
  buildKey, builtAt, video, vtt, gif, webm, poster, embed, guide, guideMd, guideHtml, durationMs, steps,
  stale/diff (--diff), error.
  The index is merged by (slug, locale, device) with the previous run, so --only/--locale never drop
  other entries and a reel's two device rows stay separate.

INCREMENTAL RUNS:
  --changed-only skips a guide x locale whose manifest buildKey[locale] (sources + settings + tool) is
  unchanged and whose video exists; --diff compares the new step frames with the previous ones and marks
  the entry "stale" above the threshold (previous frames + step-NN.diff.png kept in guide/.previous/).
  --dry-run prints the plan and writes nothing.
`)
    .action((catalog, opts) => buildAllCommand(catalog, opts));

  program
    .command('localize')
    .description('Scaffold <source_dir>/locales/<locale>/ with index.html, anim.config.json, media and a pre-filled strings.<locale>.json; the choreography is reused as is')
    .argument('<source_dir>', 'Existing output directory to localize from (contains index.html, optionally anim.config.json)')
    .argument('<locale>', 'Target locale code, e.g. fr, es, pt-BR')
    .option('-o, --output-dir <dir>', 'Directory to scaffold into (default: <source_dir>/locales/<locale>)')
    .option('--sibling', 'Legacy layout: scaffold into a sibling directory named after the locale')
    .option('--force', 'Overwrite the target\'s index.html, anim.config.json and strings.<locale>.json (translations are lost); by default they are kept and only new strings are added')
    .action((src, locale, opts) => localizeCommand(src, locale, opts));

  return program;
}

/**
 * The command is done, so the process must follow it out. A browser that refused to close (see
 * closeBrowser) or any other handle left ref'd keeps node alive indefinitely with every byte of
 * output already printed -- and a caller that waits on this child (build-all's runCli, the test
 * suite's spawnSync) then waits forever. That is why a hung run reads as a loop rather than a
 * failure. Give the event loop a grace period to drain by itself, then say what is holding it open
 * and leave. The timer is unref'd, so a healthy run still exits the instant its work is done.
 */
const EXIT_GRACE_MS = 5000;
function exitWhenDrained(): void {
  const timer = setTimeout(() => {
    // Requests as well as handles: a pending libuv request (threadpool fs, dns, zlib) holds the loop
    // open too, and counting only handles would print "0 handle(s)" in the one situation where this
    // message is the whole diagnostic.
    const open: unknown[] = [...((process as any)._getActiveHandles?.() ?? []), ...((process as any)._getActiveRequests?.() ?? [])];
    const kinds = [...new Set(open.map(h => (h as any)?.constructor?.name ?? typeof h))].join(', ') || 'unknown';
    console.error(`warning  the command finished but ${open.length} handle(s)/request(s) still hold this process open (${kinds}); exiting with ${process.exitCode ?? 0} anyway`);
    process.exit(process.exitCode ?? 0);
  }, EXIT_GRACE_MS);
  timer.unref();
}

if (require.main === module) {
  dotenv.config({ quiet: true });
  buildProgram().parseAsync(process.argv)
    .catch((e) => {
      console.error(`Error: ${e && e.message ? e.message : e}`);
      // exitCode rather than exit(1): the same drain-then-leave path as a success, so a failure
      // that also leaked a handle exits instead of hanging with its error message already printed.
      process.exitCode = 1;
    })
    .finally(exitWhenDrained);
}

