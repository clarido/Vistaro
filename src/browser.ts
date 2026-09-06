import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runtimeSource } from './engine/inject';

export interface ViewportOptions {
    device?: string;
    width?: string | number;
    height?: string | number;
    theme?: string;
}

export interface ContextOptions extends ViewportOptions {
    deviceScaleFactor?: number;
    /** Playwright storage state file (cookies + localStorage), e.g. from `npx playwright codegen --save-storage auth.json`. */
    storageState?: string;
    /** Inject src/engine/runtime.js at document start on every navigation (live pages). */
    runtime?: boolean;
    /** Set `window.__ANIM_DRIVEN = true` before every document loads so built pages never self-play. Default true. */
    driven?: boolean;
}

export interface LaunchOptions extends ContextOptions {
    recordVideoDir?: string;
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

async function newContext(browser: Browser, opts: LaunchOptions): Promise<{ context: BrowserContext; width: number; height: number }> {
    const { width, height } = resolveViewport(opts);
    if (opts.storageState && !fs.existsSync(opts.storageState)) throw new Error(`storage state file not found: ${opts.storageState}`);
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: opts.deviceScaleFactor ?? 2,
        colorScheme: opts.theme === 'dark' ? 'dark' : 'light',
        ...(opts.storageState ? { storageState: path.resolve(opts.storageState) } : {}),
        ...(opts.recordVideoDir ? { recordVideo: { dir: opts.recordVideoDir, size: { width, height } } } : {}),
    });
    if (opts.driven !== false) {
        await context.addInitScript(() => { (window as any).__ANIM_DRIVEN = true; });
    }
    if (opts.runtime) {
        // Same runtime file as `build` inlines; delivered at document start so it survives real navigations.
        await context.addInitScript({ content: runtimeSource() });
    }
    return { context, width, height };
}

export async function launchPage(opts: LaunchOptions = {}): Promise<LaunchedPage> {
    const browser = await chromium.launch({ headless: true });
    let context: BrowserContext;
    let page: Page;
    let width = 0, height = 0;
    try {
        ({ context, width, height } = await newContext(browser, opts));
        page = await context.newPage();
    } catch (e) {
        await browser.close().catch(() => {});
        throw e;
    }
    const close = async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    };
    return { browser, context, page, width, height, close };
}

/** A second driven page in an existing browser (no video), e.g. the guide capture pass after an export. */
export async function newDrivenPage(browser: Browser, opts: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
    const { context } = await newContext(browser, opts);
    const page = await context.newPage();
    return { context, page, close: async () => { await page.close().catch(() => {}); await context.close().catch(() => {}); } };
}

/** file:// URL for a local path (properly percent-encoded). */
export function fileUrl(p: string): string {
    return pathToFileURL(path.resolve(p)).href;
}

/** Fail fast: any HTTP response (even 4xx/5xx) means the server is there; a connection error does not. */
export async function assertReachable(url: string, timeoutMs = 5000): Promise<void> {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
    if (u.protocol === 'file:') {
        if (!fs.existsSync(decodeURIComponent(u.pathname))) throw new Error(`file not found: ${u.pathname}`);
        return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported URL scheme: ${u.protocol}`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    } catch (e: any) {
        throw new Error(`URL unreachable: ${url} (${e && e.cause && e.cause.code ? e.cause.code : e && e.name === 'AbortError' ? `no response within ${timeoutMs}ms` : e.message})`);
    } finally {
        clearTimeout(t);
    }
}
