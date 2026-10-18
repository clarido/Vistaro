'use strict';
/**
 * Subscriptions through Stripe's REST API with the built-in fetch (the Stripe
 * npm package is deliberately not a dependency).
 *
 *   checkout()       a Checkout Session in subscription mode for pro|team,
 *                    monthly|annual; the workspace id rides along as
 *                    client_reference_id and subscription metadata.
 *   portal()         a Billing Portal session (cancel, change card, invoices).
 *   verifyWebhook()  Stripe-Signature check (HMAC-SHA256 over "t.payload").
 *   applyEvent()     the webhook's effect on a workspace's plan.
 *
 * Without STRIPE_SECRET_KEY every call answers 501 "billing not configured":
 * an honest stub, never a fake success.
 */

const crypto = require('node:crypto');
const { SELF_SERVE } = require('./plans');

const API = 'https://api.stripe.com/v1';
const TIMEOUT_MS = 15000;
const TOLERANCE_SEC = 300;

function priceEnvName(plan, interval) {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval === 'annual' ? 'ANNUAL' : 'MONTHLY'}`;
}

async function stripePost(env, endpoint, form, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { status: 502, body: { error: `stripe unreachable: ${e && e.message ? e.message : e}` } };
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    return { status: 502, body: { error: (data && data.error && data.error.message) || `stripe responded ${res.status}` } };
  }
  if (!data || typeof data.url !== 'string') return { status: 502, body: { error: 'stripe returned no URL' } };
  return { status: 200, body: { id: data.id, url: data.url } };
}

async function checkout(workspace, { plan, interval = 'monthly', email }, env, { successUrl, cancelUrl, fetchImpl = fetch }) {
  if (!env.STRIPE_SECRET_KEY) return { status: 501, body: { error: 'billing not configured' } };
  if (!SELF_SERVE.includes(plan)) return { status: 400, body: { error: `plan must be one of ${SELF_SERVE.join(', ')} (Enterprise is sales-led)` } };
  if (interval !== 'monthly' && interval !== 'annual') return { status: 400, body: { error: 'interval must be monthly or annual' } };
  const envName = priceEnvName(plan, interval);
  const price = env[envName];
  if (!price) return { status: 400, body: { error: `no price configured for ${plan}/${interval}; set ${envName}` } };
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', price);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  form.set('client_reference_id', workspace.id);
  form.set('metadata[workspace]', workspace.id);
  form.set('metadata[plan]', plan);
  form.set('subscription_data[metadata][workspace]', workspace.id);
  form.set('subscription_data[metadata][plan]', plan);
  form.set('allow_promotion_codes', 'true');
  if (workspace.billing && workspace.billing.customerId) form.set('customer', workspace.billing.customerId);
  else if (email) form.set('customer_email', email);
  return stripePost(env, 'checkout/sessions', form, fetchImpl);
}

async function portal(workspace, env, { returnUrl, fetchImpl = fetch }) {
  if (!env.STRIPE_SECRET_KEY) return { status: 501, body: { error: 'billing not configured' } };
  if (!workspace.billing || !workspace.billing.customerId) return { status: 400, body: { error: 'this workspace has no Stripe customer yet; subscribe first' } };
  const form = new URLSearchParams();
  form.set('customer', workspace.billing.customerId);
  form.set('return_url', returnUrl);
  return stripePost(env, 'billing_portal/sessions', form, fetchImpl);
}

/**
 * @param {Buffer|string} rawBody the exact bytes Stripe sent
 * @param {string|undefined} header Stripe-Signature
 * @returns {object|null} the parsed event, or null when the signature fails
 */
function verifyWebhook(rawBody, header, secretKey, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!secretKey || typeof header !== 'string') return null;
  let t = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => (s || '').trim());
    if (k === 't') t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length) return null;
  if (Math.abs(nowSec - t) > TOLERANCE_SEC) return null;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const want = crypto.createHmac('sha256', secretKey).update(`${t}.${payload}`, 'utf8').digest();
  const ok = sigs.some((s) => crypto.timingSafeEqual(Buffer.from(s, 'hex'), want));
  if (!ok) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/**
 * Translate a verified Stripe event into a workspace patch.
 * @param {object} event
 * @param {(id: string) => object|null} byId workspace lookup
 * @param {(subId: string) => object|null} bySubscription workspace lookup
 * @returns {{ workspace: object, patch: object }|null}
 */
function applyEvent(event, byId, bySubscription) {
  const obj = event && event.data && event.data.object;
  if (!obj) return null;
  if (event.type === 'checkout.session.completed') {
    const ws = byId(obj.client_reference_id || (obj.metadata && obj.metadata.workspace));
    const plan = obj.metadata && obj.metadata.plan;
    if (!ws || !SELF_SERVE.includes(plan)) return null;
    return { workspace: ws, patch: { plan, billing: { customerId: obj.customer || null, subscriptionId: obj.subscription || null, status: 'active' } } };
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const ws = bySubscription(obj.id) || byId(obj.metadata && obj.metadata.workspace);
    if (!ws) return null;
    const billing = { ...(ws.billing || {}), subscriptionId: obj.id, customerId: obj.customer || (ws.billing && ws.billing.customerId) || null, status: obj.status };
    if (event.type === 'customer.subscription.deleted' || !ACTIVE.has(obj.status)) {
      // Enterprise is set by the operator, never by a self-serve subscription ending.
      return { workspace: ws, patch: { plan: ws.plan === 'enterprise' ? 'enterprise' : 'free', billing } };
    }
    const plan = obj.metadata && SELF_SERVE.includes(obj.metadata.plan) ? obj.metadata.plan : ws.plan;
    return { workspace: ws, patch: { plan, billing } };
  }
  return null;
}

module.exports = { checkout, portal, verifyWebhook, applyEvent, priceEnvName };
