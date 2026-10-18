'use strict';
/**
 * Outbound webhooks (Team plan): one URL per workspace receives a JSON POST
 * for every lead, publish, release awaiting review and stale-guide report.
 * The body carries `text` so a Slack incoming-webhook URL works as-is, plus
 * structured `event`/`data` fields for Zapier, Make or a CRM bridge.
 *
 * Deliveries are fire-and-forget with a hard timeout: a slow receiver can
 * never hold a request open or block a publish.
 */

const { can } = require('./plans');

const TIMEOUT_MS = 5000;

function validWebhookUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.username || u.password) return false;
  return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
}

class Notifier {
  constructor({ fetchImpl = (...a) => fetch(...a), log = () => {}, allowHttp = false } = {}) {
    this.fetch = fetchImpl;
    this.log = log;
    this.allowHttp = allowHttp;
    this.inflight = new Set();
  }

  /** @returns {Promise<boolean>|null} null when nothing was sent */
  send(workspace, event, text, data = {}) {
    if (!workspace || !workspace.webhookUrl || !can(workspace, 'webhooks')) return null;
    if (!validWebhookUrl(workspace.webhookUrl, { allowHttp: this.allowHttp })) return null;
    const body = JSON.stringify({ event, text: `[Vistaro] ${text}`, workspace: workspace.slug, data, at: new Date().toISOString() });
    const p = Promise.resolve()
      .then(() => this.fetch(workspace.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'vistaro-cloud-webhooks' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }))
      .then((res) => {
        if (!res.ok) this.log(`webhook ${event} → ${res.status}`);
        return res.ok;
      })
      .catch((e) => {
        this.log(`webhook ${event} failed: ${e && e.message ? e.message : e}`);
        return false;
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }

  /** Test seam: wait for every delivery started so far. */
  drain() {
    return Promise.all([...this.inflight]);
  }
}

module.exports = { Notifier, validWebhookUrl };
