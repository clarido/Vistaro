import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for saas/lib/stripe.js (createCheckoutSession).
//
// The module's contract (surveyor's plan):
//   - env is an injected parameter (createCheckoutSession(body, env, {successUrl, cancelUrl})),
//     so every test passes literal objects and never touches process.env.
//   - The Stripe endpoint is hard-coded and fetch is global, so the network seam is stubbed
//     per test (save/restore in finally) while the module's own status mapping, price
//     resolution and form building all run for real. The never-fetch paths (501, all 400s)
//     still get the recording stub so a regression cannot reach the network and so
//     "no fetch happened" is an assertion, not an assumption.

type CheckoutResult = { status: number; body: Record<string, unknown> };
type StripeLib = {
    createCheckoutSession: (
        body: { plan?: unknown; price?: unknown },
        env: Record<string, string | undefined>,
        urls: { successUrl: string; cancelUrl: string },
    ) => Promise<CheckoutResult>;
    PLAN_ENV: Record<string, string>;
};

async function loadStripe(): Promise<StripeLib> {
    // saas/lib/stripe.js is plain JavaScript with no declaration file, and none is created
    // for it: the workaround stays inside this file. A non-literal specifier keeps
    // `tsc --noEmit` from demanding types for the module (TS7016); the single cast to the
    // shape above happens here. The module does `module.exports = {...}`, so the namespace
    // exposes it via `default` (and, through interop, by name too) — take whichever exists.
    const specifier: string = '../saas/lib/stripe.js';
    const mod = (await import(specifier)) as { default?: StripeLib } & StripeLib;
    return (mod.default ?? mod) as StripeLib;
}

let libPromise: Promise<StripeLib> | null = null;
function stripeLib(): Promise<StripeLib> {
    libPromise ??= loadStripe();
    return libPromise;
}

// Invented values with the same shape as the real ones; never a real key or price ID.
const SECRET = 'sk_test_invented_51HxKeyNotReal';
const URLS = {
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancelled',
};

type FetchCall = { url: string; init: any };
type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

/** Install a recording fetch stub for the duration of `run`; always restored in finally. */
async function withFetch(impl: () => Promise<FakeResponse>, run: (calls: FetchCall[]) => Promise<void>): Promise<void> {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
        calls.push({ url: String(url), init });
        return impl();
    }) as typeof fetch;
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

/** A healthy Stripe checkout-session response. */
function okSession(body: Record<string, unknown> = {}): FakeResponse {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            id: 'cs_test_invented_1',
            url: 'https://checkout.stripe.com/c/pay/cs_test_invented_1',
            mode: 'subscription',
            ...body,
        }),
    };
}

function formEntries(init: any): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(String(init.body)));
}

test('without STRIPE_SECRET_KEY the module answers 501 "billing not configured" before any fetch', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({ plan: 'builder' }, {}, URLS);
        assert.equal(r.status, 501, 'the honest-stub contract: 501, not a fake session');
        assert.deepEqual(r.body, { error: 'billing not configured' });
        assert.equal(calls.length, 0, 'the 501 fires before any network attempt');
    });
});

test('PLAN_ENV maps builder -> STRIPE_PRICE_BUILDER and team -> STRIPE_PRICE_TEAM', async () => {
    const { PLAN_ENV } = await stripeLib();
    assert.deepEqual(PLAN_ENV, { builder: 'STRIPE_PRICE_BUILDER', team: 'STRIPE_PRICE_TEAM' });
});

test('a price ID posted directly is used as-is and needs no plan env', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({ price: 'price_invented_direct_1' }, { STRIPE_SECRET_KEY: SECRET }, URLS);
        assert.equal(r.status, 200);
        assert.equal(formEntries(calls[0].init)['line_items[0][price]'], 'price_invented_direct_1',
            'the posted price is sent verbatim');
        assert.deepEqual(r.body.price, 'price_invented_direct_1', 'the resolved price is echoed back');
    });
});

test('plan names are lowercased and resolved through PLAN_ENV', async () => {
    const { createCheckoutSession } = await stripeLib();
    for (const [posted, envVar, expected] of [
        ['Builder', 'STRIPE_PRICE_BUILDER', 'price_invented_builder_1'],
        ['TEAM', 'STRIPE_PRICE_TEAM', 'price_invented_team_1'],
    ] as const) {
        await withFetch(async () => okSession(), async (calls) => {
            const r = await createCheckoutSession(
                { plan: posted },
                { STRIPE_SECRET_KEY: SECRET, [envVar]: expected },
                URLS,
            );
            assert.equal(r.status, 200, `${posted} resolves via ${envVar}`);
            assert.equal(formEntries(calls[0].init)['line_items[0][price]'], expected,
                `${posted} is lowercased and mapped to the plan's env var`);
        });
    }
});

test('an unknown plan answers 400 naming the known plans, without fetching', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({ plan: 'enterprise' }, { STRIPE_SECRET_KEY: SECRET }, URLS);
        assert.equal(r.status, 400);
        assert.equal(
            r.body.error,
            'unknown plan "enterprise"; known plans: builder, team — or post a price ID as {"price": "price_..."}',
        );
        assert.equal(calls.length, 0, 'a bad plan never reaches Stripe');
    });
});

