import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { runtimeSource } from './engine/inject';

export interface ViewportOptions {
    device?: string;
    width?: string | number;
    height?: string | number;
    theme?: string;
    /**
     * Pixel density for the recording. Playwright paints one CSS pixel per video pixel and pads the
     * rest with grey, so more pixels means a bigger CSS viewport, not a bigger `recordVideo.size`:
     * `--scale 2` doubles the viewport and shrinks the layout box back with `:root { zoom: 2 }`.
     * Media queries then evaluate at the scaled width, which is an authoring constraint.
     */
    scale?: string | number;
}

/** A recent Android Chrome UA, so a page that sniffs the agent renders its mobile form. */
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';

export interface ContextOptions extends ViewportOptions {
    deviceScaleFactor?: number;
    /** Playwright storage state file (cookies + localStorage), e.g. from `npx playwright codegen --save-storage auth.json`. */
    storageState?: string;
    /** Inject src/engine/runtime.js at document start on every navigation (live pages). */
    runtime?: boolean;
    /** Set `window.__ANIM_DRIVEN = true` before every document loads so built pages never self-play. Default true. */
    driven?: boolean;
    /** Accept self-signed / mkcert certificates (local HTTPS). */
    ignoreHttpsErrors?: boolean;
    /**
     * Turn on Chromium's mobile emulation (isMobile/hasTouch/mobile UA) alongside the mobile
     * viewport. Off by default on purpose: emulation also enables viewport-meta handling, and a
     * mockup without a `<meta name="viewport">` then lays out at 980px instead of the viewport
     * width. Existing guide mockups (demo/, test/fixtures/basic/) have no such meta, so switching
     * this on for every `--device mobile` would silently reflow them. Reels declare the meta and
     * want the emulation, so `export` enables it for a `kind: "reel"` timeline.
     */
    emulateMobile?: boolean;
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

export function resolveViewport(opts: ViewportOptions): { width: number; height: number; isMobile: boolean; scale: number } {
    const isMobile = opts.device === 'mobile';
    const scale = opts.scale === undefined ? 1 : parseFloat(String(opts.scale));
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`invalid scale ${JSON.stringify(opts.scale)} (a positive multiplier, e.g. 2)`);
    const baseWidth = opts.width ? parseInt(String(opts.width), 10) : (isMobile ? 390 : 1920);
    const baseHeight = opts.height ? parseInt(String(opts.height), 10) : (isMobile ? 844 : 1080);
    if (!Number.isFinite(baseWidth) || baseWidth <= 0 || !Number.isFinite(baseHeight) || baseHeight <= 0) {
        throw new Error(`invalid viewport ${opts.width}x${opts.height}`);
    }
    // The viewport is also the encode size, and libx264 with yuv420p rejects an odd dimension.
    const even = (n: number) => (n % 2 === 0 ? n : n + 1);
    return { width: even(Math.round(baseWidth * scale)), height: even(Math.round(baseHeight * scale)), isMobile, scale };
}

async function newContext(browser: Browser, opts: LaunchOptions): Promise<{ context: BrowserContext; width: number; height: number }> {
    const { width, height, isMobile } = resolveViewport(opts);
    if (opts.storageState && !fs.existsSync(opts.storageState)) throw new Error(`storage state file not found: ${opts.storageState}`);
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: opts.deviceScaleFactor ?? 2,
        colorScheme: opts.theme === 'dark' ? 'dark' : 'light',
        ignoreHTTPSErrors: !!opts.ignoreHttpsErrors,
        // `--device mobile` was only a viewport size before: isMobile was computed and thrown away, so
        // `@media (pointer: coarse)` never matched and a UA-sniffing page served its desktop form.
        ...(isMobile && opts.emulateMobile ? { isMobile: true, hasTouch: true, userAgent: MOBILE_USER_AGENT } : {}),
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
        await closeWithWatchdog(() => page.close(), 'page');
        await closeWithWatchdog(() => context.close(), 'context');
        await closeBrowser(browser);
    };
    return { browser, context, page, width, height, close };
}

/** A second driven page in an existing browser (no video), e.g. the guide capture pass after an export. */
export async function newDrivenPage(browser: Browser, opts: ContextOptions = {}): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
    const { context } = await newContext(browser, opts);
    const page = await context.newPage();
    return { context, page, close: async () => { await closeWithWatchdog(() => page.close(), 'page'); await closeWithWatchdog(() => context.close(), 'context'); } };
}

/**
 * Give up on a browser that would not close, and say so loudly. What is left behind is not merely
 * an orphaned Chromium: it is a live Playwright connection, which keeps THIS process alive with
 * all its work already done and printed, so a caller waiting on the CLI (build-all's runCli, the
 * test suite's spawnSync) waits for a child that will never exit. Playwright exposes no handle on
 * the browser process to kill from here, so the backstop is exitWhenDrained() in cli.ts: it forces
 * the exit, and Playwright's own `process.on('exit')` hook kills the browser on the way out.
 */
