'use strict';
/**
 * The pricing ladder as code (docs/saas/BUSINESS-MODEL.md §4 is the prose).
 *
 * The rule the whole model rests on: nothing here meters rendering. The CLI
 * renders on the customer's machine or CI for free, forever; the Cloud sells
 * what happens AFTER the render -- publishing, analytics, lead capture, a
 * help center, review, translation, team controls. Limits are therefore on
 * seats, live projects and retained history, never on minutes or tokens.
 */

const INF = Number.POSITIVE_INFINITY;

/** Every gated capability, with the label the dashboard and website show. */
const FEATURES = {
  'remove-badge': 'Remove the "Made with Vistaro" badge',
  'custom-domain': 'Custom domain (help.yourapp.com)',
  'lead-capture': 'Lead capture forms on demos',
  'cta': 'Call-to-action button on every demo',
  'password': 'Password-protected demos',
  'step-funnels': 'Step-by-step drop-off funnels',
  'csv-export': 'CSV export of leads and analytics',
  'rollback': 'Release history and one-click rollback',
  'help-center': 'Branded, searchable help center across every guide and locale',
  'review': 'Draft releases, review links, comments and approvals',
  'translations': 'Translation workspace and translator seats',
  'webhooks': 'Webhooks (Slack, Zapier, CRM) for leads, publishes and stale guides',
  'audit-log': 'Audit log',
  'sso': 'SSO / SAML',
  'self-host': 'Self-hosted Cloud in your VPC',
};

const PLANS = {
  free: {
    id: 'free', name: 'Free', priceMonthly: 0, priceAnnualMonthly: 0,
    seats: 1, projects: 3, releaseHistory: 3, analyticsDays: 7,
    features: [],
  },
  pro: {
    id: 'pro', name: 'Pro', priceMonthly: 24, priceAnnualMonthly: 19,
    seats: 3, projects: INF, releaseHistory: 50, analyticsDays: 365,
    features: ['remove-badge', 'custom-domain', 'lead-capture', 'cta', 'password', 'step-funnels', 'csv-export', 'rollback'],
  },
  team: {
    id: 'team', name: 'Team', priceMonthly: 79, priceAnnualMonthly: 64,
    seats: 10, projects: INF, releaseHistory: 200, analyticsDays: 730,
    features: ['remove-badge', 'custom-domain', 'lead-capture', 'cta', 'password', 'step-funnels', 'csv-export', 'rollback',
      'help-center', 'review', 'translations', 'webhooks'],
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', priceMonthly: null, priceAnnualMonthly: null,
    seats: INF, projects: INF, releaseHistory: INF, analyticsDays: INF,
    features: Object.keys(FEATURES),
  },
};

/** Which plans Stripe Checkout can sell (Enterprise is sales-led). */
const SELF_SERVE = ['pro', 'team'];

function planOf(workspace) {
  return PLANS[(workspace && workspace.plan) || 'free'] || PLANS.free;
}

function can(workspace, feature) {
  if (!FEATURES[feature]) throw new Error(`unknown feature ${feature}`);
  return planOf(workspace).features.includes(feature);
}

/** The cheapest plan that unlocks a feature -- the upsell the 402 names. */
function cheapestPlanFor(feature) {
  for (const p of ['pro', 'team', 'enterprise']) if (PLANS[p].features.includes(feature)) return p;
  return 'enterprise';
}

/** An Error the router turns into 402 Payment Required with an upgrade hint. */
class PlanError extends Error {
  constructor(message, { feature = null, upgradeTo = null } = {}) {
    super(message);
    this.name = 'PlanError';
    this.feature = feature;
    this.upgradeTo = upgradeTo;
  }
}

function requireFeature(workspace, feature) {
  if (can(workspace, feature)) return;
  const to = cheapestPlanFor(feature);
  throw new PlanError(`${FEATURES[feature]} is part of the ${PLANS[to].name} plan`, { feature, upgradeTo: to });
}

/** Public, JSON-safe view (Infinity has no JSON form; null means unlimited). */
function planView(plan) {
  const fin = (n) => (Number.isFinite(n) ? n : null);
  return {
    id: plan.id, name: plan.name,
    priceMonthly: plan.priceMonthly, priceAnnualMonthly: plan.priceAnnualMonthly,
    seats: fin(plan.seats), projects: fin(plan.projects),
    releaseHistory: fin(plan.releaseHistory), analyticsDays: fin(plan.analyticsDays),
    features: plan.features.slice(),
  };
}

module.exports = { PLANS, FEATURES, SELF_SERVE, planOf, can, requireFeature, cheapestPlanFor, PlanError, planView };
