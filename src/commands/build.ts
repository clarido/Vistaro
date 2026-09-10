import * as fs from 'fs';
import * as path from 'path';
import { loadTimeline, validateTimeline, formatIssue, hasErrors, computeDurationMs, formatTime, deviceKind, reelOptions, isReel, cliConfigPath, configStem } from '../engine/schema';
import { buildAnimatedHtml } from '../engine/inject';
import { recordEvent } from '../manifest';
import { relPosix } from '../catalog';
import { resolveViewport } from '../browser';

export interface BuildOptions {
    cursor?: string;
    loop?: boolean;
    locale?: string;
    /** --config: a timeline other than <dir>/anim.config.json (cwd-relative on the CLI). */
    config?: string;
    force?: boolean;
    /** Write somewhere other than <dir>/animated.html. */
    output?: string;
    /**
     * Which device's timeline to bake in (`only` / `mobile` / `desktop` step fields). `build` has no
     * --device flag today, so this is desktop unless a programmatic caller says otherwise; a timeline
     * with no per-device fields is unaffected either way.
     */
    device?: string;
    /** Also write embed.html (a framable, self-contained clip) and embed.snippet.html (the parent-side snippet). */
    embed?: boolean;
}

/** Page chrome an embedded clip must not have: no margin, no scrollbars, nothing but the mockup. */
const EMBED_CSS = `<style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
  body { width: 100%; height: 100%; }
</style>`;

/**
 * The parent-side snippet. This exists because an IntersectionObserver INSIDE an iframe measures
 * against the iframe's own viewport, so an off-screen iframe reports itself fully visible and plays
 * to nobody. Only the embedding page knows where the frame really is, so it drives play/pause by
 * postMessage; embed.html listens for that as well as running its own observer for the unframed case.
 */
function embedSnippet(file: string, width: number, height: number, title: string): string {
    const ratio = (height / width * 100).toFixed(3);
    return `<!-- Paste this where the clip should appear. Serve ${file} from the same origin or any https host. -->
<div class="anim-embed" style="position: relative; width: 100%; max-width: ${width}px; padding-top: ${ratio}%;">
  <iframe
    class="anim-embed-frame"
    src="${file}"
    title="${title.replace(/"/g, '&quot;')}"
    loading="lazy"
    scrolling="no"
    style="position: absolute; inset: 0; width: 100%; height: 100%; border: 0;"
  ></iframe>
</div>
<script>
  // The frame cannot see the real viewport, so the parent tells it when to play.
  (function () {
    var frames = document.querySelectorAll('.anim-embed');
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var frame = entry.target.querySelector('.anim-embed-frame');
        if (!frame || !frame.contentWindow) return;
        frame.contentWindow.postMessage({ source: 'anim-cli', type: entry.isIntersecting ? 'play' : 'pause' }, '*');
      });
    }, { threshold: 0.25 });
    Array.prototype.forEach.call(frames, function (f) { io.observe(f); });
  })();
</script>`;
}

/**
 * `build <dir>`: index.html + anim.config.json -> animated.html, no LLM involved.
 * Validation errors abort with exit code 1 unless --force.
 */
export function buildCommand(dir: string, options: BuildOptions = {}): void {
    const htmlPath = path.resolve(dir, 'index.html');
    if (!fs.existsSync(htmlPath)) {
        console.error(`Error: ${htmlPath} not found. Write the UI markup to index.html first.`);
        process.exit(1);
    }

    let timeline;
    try {
        timeline = loadTimeline(dir, { locale: options.locale, device: deviceKind(options.device), config: cliConfigPath(options.config) });
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    const issues = validateTimeline(timeline);
    for (const issue of issues) console.error(formatIssue(issue));
    if (hasErrors(issues)) {
        const n = issues.filter(i => i.level === 'error').length;
        if (!options.force) {
            console.error(`\nBuild aborted: ${n} error(s) in ${path.resolve(dir, 'anim.config.json')} (use --force to build anyway).`);
            process.exit(1);
        }
        console.error(`\n--force: building despite ${n} error(s); those steps will be skipped at playback.`);
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    // `options.loop` stays undefined when the flag is absent, so meta.reel.loop still decides; `!!` here
    // would hand inject.ts an explicit false and silently override the profile.
    const out = buildAnimatedHtml(html, timeline, { cursor: options.cursor, loop: options.loop });
    const stem = configStem(dir, cliConfigPath(options.config));
    const outPath = options.output ? path.resolve(options.output) : path.join(dir, stem ? `animated.${stem}.html` : 'animated.html');
    fs.writeFileSync(outPath, out, 'utf8');

    // The embed pair: a framable page, and the snippet that drives it from the parent.
    let embedFile: string | undefined;
    let snippetFile: string | undefined;
    if (options.embed) {
        const device = deviceKind(options.device);
        const { width, height } = resolveViewport({ device });
        // Named for the device, always: a reel is genuinely two deliverables (a desktop page and a
        // phone-shaped one) and they must coexist in one directory. Unsuffixed names would have the
        // second build silently overwrite the first, leaving a desktop page inside a mobile frame.
        // The stem joins the device for the same reason the device is there at all: with --config,
        // two timelines in one directory would otherwise write the same embed-<device>.html and the
        // second build would silently replace the first.
        const name = stem ? `embed-${stem}-${device}` : `embed-${device}`;
        embedFile = path.join(dir, `${name}.html`);
        const embedHtml = out.includes('</head>') ? out.replace('</head>', `${EMBED_CSS}\n</head>`) : EMBED_CSS + '\n' + out;
        fs.writeFileSync(embedFile, embedHtml, 'utf8');
        snippetFile = path.join(dir, `${name}.snippet.html`);
        fs.writeFileSync(snippetFile, embedSnippet(`${name}.html`, width, height, timeline.meta.title || 'Product clip'), 'utf8');
    }

    const cursor = options.cursor ?? timeline.meta.cursor ?? 'mac';
    recordEvent(dir, { command: 'build', cursor, loop: options.loop ?? reelOptions(timeline).loop, locale: timeline.locale ?? options.locale ?? timeline.meta.locale, force: !!options.force, output: relPosix(path.resolve(dir), outPath) });

    const durationMs = computeDurationMs(timeline);
    console.log(`Built ${outPath} (${timeline.steps.length} steps, ${formatTime(durationMs)} total, cursor: ${cursor}${options.loop ? ', loop' : ''}).`);
    if (embedFile) {
        const reel = reelOptions(timeline);
        console.log(`Embed:  ${embedFile} (autoplay: ${reel.autoplay}${reel.loop ? ', looping' : ''})`);
        console.log(`        ${snippetFile} -- paste into the page that hosts the clip; it posts play/pause from the parent, which is the only place the real viewport is known.`);
    }
    console.log(`Next: npx tsx cli.ts preview ${dir}   # contact sheet of every step`);
    if (isReel(timeline)) {
        // --guide is refused on a reel, so suggesting it would hand the author a failing command.
        console.log(`      npx tsx cli.ts export ${dir} -o clip.mp4 --device mobile --scale 2   # mp4 + webm + poster + gif (${formatTime(durationMs)})`);
        if (!options.embed) console.log(`      npx tsx cli.ts build ${dir} --embed --device mobile   # embed-<device>.html + snippet`);
    } else {
        console.log(`      npx tsx cli.ts export ${dir} -o demo.mp4 --guide   # length from the timeline (${formatTime(durationMs)})`);
    }
}
