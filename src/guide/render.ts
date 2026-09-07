import * as fs from 'fs';
import * as path from 'path';

/** guide.json contract (version 1). Paths are relative to the guide directory; rects in CSS px. */
export interface GuideStepJson {
    index: number;
    number: number;
    id: string;
    action: string;
    target?: string;
    scheduledMs: number;
    actualMs: number;
    /** Moment the frame was taken: cursor actions at the interaction, state actions at completion, navigating clicks at the arrival (before the click). */
    capturedAt: 'interaction' | 'completion' | 'arrival';
    title?: string;
    subtitle?: string;
    narration?: string;
    note?: string;
    /** Full frame; absent only when the screenshot itself failed (see `error`). */
    image?: string;
    crop?: string;
    /**
     * Box the spotlight framed (the sized ancestor when the target was 0x0), CSS px. null when the
     * step has no element to locate (target-less press/navigate) or failed: the frame just shows the result.
     */
    rect?: { x: number; y: number; width: number; height: number } | null;
    /** The raw target box when it differs from `rect`. */
    targetRect?: { x: number; y: number; width: number; height: number };
    /** Badge position (top-left, CSS px, clamped into the viewport). null exactly when `rect` is null. */
    callout?: { number: number; x: number; y: number } | null;
    clip?: string;
    audio?: string;
    audioDurationMs?: number;
    error?: string;
}

export interface GuideVideoJson {
    file: string;
    durationMs: number;
    poster?: string;
    subtitles?: string;
    narration: boolean;
    chapters: { startMs: number; endMs: number; title: string }[];
    /** Subtitle cues inlined for guide.html (a <track> file is blocked by CORS on file://). */
    cues?: { startMs: number; endMs: number; text: string }[];
}

