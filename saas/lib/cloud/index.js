'use strict';
/**
 * Vistaro Cloud: wires the modules together and splits traffic between the
 * APP origin (dashboard + /api) and the CONTENT origin (published demos).
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store');
const { Accounts } = require('./accounts');
const { Publisher } = require('./publish');
const { Analytics } = require('./analytics');
const { Notifier } = require('./notify');
const { ContentServer } = require('./content');
const { Api } = require('./api');

function hostnameOf(req) {
  const raw = String(req.headers.host || '').trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.split(':')[0];
}

function clientIp(req) {
  // Only trust X-Forwarded-For behind a proxy the operator declared.
  if (process.env.VISTARO_TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

class Cloud {
  constructor({ dataDir, env = process.env, maxUploadBytes = 100 * 1024 * 1024, log = () => {}, fetchImpl } = {}) {
    this.env = env;
    this.log = log;
    this.store = new Store(path.join(dataDir, 'cloud', 'cloud.json'));
    this.accounts = new Accounts(this.store);
    this.publisher = new Publisher(this.store, this.accounts, { dataDir });
    this.analytics = new Analytics({ dataDir });
    this.notifier = new Notifier({ log, allowHttp: env.VISTARO_ALLOW_HTTP_WEBHOOKS === '1', ...(fetchImpl ? { fetchImpl } : {}) });
    const secretKey = env.VISTARO_SECRET || crypto.randomBytes(32).toString('hex');
    if (!env.VISTARO_SECRET) log('VISTARO_SECRET is unset: password-unlock cookies will not survive a restart');
    this.content = new ContentServer({ store: this.store, publisher: this.publisher, analytics: this.analytics, notifier: this.notifier, secretKey, log });
    this.api = new Api({
      store: this.store, accounts: this.accounts, publisher: this.publisher, analytics: this.analytics, notifier: this.notifier,
      env, appUrl: 'http://127.0.0.1', contentUrl: 'http://localhost', maxUploadBytes, log, ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  /** Called once the port is known. Explicit env URLs always win. */
  setUrls({ port }) {
    const strip = (u) => u.replace(/\/+$/, '');
    this.appUrl = strip(this.env.VISTARO_APP_URL || `http://127.0.0.1:${port}`);
    this.contentUrl = strip(this.env.VISTARO_CONTENT_URL || `http://localhost:${port}`);
    this.appHost = new URL(this.appUrl).hostname.toLowerCase();
    this.contentHost = new URL(this.contentUrl).hostname.toLowerCase();
    this.api.appUrl = this.appUrl;
    this.api.contentUrl = this.contentUrl;
    this.api.secureCookies = this.appUrl.startsWith('https:');
    if (this.appHost === this.contentHost) {
      this.log('WARNING: app and content share one hostname; published pages could read dashboard cookies. Set VISTARO_CONTENT_URL to another host.');
    }
  }

  /**
   * @returns {Promise<'handled'|'app'>} 'app' when the caller should continue
   * with its own app-origin routes (dashboard, /v1, /embed, /health).
   */
  async handle(req, res, segments) {
    const host = hostnameOf(req);
    const ip = clientIp(req);
    const contentPrefix = ['p', 'r', 'h', '_v'].includes(segments[0]);

    if (host === this.contentHost && host !== this.appHost) {
      if (segments[0] === 'health') return 'app';
      if (contentPrefix && (await this.content.route(req, res, segments, { ip }))) return 'handled';
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return 'handled';
    }

    if (host !== this.appHost && host !== this.contentHost) {
      const ws = this.content.workspaceByDomain(host);
      if (ws) {
        await this.content.route(req, res, segments, { customWorkspace: ws, ip });
        return 'handled';
      }
    }

    if (await this.api.route(req, res, segments)) return 'handled';

    if (contentPrefix) {
      if (host === this.contentHost) {
        // Single-host deployment (warned about at boot): serve content here too.
        if (await this.content.route(req, res, segments, { ip })) return 'handled';
      } else {
        res.writeHead(302, { location: `${this.contentUrl}${req.url}` });
        res.end();
        return 'handled';
      }
    }
    return 'app';
  }
}

module.exports = { Cloud, hostnameOf };