test('a known plan without its price env answers 400 naming that exact env var', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({ plan: 'builder' }, { STRIPE_SECRET_KEY: SECRET }, URLS);
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'plan builder has no price configured; set STRIPE_PRICE_BUILDER to a Stripe price ID');
        assert.equal(calls.length, 0);
    });
});

test('neither price nor plan answers 400 with the usage hint', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({}, { STRIPE_SECRET_KEY: SECRET }, URLS);
        assert.equal(r.status, 400);
        assert.equal(r.body.error, 'send {"plan": "builder"|"team"} or {"price": "price_..."}');
        assert.equal(calls.length, 0);
    });
});

test('a price value not starting with "price_" is not sent: it falls through to the plan branch and 400s', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession({ price: 'sk_live_invented' }, { STRIPE_SECRET_KEY: SECRET }, URLS);
        assert.equal(r.status, 400, 'the non-price_ value must never be sent to Stripe');
        assert.equal(r.body.error, 'send {"plan": "builder"|"team"} or {"price": "price_..."}');
        assert.equal(calls.length, 0);
    });
});

test('a fetch rejection answers 502 "stripe unreachable: <message>"', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => {
        throw new Error('connect ECONNREFUSED invented');
    }, async (calls) => {
        const r = await createCheckoutSession(
            { plan: 'builder' },
            { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_BUILDER: 'price_invented_builder_1' },
            URLS,
        );
        assert.equal(r.status, 502);
        assert.equal(r.body.error, 'stripe unreachable: connect ECONNREFUSED invented');
        assert.equal(calls.length, 1, 'the failure happened at the fetch, which was attempted once');
    });
});

test('a non-ok response with a JSON error body answers 502 carrying data.error.message', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => ({
        ok: false,
        status: 402,
        json: async () => ({ error: { message: 'Your card was declined.' } }),
    }), async () => {
        const r = await createCheckoutSession(
            { plan: 'team' },
            { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_TEAM: 'price_invented_team_1' },
            URLS,
        );
        assert.equal(r.status, 502);
        assert.equal(r.body.error, 'Your card was declined.', 'Stripe\'s own message is surfaced, not a generic one');
    });
});

test('a non-ok response with a non-JSON body answers 502 "stripe responded <status>"', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => ({
        ok: false,
        status: 500,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    }), async () => {
        const r = await createCheckoutSession(
            { plan: 'builder' },
            { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_BUILDER: 'price_invented_builder_1' },
            URLS,
        );
        assert.equal(r.status, 502);
        assert.equal(r.body.error, 'stripe responded 500');
    });
});

test('a 2xx without a JSON body or url answers 502 "unusable response" — the null-guard regression', async () => {
    const { createCheckoutSession } = await stripeLib();
    const env = { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_BUILDER: 'price_invented_builder_1' };
    const cases: Array<[string, () => Promise<FakeResponse>]> = [
        ['an HTML error page that happens to be 2xx', async () => ({
            ok: true, status: 200,
            json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
        })],
        ['a 2xx whose JSON body is null', async () => ({ ok: true, status: 200, json: async () => null })],
        ['a 2xx whose JSON body has no url', async () => ({ ok: true, status: 200, json: async () => ({ id: 'cs_1' }) })],
    ];
    for (const [label, impl] of cases) {
        await withFetch(impl, async () => {
            const r = await createCheckoutSession({ plan: 'builder' }, env, URLS);
            assert.equal(r.status, 502, `${label}: must be a 502, not a 500 from data.id on null`);
            assert.equal(r.body.error, 'stripe returned an unusable response (no checkout URL)');
        });
    }
});

test('a healthy 2xx answers 200 with {id, url, mode, price}', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async () => {
        const r = await createCheckoutSession(
            { plan: 'builder' },
            { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_BUILDER: 'price_invented_builder_1' },
            URLS,
        );
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, {
            id: 'cs_test_invented_1',
            url: 'https://checkout.stripe.com/c/pay/cs_test_invented_1',
            mode: 'subscription',
            price: 'price_invented_builder_1',
        });
    });
});

test('the request is a form-encoded POST to the hard-coded Stripe endpoint, with the injected key as bearer', async () => {
    const { createCheckoutSession } = await stripeLib();
    await withFetch(async () => okSession(), async (calls) => {
        const r = await createCheckoutSession(
            { plan: 'team' },
            { STRIPE_SECRET_KEY: SECRET, STRIPE_PRICE_TEAM: 'price_invented_team_1' },
            URLS,
        );
        assert.equal(r.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions', 'the endpoint is the documented one');
        assert.equal(calls[0].init.method, 'POST');
        assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`, 'the injected env key authenticates');
        assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.deepEqual(formEntries(calls[0].init), {
            mode: 'subscription',
            'line_items[0][price]': 'price_invented_team_1',
            'line_items[0][quantity]': '1',
            success_url: URLS.successUrl,
            cancel_url: URLS.cancelUrl,
            client_reference_id: 'demoforge-saas-mvp',
        }, 'the checkout form carries exactly the documented six fields');
    });
});