export interface GuideJson {
    version: 1;
    slug: string;
    title: string;
    app?: string;
    locale: string;
    baseLocale: string;
    generatedAt: string;
    /** `dir` is the source directory's basename only (never an absolute path). */
    source: { dir: string; contentHash: string; tool: string };
    viewport: { width: number; height: number; deviceScaleFactor: number; theme: string };
    video: GuideVideoJson | null;
    steps: GuideStepJson[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const mdEsc = (s: string) => s.replace(/([\\`*_])/g, '\\$1');

export function stepHeading(s: GuideStepJson): string {
    if (s.title && s.title.trim()) return s.title.trim();
    const verb: Record<string, string> = { click: 'Click', focus: 'Focus', type: 'Type into', highlight: 'Notice', hover: 'Hover', scroll: 'Scroll to', fadeIn: 'See', transitionScreen: 'Go to', press: 'Press', navigate: 'Open', wait: 'Wait' };
    const what = s.action === 'press' ? '' : (s.target || '');
    return `${verb[s.action] || s.action} ${what}`.trim();
}

/** guide.md: H1, per step "## N. title", note, image (crop when available), subtitle blockquote, video link. */
export function renderMarkdown(g: GuideJson): string {
    const lines: string[] = [`# ${mdEsc(g.title)}`, ''];
    if (g.app) lines.push(`*${mdEsc(g.app)}*`, '');
    if (g.video) {
        lines.push(`[Watch the video](${g.video.file})${g.video.subtitles ? ` · [subtitles](${g.video.subtitles})` : ''} · ${(g.video.durationMs / 1000).toFixed(1)}s`, '');
    }
    for (const s of g.steps) {
        lines.push(`## ${s.number}. ${mdEsc(stepHeading(s))}`, '');
        if (s.note) lines.push(s.note, '');
        if (s.crop || s.image) lines.push(`![Step ${s.number}](${s.crop || s.image})`, '');
        if (s.error) lines.push(`> **Capture failed:** ${s.error}`, '');
        if (s.subtitle) lines.push(`> ${s.subtitle}`, '');
        if (s.clip) lines.push(`[Clip](${s.clip})`, '');
    }
    const dirName = g.source.dir.split(/[\\/]/).filter(Boolean).pop() || g.source.dir;
    lines.push('---', '', `Generated ${g.generatedAt} by ${g.source.tool} from \`${dirName}\` (${g.source.contentHash.slice(0, 19)}…).`, '');
    return lines.join('\n');
}

/** guide.html: self-contained page with the video (+ VTT track) and the numbered steps. */
export function renderHtml(g: GuideJson): string {
    const css = `
    :root { color-scheme: light; }
    body { margin: 0; background: #f8fafc; color: #0f172a; font: 16px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; }
    main { max-width: 960px; margin: 0 auto; padding: 40px 24px 80px; }
    h1 { font-size: 30px; margin: 0 0 6px; } .app { color: #64748b; margin: 0 0 24px; }
    video { width: 100%; border-radius: 12px; background: #000; box-shadow: 0 12px 32px rgba(15,23,42,.18); margin: 0 0 40px; }
    .chapters { margin: -28px 0 40px; font-size: 14px; color: #475569; } .chapters a { color: #2563eb; text-decoration: none; margin-right: 12px; }
    .step { display: grid; grid-template-columns: 44px 1fr; gap: 16px; margin: 0 0 40px; }
    .num { width: 36px; height: 36px; border-radius: 50%; background: #3b82f6; color: #fff; font-weight: 600; display: flex; align-items: center; justify-content: center; }
    .step h2 { font-size: 20px; margin: 4px 0 8px; } .note { color: #334155; margin: 0 0 12px; }
    .step img { max-width: 100%; border-radius: 10px; border: 1px solid #e2e8f0; box-shadow: 0 8px 24px rgba(15,23,42,.12); }
    blockquote { margin: 12px 0 0; padding: 8px 14px; border-left: 3px solid #3b82f6; background: #eff6ff; color: #1e3a8a; border-radius: 0 8px 8px 0; }
    .clip { display: inline-block; margin-top: 8px; font-size: 14px; color: #2563eb; }
    footer { margin-top: 48px; font-size: 13px; color: #94a3b8; }`;
    const video = g.video ? `
    <video controls preload="metadata"${g.video.poster ? ` poster="${esc(g.video.poster)}"` : ''} src="${esc(g.video.file)}">${g.video.subtitles && !(g.video.cues && g.video.cues.length) ? `<track kind="subtitles" src="${esc(g.video.subtitles)}" srclang="${esc(g.locale)}" label="${esc(g.locale)}" default>` : ''}</video>
    ${g.video.chapters.length ? `<p class="chapters">${g.video.chapters.map(c => `<a href="#t=${(c.startMs / 1000).toFixed(1)}" data-start="${c.startMs}">${(c.startMs / 1000).toFixed(1)}s ${esc(c.title)}</a>`).join('')}</p>` : ''}` : '';
    const steps = g.steps.map(s => `
    <section class="step" id="${esc(s.id)}">
      <div class="num">${s.number}</div>
      <div>
        <h2>${esc(stepHeading(s))}</h2>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
        ${(s.crop || s.image) ? `<img src="${esc(s.crop || s.image!)}" alt="Step ${s.number}${s.title ? ': ' + esc(s.title) : ''}" loading="lazy">` : ''}
        ${s.error ? `<p class="note"><strong>Capture failed:</strong> ${esc(s.error)}</p>` : ''}
        ${s.subtitle ? `<blockquote>${esc(s.subtitle)}</blockquote>` : ''}
        ${s.clip ? `<a class="clip" href="${esc(s.clip)}">Watch this step</a>` : ''}
      </div>
    </section>`).join('');
    const cuesJson = g.video && g.video.cues && g.video.cues.length ? JSON.stringify(g.video.cues).replace(/</g, '\\u003c') : '';
    const script = g.video && (g.video.chapters.length || cuesJson) ? `
    <script>
      (function () {
        var v = document.querySelector('video');
        document.querySelectorAll('.chapters a').forEach(function (a) {
          a.addEventListener('click', function (e) { e.preventDefault(); v.currentTime = Number(a.dataset.start) / 1000; v.play(); });
        });
        ${cuesJson ? `var track = v.addTextTrack('subtitles', ${JSON.stringify(g.locale)}, ${JSON.stringify(g.locale)});
        ${cuesJson}.forEach(function (c) { track.addCue(new VTTCue(c.startMs / 1000, c.endMs / 1000, c.text)); });
        track.mode = 'showing';` : ''}
      })();
    </script>` : '';
    return `<!doctype html>
<html lang="${esc(g.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.title)}</title>
<style>${css}
</style>
</head>
<body>
  <main>
    <h1>${esc(g.title)}</h1>
    ${g.app ? `<p class="app">${esc(g.app)}</p>` : ''}${video}${steps}
    <footer>Generated ${esc(g.generatedAt)} by ${esc(g.source.tool)}.</footer>
  </main>${script}
</body>
</html>
`;
}

export interface WrittenGuide { json: string; md: string; html: string }

export function writeGuide(outDir: string, g: GuideJson): WrittenGuide {
    fs.mkdirSync(outDir, { recursive: true });
    const json = path.join(outDir, 'guide.json');
    const md = path.join(outDir, 'guide.md');
    const html = path.join(outDir, 'guide.html');
    fs.writeFileSync(json, JSON.stringify(g, null, 2) + '\n');
    fs.writeFileSync(md, renderMarkdown(g));
    fs.writeFileSync(html, renderHtml(g));
    return { json, md, html };
}
