import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * Tiny live-app fixture (no dependencies) exercising what a file:// mockup cannot:
 *   GET  /login        login form (POST sets a cookie and 302-redirects: a full navigation)
 *   GET  /dashboard    needs the cookie; renders a list asynchronously after `listDelayMs`,
 *                      has an SPA-style route change (pushState, no reload) and a link to /details/1
 *   GET  /details/1    third page with a textarea
 *   GET  /flash        white page; the button turns the background red (frame alignment checks)
 *   GET  /hang-link    page with a link to /hang, which never responds (navigation timeout checks)
 *   GET  /own-anim     page that defines its own window.__anim (foreign runtime detection)
 * Every response is delayed by `respDelayMs` (server latency simulation). Targets use data-help="...".
 */
export interface LiveApp { url: string; port: number; close: () => Promise<void>; hits: string[] }

const page = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; background: #f1f5f9; color: #0f172a; }
  header { background: #0f172a; color: #fff; padding: 14px 24px; font-weight: 600; display: flex; gap: 24px; align-items: center; }
  header a, header button { color: #cbd5e1; background: none; border: 0; font: inherit; cursor: pointer; }
  main { padding: 32px 24px; max-width: 720px; }
  form { display: grid; gap: 12px; max-width: 320px; }
  input, textarea { padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; }
  button.primary { padding: 10px 16px; border-radius: 8px; border: 0; background: #2563eb; color: #fff; font: inherit; cursor: pointer; }
  ul { padding: 0; list-style: none; } li { padding: 12px 14px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin: 0 0 8px; }
  .panel { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-top: 16px; }
  .hidden { display: none; }
</style></head><body>${body}<script>${script}</script></body></html>`;

export function startLiveApp(opts: { listDelayMs?: number; respDelayMs?: number } = {}): Promise<LiveApp> {
    const listDelayMs = opts.listDelayMs ?? 600;
    const respDelayMs = opts.respDelayMs ?? 0;
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://x');
        hits.push(`${req.method} ${url.pathname}`);
        const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
        const authed = cookies.session === '1';
        const send = (status: number, html: string, headers: Record<string, string> = {}) => {
            setTimeout(() => {
                res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
                res.end(html);
            }, respDelayMs);
        };
        if (url.pathname === '/hang') return; // never answers
        if (req.method === 'POST' && url.pathname === '/login') {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const params = new URLSearchParams(body);
                if (params.get('user')) send(302, '', { 'set-cookie': 'session=1; Path=/', location: '/dashboard' });
                else send(200, page('Login', `<main><p data-help="login-error">Missing user</p></main>`));
            });
            return;
        }
        if (url.pathname === '/' || url.pathname === '/login') {
            send(200, page('Login', `
<header>Live app</header>
<main>
  <h1>Sign in</h1>
  <form method="post" action="/login">
    <input data-help="login-user" name="user" placeholder="User">
    <input data-help="login-pass" name="pass" type="password" placeholder="Password">
    <button data-help="login-submit" class="primary" type="submit">Sign in</button>
  </form>
</main>`));
            return;
        }
        if (url.pathname === '/flash') {
            send(200, `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff;height:100vh}button{position:absolute;left:10px;top:10px}</style></head><body><button data-help="flash" onclick="document.body.style.background='#f00'">go</button></body></html>`);
            return;
        }
        if (url.pathname === '/hang-link') {
            send(200, page('Hang', `<main><h1>Somewhere</h1><a data-help="go-hang" href="/hang">A link that never loads</a></main>`));
            return;
        }
        if (url.pathname === '/own-anim') {
            send(200, `<!doctype html><html><head><meta charset="utf-8"><script>window.__anim = { version: 'theirs' };</script></head><body><main><h1 data-help="title">Own runtime</h1></main></body></html>`);
            return;
        }
        if (!authed) { send(302, '', { location: '/login' }); return; }
        if (url.pathname === '/dashboard' || url.pathname === '/settings') {
            send(200, page('Dashboard', `
<header>Live app <button data-help="tab-home">Home</button> <button data-help="tab-settings">Settings</button> <a data-help="go-details" href="/details/1">Details</a></header>
<main>
  <section data-route="home">
    <h1>Dashboard</h1>
    <p data-help="loading">Loading items…</p>
    <ul data-help="items" class="hidden"></ul>
  </section>
  <section data-route="settings" class="hidden">
    <h1>Settings</h1>
    <div data-help="settings-panel" class="panel"><label><input data-help="notify" type="checkbox"> Email notifications</label></div>
  </section>
</main>`, `
  setTimeout(function () {
    var ul = document.querySelector('[data-help="items"]');
    ['Proposal A', 'Proposal B', 'Proposal C'].forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    ul.classList.remove('hidden');
    document.querySelector('[data-help="loading"]').remove();
  }, ${listDelayMs});
  function route(name) {
    document.querySelectorAll('[data-route]').forEach(function (s) { s.classList.toggle('hidden', s.getAttribute('data-route') !== name); });
    history.pushState({ route: name }, '', name === 'home' ? '/dashboard' : '/settings');
    document.body.setAttribute('data-route', name);
  }
  document.querySelector('[data-help="tab-settings"]').addEventListener('click', function () { route('settings'); });
  document.querySelector('[data-help="tab-home"]').addEventListener('click', function () { route('home'); });
  if (location.pathname === '/settings') route('settings');`));
            return;
        }
        if (url.pathname === '/details/1') {
            send(200, page('Details', `
<header>Live app <a data-help="back" href="/dashboard">Back</a></header>
<main>
  <h1 data-help="detail-title">Proposal A</h1>
  <div class="panel"><textarea data-help="detail-note" rows="4" placeholder="Add a note"></textarea></div>
</main>`));
            return;
        }
        send(404, page('Not found', '<main><h1>404</h1></main>'));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port;
            resolve({ url: `http://127.0.0.1:${port}`, port, hits, close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }) });
        });
    });
}

if (require.main === module) {
    startLiveApp({ listDelayMs: parseInt(process.env.LIST_DELAY_MS || '600', 10), respDelayMs: parseInt(process.env.RESP_DELAY_MS || '0', 10) }).then(app => {
        console.log(app.url);
    });
}