export async function closeBrowser(browser: Browser, timeoutMs = 10000): Promise<void> {
    await closeWithWatchdog(() => browser.close(), 'browser', timeoutMs);
    if (browser.isConnected()) console.error('warning  the browser is still connected after close(); the exit watchdog will force it down');
}

/** Close calls can hang on a page stuck mid-navigation; never let that keep the CLI alive. */
export async function closeWithWatchdog(fn: () => Promise<void>, what: string, timeoutMs = 10000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<void>((resolve) => { timer = setTimeout(() => { console.error(`warning  ${what} did not close within ${timeoutMs}ms; continuing`); resolve(); }, timeoutMs); });
    try { await Promise.race([fn().catch(() => {}), watchdog]); }
    finally { if (timer) clearTimeout(timer); }
}

/** file:// URL for a local path (properly percent-encoded). */
export function fileUrl(p: string): string {
    return pathToFileURL(path.resolve(p)).href;
}

const SECRET_PARAM = /token|key|secret|password|passwd|auth|session|sig|signature|credential|apikey|api_key|access|bearer/i;

/** URL safe to print and record: userinfo stripped, token-like query values redacted. */
export function sanitizeUrl(url: string): string {
    let u: URL;
    try { u = new URL(url); } catch { return url.replace(/\/\/[^@/]+@/, '//'); }
    u.username = '';
    u.password = '';
    for (const [k, v] of [...u.searchParams.entries()]) {
        if (SECRET_PARAM.test(k) && v) u.searchParams.set(k, '***');
    }
    u.hash = sanitizeFragment(u.hash);
    return u.toString();
}

/**
 * The OAuth implicit flow returns credentials in the fragment (`#access_token=...&token_type=...`),
 * which reaches the manifest and the guide like any other URL. Key/value fragments are redacted per
 * key, exactly like the query; a fragment that is not key/value but looks like a bare token is
 * redacted whole. An ordinary anchor (`#section-2`) is left alone.
 */
function sanitizeFragment(hash: string): string {
    const raw = hash.replace(/^#/, '');
    if (!raw) return hash;
    if (/[=&]/.test(raw)) {
        const parts = raw.split('&').map(pair => {
            const eq = pair.indexOf('=');
            if (eq < 0) return pair;
            const k = pair.slice(0, eq);
            const v = pair.slice(eq + 1);
            return SECRET_PARAM.test(decodeURIComponent(k)) && v ? `${k}=***` : pair;
        });
        return '#' + parts.join('&');
    }
    // A bare fragment that looks like a secret rather than an anchor: long and not word-like.
    return /^[A-Za-z0-9._~+/-]{24,}$/.test(raw) && /\d/.test(raw) ? '#***' : hash;
}

/**
 * Fail fast: any HTTP response (even 4xx/5xx) means the server is there; a connection error does
 * not. Uses http/https directly so `ignoreHttpsErrors` can accept a local certificate.
 */
export function assertReachable(url: string, opts: { timeoutMs?: number; ignoreHttpsErrors?: boolean } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    let u: URL;
    try { u = new URL(url); } catch { return Promise.reject(new Error(`invalid URL: ${sanitizeUrl(url)}`)); }
    if (u.username || u.password) return Promise.reject(new Error(`URLs with embedded credentials are not supported (${sanitizeUrl(url)}); log in once and pass --storage-state auth.json`));
    if (u.protocol === 'file:') {
        let local = u.pathname;
        try { local = decodeURIComponent(u.pathname); } catch { /* keep the raw path */ }
        if (!fs.existsSync(local)) return Promise.reject(new Error(`file not found: ${u.pathname}`));
        return Promise.resolve();
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.reject(new Error(`unsupported URL scheme: ${u.protocol}`));
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise<void>((resolve, reject) => {
        const req = mod.request(u, { method: 'GET', timeout: timeoutMs, ...(u.protocol === 'https:' ? { rejectUnauthorized: !opts.ignoreHttpsErrors } : {}) }, (res) => {
            res.resume();
            resolve();
        });
        req.on('timeout', () => { req.destroy(new Error(`no response within ${timeoutMs}ms`)); });
        req.on('error', (e: any) => {
            const detail = e && e.code ? e.code : (e && e.message ? e.message : String(e));
            const hint = /CERT|certificate|self.signed|unable to verify/i.test(detail) ? ' (self-signed certificate? pass --ignore-https-errors)' : '';
            reject(new Error(`URL unreachable: ${sanitizeUrl(url)} (${detail})${hint}`));
        });
        req.end();
    });
}
