import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import { pathToFileURL } from 'url';

export interface ViewportOptions {
    device?: string;
    width?: string | number;
    height?: string | number;
    theme?: string;
}

export interface LaunchOptions extends ViewportOptions {
    /** Set `window.__ANIM_DRIVEN = true` before every document loads so built pages never self-play. Default true. */
    driven?: boolean;
    recordVideoDir?: string;
    deviceScaleFactor?: number;
}

export interface LaunchedPage {
    browser: Browser;
    context: BrowserContext;
    page: Page;
    width: number;
    height: number;
    close: () => Promise<void>;
}

export function resolveViewport(opts: ViewportOptions): { width: number; height: number; isMobile: boolean } {
    const isMobile = opts.device === 'mobile';
    const width = opts.width ? parseInt(String(opts.width), 10) : (isMobile ? 390 : 1920);
    const height = opts.height ? parseInt(String(opts.height), 10) : (isMobile ? 844 : 1080);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw new Error(`invalid viewport ${opts.width}x${opts.height}`);
    }
    return { width, height, isMobile };
}

export async function launchPage(opts: LaunchOptions = {}): Promise<LaunchedPage> {
    const { width, height } = resolveViewport(opts);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: opts.deviceScaleFactor ?? 2,
        colorScheme: opts.theme === 'dark' ? 'dark' : 'light',
        ...(opts.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir, size: { width, height } } } : {}),
    });
    if (opts.driven !== false) {
        await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    }
    const page = await context.newPage();
    const close = async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    };
    return { browser, context, page, width, height, close };
}

/** file:// URL for a local path (properly percent-encoded). */
export function fileUrl(p: string): string {
    return pathToFileURL(path.resolve(p)).href;
}
