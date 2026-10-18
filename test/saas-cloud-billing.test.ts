import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { loadSaas } from './saas-cloud-helpers';

// Unit tests for saas/lib/cloud/billing.js. Signatures are computed here
// independently, with the algorithm Stripe documents, not with the module.

function sign(payload: string, secret: string, t: number): string {
    return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

test('verifyWebhook accepts Stripe-signed payloads and refuses anything else', async () => {
    const { verifyWebhook } = await loadSaas('cloud/billing.js');
    const secret = 'whsec_test';
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const t = 1_800_000_000;
    assert.equal(verifyWebhook(payload, sign(payload, secret, t), secret, { nowSec: t }).type, 'checkout.session.completed');
    assert.equal(verifyWebhook(Buffer.from(payload), sign(payload, secret, t), secret, { nowSec: t + 10 }).type, 'checkout.session.completed');
    assert.equal(verifyWebhook(payload, sign(payload, 'whsec_other', t), secret, { nowSec: t }), null, 'wrong secret');
    assert.equal(verifyWebhook(payload + ' ', sign(payload, secret, t), secret, { nowSec: t }), null, 'tampered body');
    assert.equal(verifyWebhook(payload, sign(payload, secret, t), secret, { nowSec: t + 301 }), null, 'replayed outside tolerance');
    assert.equal(verifyWebhook(payload, undefined, secret, { nowSec: t }), null);
    assert.equal(verifyWebhook(payload, sign(payload, secret, t), '', { nowSec: t }), null, 'no secret configured');
    assert.equal(verifyWebhook(payload, `t=${t},v1=zz`, secret, { nowSec: t }), null);
});

test('applyEvent: checkout upgrades, a cancelled or unpaid subscription downgrades, Enterprise is never downgraded by Stripe', async () => {
    const { applyEvent } = await loadSaas('cloud/billing.js');
    const ws: Record<string, { id: string; plan: string; billing?: { subscriptionId: string } | null }> = {
        a: { id: 'ws_a', plan: 'free' },
        e: { id: 'ws_e', plan: 'enterprise', billing: { subscriptionId: 'sub_e' } },
    };
    const byId = (id: string) => Object.values(ws).find((w) => w.id === id) || null;
    const bySub = (sub: string) => Object.values(ws).find((w) => w.billing && w.billing.subscriptionId === sub) || null;

    const up = applyEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'ws_a', customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'team' } } } }, byId, bySub);
    assert.equal(up.patch.plan, 'team');
    assert.deepEqual(up.patch.billing, { customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active' });
    ws.a = { ...ws.a, ...up.patch };

    const down = applyEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', customer: 'cus_1' } } }, byId, bySub);
    assert.equal(down.patch.plan, 'free');
    const unpaid = applyEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'unpaid' } } }, byId, bySub);
    assert.equal(unpaid.patch.plan, 'free');
    const pastDue = applyEvent({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'past_due', metadata: { plan: 'pro' } } } }, byId, bySub);
    assert.equal(pastDue.patch.plan, 'pro', 'past_due keeps service during Stripe dunning');

    const ent = applyEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_e', status: 'canceled' } } }, byId, bySub);
    assert.equal(ent.patch.plan, 'enterprise');

    assert.equal(applyEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'ws_a', metadata: { plan: 'enterprise' } } } }, byId, bySub), null, 'checkout cannot sell Enterprise');
    assert.equal(applyEvent({ type: 'invoice.paid', data: { object: {} } }, byId, bySub), null);
    assert.equal(applyEvent({ type: 'checkout.session.completed', data: { object: { client_reference_id: 'ws_ghost', metadata: { plan: 'pro' } } } }, byId, bySub), null);
});

test('checkout: 501 without Stripe, 400 for Enterprise or a missing price, and the session carries the workspace', async () => {
    const { checkout, priceEnvName } = await loadSaas('cloud/billing.js');
    const ws = { id: 'ws_a', billing: null };
    const urls = { successUrl: 'https://app/s', cancelUrl: 'https://app/c' };
    let calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (url: string, init: { body: string }) => {
        calls.push({ url, body: init.body });
        return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }), { status: 200 });
    };
    assert.equal((await checkout(ws, { plan: 'pro' }, {}, { ...urls, fetchImpl })).status, 501);
    const env = { STRIPE_SECRET_KEY: 'sk_test', [priceEnvName('pro', 'annual')]: 'price_pro_y' };
    assert.equal((await checkout(ws, { plan: 'enterprise' }, env, { ...urls, fetchImpl })).status, 400);
    assert.match((await checkout(ws, { plan: 'team' }, env, { ...urls, fetchImpl })).body.error, /STRIPE_PRICE_TEAM_MONTHLY/);
    assert.equal(calls.length, 0, 'refusals never reach Stripe');

    const ok = await checkout(ws, { plan: 'pro', interval: 'annual', email: 'a@b.co' }, env, { ...urls, fetchImpl });
    assert.deepEqual(ok, { status: 200, body: { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' } });
    assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('mode'), 'subscription');
    assert.equal(form.get('line_items[0][price]'), 'price_pro_y');
    assert.equal(form.get('client_reference_id'), 'ws_a');
    assert.equal(form.get('subscription_data[metadata][plan]'), 'pro');
    assert.equal(form.get('customer_email'), 'a@b.co');
    calls = [];
});
