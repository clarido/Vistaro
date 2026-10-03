'use strict';
/**
 * Stripe Checkout via the Stripe REST API with the built-in fetch — the Stripe
 * npm package is deliberately not a dependency (zero-dependency constraint).
 *
 * Plan → price mapping comes from the env (price IDs are account-specific):
 *   STRIPE_PRICE_BUILDER   price_xxx for the Builder tier ($29/mo, BUSINESS-MODEL.md §4)
 *   STRIPE_PRICE_TEAM      price_xxx for the Team tier ($99/mo)
 * A specific price ID may also be posted directly as { "price": "price_xxx" }.
 *
 * Without STRIPE_SECRET_KEY every checkout request returns 501 "billing not
 * configured" — an honest stub, not a fake session.
 */

const STRIPE_API = 'https://api.stripe.com/v1/checkout/sessions';
const TIMEOUT_MS = 15000;

/** Plan names mirror the pricing ladder in docs/saas/BUSINESS-MODEL.md §4. */
const PLAN_ENV = {
  builder: 'STRIPE_PRICE_BUILDER',
  team: 'STRIPE_PRICE_TEAM',
};

/**
 * @param {object} body parsed JSON body ({ plan } or { price })
 * @param {object} env process.env
 * @returns {{ status: number, body: object }}
 */
async function createCheckoutSession(body, env, { successUrl, cancelUrl }) {
  if (!env.STRIPE_SECRET_KEY) {
    return { status: 501, body: { error: 'billing not configured' } };
  }

  let price = null;
  if (typeof body.price === 'string' && body.price.startsWith('price_')) {
    price = body.price;
  } else if (typeof body.plan === 'string') {
    const plan = body.plan.toLowerCase();
    const envName = PLAN_ENV[plan];
    if (!envName) {
      return {
        status: 400,
        body: { error: `unknown plan ${JSON.stringify(body.plan)}; known plans: ${Object.keys(PLAN_ENV).join(', ')} — or post a price ID as {"price": "price_..."}` },
      };
    }
    price = env[envName];
    if (!price) {
      return {
        status: 400,
        body: { error: `plan ${plan} has no price configured; set ${envName} to a Stripe price ID` },
      };
    }
  } else {
    return {
      status: 400,
      body: { error: 'send {"plan": "builder"|"team"} or {"price": "price_..."}' },
    };
  }

  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', price);
  form.set('line_items[0][quantity]', '1');
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  form.set('client_reference_id', 'demoforge-saas-mvp');

  let res;
  try {
    res = await fetch(STRIPE_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return {
      status: 502,
      body: { error: `stripe unreachable: ${e && e.message ? e.message : e}` },
    };
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : `stripe responded ${res.status}`;
    return { status: 502, body: { error: message } };
  }

  // A 2xx with a non-JSON (or JSON-less) body must not become a 500 via `data.id` on null.
  if (!data || typeof data.url !== 'string') {
    return { status: 502, body: { error: 'stripe returned an unusable response (no checkout URL)' } };
  }

  return {
    status: 200,
    body: { id: data.id, url: data.url, mode: data.mode, price },
  };
}

module.exports = { createCheckoutSession, PLAN_ENV };
