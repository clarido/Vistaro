import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { loadSaas } from './saas-cloud-helpers';

// Unit tests for saas/lib/cloud/plans.js -- the pricing ladder as code.
//
// The canary at the bottom pins the business model's one non-negotiable rule
// (docs/saas/BUSINESS-MODEL.md §0): the Cloud never meters rendering. A plan
// limit on minutes, renders, builds, exports or tokens would quietly turn the
// free CLI into a funnel for paid generation; this test makes that a red build.

test('free has no paid feature; every paid feature unlocks on exactly one cheapest self-serve plan', async () => {
    const { PLANS, FEATURES, can, cheapestPlanFor } = await loadSaas('cloud/plans.js');
    const free = { plan: 'free' };
    for (const f of Object.keys(FEATURES)) assert.equal(can(free, f), false, `free must not include ${f}`);
    assert.equal(cheapestPlanFor('lead-capture'), 'pro');
    assert.equal(cheapestPlanFor('help-center'), 'team');
    assert.equal(cheapestPlanFor('sso'), 'enterprise');
    // The ladder is monotonic: every feature of a plan is in every plan above it.
    const order = ['free', 'pro', 'team', 'enterprise'];
    for (let i = 1; i < order.length; i++) {
        for (const f of PLANS[order[i - 1]].features) {
            assert.ok(PLANS[order[i]].features.includes(f), `${order[i]} drops ${f} from ${order[i - 1]}`);
        }
    }
});

test('requireFeature throws a PlanError naming the feature and the plan to upgrade to', async () => {
    const { requireFeature, PlanError } = await loadSaas('cloud/plans.js');
    assert.doesNotThrow(() => requireFeature({ plan: 'team' }, 'webhooks'));
    assert.throws(() => requireFeature({ plan: 'pro' }, 'webhooks'), (e: { feature: string; upgradeTo: string }) => {
        assert.ok(e instanceof PlanError);
        assert.equal(e.feature, 'webhooks');
        assert.equal(e.upgradeTo, 'team');
        return true;
    });
    assert.throws(() => requireFeature({ plan: 'pro' }, 'no-such-feature'), /unknown feature/);
});

test('an unknown or missing plan id falls back to free, never to a paid plan', async () => {
    const { planOf } = await loadSaas('cloud/plans.js');
    assert.equal(planOf({ plan: 'platinum' }).id, 'free');
    assert.equal(planOf({}).id, 'free');
    assert.equal(planOf(null).id, 'free');
});

test('planView turns Infinity into null so the plan survives JSON', async () => {
    const { PLANS, planView } = await loadSaas('cloud/plans.js');
    const v = planView(PLANS.enterprise);
    assert.equal(v.seats, null);
    assert.equal(JSON.parse(JSON.stringify(v)).projects, null);
    assert.equal(planView(PLANS.free).projects, 3);
});

test('canary: no plan meters rendering (minutes, renders, builds, exports, tokens, credits)', async () => {
    const { PLANS } = await loadSaas('cloud/plans.js');
    const allowedKeys = ['id', 'name', 'priceMonthly', 'priceAnnualMonthly', 'seats', 'projects', 'releaseHistory', 'analyticsDays', 'features'];
    // Whole dash-separated words: 'csv-export' exports leads, it does not meter video exports.
    const banned = /(?:^|-)(?:minutes?|renders?|builds?|exports?|tokens?|credits?|generations?|quotas?)(?:-|$)/i;
    assert.deepEqual(Object.keys(PLANS).sort(), ['enterprise', 'free', 'pro', 'team']);
    for (const [id, plan] of Object.entries(PLANS) as Array<[string, Record<string, unknown>]>) {
        assert.deepEqual(Object.keys(plan), allowedKeys, `plan ${id} grew a limit key; limits are seats/projects/history/analytics only`);
        for (const f of plan.features as string[]) {
            if (f === 'csv-export') continue; // the one allowed word: a leads/analytics download, sold on the page as such
            assert.doesNotMatch(f, banned, `plan ${id} feature ${f} meters generation`);
        }
    }
    // The prose of the model: the source file states the rule it encodes.
    const src = fs.readFileSync(path.join(__dirname, '..', 'saas', 'lib', 'cloud', 'plans.js'), 'utf8');
    assert.match(src, /nothing here meters rendering/);
});
