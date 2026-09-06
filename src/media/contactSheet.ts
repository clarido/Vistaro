import type { Browser } from 'playwright';

export interface SheetFrame {
    label: string;
    png: Buffer;
    error?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Render a labelled grid of frames to a single PNG using the browser itself
 * (no image library). Returns the PNG bytes.
 */
export async function renderContactSheet(browser: Browser, frames: SheetFrame[], opts: { title?: string; columns?: number; cellWidth?: number } = {}): Promise<Buffer> {
    const columns = opts.columns ?? 2;
    const cellWidth = opts.cellWidth ?? 640;
    const gap = 16;
    const pad = 24;
    const pageWidth = pad * 2 + columns * cellWidth + (columns - 1) * gap;
    const cells = frames.map((f, i) => `
      <figure class="cell${f.error ? ' err' : ''}">
        <img src="data:image/png;base64,${f.png.toString('base64')}" alt="frame ${i + 1}">
        <figcaption>${esc(f.label)}${f.error ? `<span class="e">${esc(f.error)}</span>` : ''}</figcaption>
      </figure>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; background: #0f172a; color: #e2e8f0; font: 14px/1.4 -apple-system, "Segoe UI", sans-serif; }
      main { padding: ${pad}px; width: ${pageWidth - pad * 2}px; }
      h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; color: #f8fafc; }
      .grid { display: grid; grid-template-columns: repeat(${columns}, ${cellWidth}px); gap: ${gap}px; }
      .cell { margin: 0; background: #1e293b; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
      .cell.err { outline: 3px solid #ef4444; }
      .cell img { display: block; width: ${cellWidth}px; height: auto; }
      figcaption { padding: 10px 12px; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      figcaption .e { display: block; color: #fca5a5; font-weight: 400; white-space: normal; }
    </style></head><body><main>${opts.title ? `<h1>${esc(opts.title)}</h1>` : ''}<div class="grid">${cells}</div></main></body></html>`;

    const context = await browser.newContext({ viewport: { width: pageWidth, height: 800 }, deviceScaleFactor: 1 });
    try {
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        return await page.screenshot({ fullPage: true, type: 'png' });
    } finally {
        await context.close();
    }
}
