# Vistaro Cloud

> **Status: parked, not deployed (2026-10-18).** Vistaro is launching as a free, open-source CLI. This service is built and tested but intentionally not running anywhere: hosting strangers' uploads and storing their visitors' emails carries cost and risk that only makes sense once users ask for it. See [`docs/saas/BUSINESS-MODEL.md`](../docs/saas/BUSINESS-MODEL.md) for the decision and what would revive it.

The paid half of Vistaro ([business model](../docs/saas/BUSINESS-MODEL.md)). The free CLI renders guides, tours, reels and videos on your machine or in CI. **Vistaro Cloud never renders.** It hosts what the CLI built and adds what a team pays for: analytics, lead capture, a help center, review and approvals, a translation workspace, custom domains, webhooks and billing.

**Zero runtime dependencies**: `node:http`, `node:crypto`, `node:zlib` and the built-in `fetch`. The server and its smoke test need no `npm install`.

```
saas/
  server.js              entry point: env, routing, the operator surface
  lib/cloud/
    index.js             wires the modules; splits APP origin / CONTENT origin / custom domains
    api.js               /api/* (dashboard via cookie, CI via workspace token)
    accounts.js          users, sessions, workspaces, roles, invites, seats, CI tokens, audit
    plans.js             the pricing ladder as code; gates answer 402 + upgradeTo
    publish.js           bundle → versioned release (kind/entry detection, drafts, rollback, pruning)
    content.js           hosted demos, viewer-script injection, password, leads, beacon, help center
    analytics.js         cookieless event log + summaries (funnels, completion, dwell, referrers)
    notify.js            outbound webhooks (Slack-compatible JSON)
    billing.js           Stripe Checkout, Billing Portal, signed webhooks → plan changes
    store.js             JSON document store (atomic writes); Postgres is the production swap
    util.js              ids, scrypt, cookies, slugs, escaping
  lib/zip.js             hand-written ZIP reader (zip-slip, symlink, bomb guards)
  lib/zipwrite.js        hand-written ZIP writer (the publish client's bundler)
  lib/{jobs,queue,project,auth,stripe,httputil}.js   operator render runner + shared HTTP helpers
  public/app.html|js|css the dashboard (plain JS, no build step)
  public/v.js            the viewer script injected into every published page
  public/ops.html        operator console for the render runner
  bin/vistaro-cloud.mjs  CI client: publish, pull-strings
  smoke.mjs              boots the server, checks 47 HTTP behaviours, always cleans up
```

## Quickstart

```bash
VISTARO_ALLOW_PLAN_SWITCH=1 node saas/server.js
# app:     http://127.0.0.1:8787   ← open this, create an account
# content: http://localhost:8787   ← published demos are served here

node saas/smoke.mjs                # 47 checks, PASS
```

Then publish something the CLI built:

```bash
npx tsx cli.ts export demo -o demo/demo.mp4 --guide        # free, local, as always
# dashboard → Publish from CI → Create token
VISTARO_TOKEN=vt_… VISTARO_URL=http://127.0.0.1:8787 \
  node saas/bin/vistaro-cloud.mjs publish demo --project getting-started
# Create your first report #1 (guide, live) — live at http://localhost:8787/p/<workspace>/getting-started/
```

Any CLI output directory works: a guide (`guide/guide.html`), a tour site (`tours.json` + `index.html` from `tour`), a reel embed (`embed-desktop.html` from `build --embed`), a bare video, or any static page (`--entry` picks the file). Include `index.json` from `build-all --diff` and the Cloud shows which guides went stale. Include `strings.<locale>.json` files and they appear in the translation workspace.

`VISTARO_ALLOW_PLAN_SWITCH=1` adds "Try <plan> (demo mode)" buttons on the billing page, so every tier can be explored without Stripe. **Never set it in production.**

## Two origins, on purpose

Published bundles are customer HTML with scripts. Serving them on the dashboard's origin would let any published page act as the logged-in user. So:

- **APP origin** (`VISTARO_APP_URL`, dev default `http://127.0.0.1:<port>`): dashboard, `/api/*`, `/health`, operator routes. It redirects `/p/…`, `/h/…` and `/r/…` to the content origin and never serves them itself.
- **CONTENT origin** (`VISTARO_CONTENT_URL`, dev default `http://localhost:<port>`): `/p/<ws>/<demo>/…`, `/r/<previewKey>/…`, `/h/<ws>/`, `/_v/*`. It never serves the API.
- **Custom domains** (Pro+): a workspace's hostname serves `/<demo>/…` and, on Team, the help center at `/`.

127.0.0.1 and localhost are different hosts, so in development the session cookie is genuinely out of reach of published pages, just as in production.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8787`, `127.0.0.1` | Listen address (`PORT=0` = ephemeral; the boot line carries the real port). |
| `SAAS_DATA_DIR` | `saas/data` | Everything persistent: `cloud/cloud.json`, `cloud/releases/`, `cloud/analytics/`, operator `jobs/`. Gitignored. |
| `VISTARO_APP_URL` | `http://127.0.0.1:<port>` | Public URL of the dashboard/API. `https:` turns on `Secure` cookies. |
| `VISTARO_CONTENT_URL` | `http://localhost:<port>` | Public URL of the content origin. **Must be a different hostname** from the app (the server warns otherwise). |
| `VISTARO_SECRET` | random per boot | HMAC key for password-unlock cookies. Set it, or unlocks reset on restart. |
| `VISTARO_TRUST_PROXY` | unset | `1`: take the client IP for rate limits from `X-Forwarded-For` (only behind your own proxy). |
| `VISTARO_ALLOW_PLAN_SWITCH` | unset | `1`: demo-mode plan switching from the billing page. Dev/sales demos only. |
| `VISTARO_ALLOW_HTTP_WEBHOOKS` | unset | `1`: accept `http://` webhook URLs (local testing). |
| `SAAS_MAX_UPLOAD_MB` | `100` | Bundle upload cap (413 above). |
| `STRIPE_SECRET_KEY` | unset | Enables billing; unset ⇒ checkout and portal answer **501 `billing not configured`**. |
| `STRIPE_WEBHOOK_SECRET` | unset | Verifies `POST /api/billing/webhook` (`Stripe-Signature`, 5-minute tolerance). |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_PRICE_TEAM_MONTHLY`, `STRIPE_PRICE_TEAM_ANNUAL` | unset | Stripe price ids per plan and interval. |
| `SAAS_API_KEYS` | unset | Operator bearer keys for `/v1/*` (render runner, manual plan changes). Unset ⇒ `/v1/*` is 401. |
| `SAAS_REPO_ROOT`, `SAAS_EXPORT_TIMEOUT_MS`, `SAAS_DISABLE_RUNNER`, `STRIPE_PRICE_BUILDER` | | Operator render runner and legacy checkout (see the end of this file). |

**Stripe setup:** create Pro and Team products with monthly and annual prices, set the four price variables, and point a webhook endpoint at `<app>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. The workspace id travels as `client_reference_id` and as subscription metadata. Plan changes happen only through verified webhooks, never through the redirect.

## API (`/api`)

Auth is either the dashboard session cookie (writes must send `x-vistaro-csrf: 1`) or `Authorization: Bearer vt_…` (a workspace token; it acts as an editor and uses `~` as the workspace slug). A plan wall answers **402** `{ error, feature, upgradeTo, upgradeUrl }`.

| Method & path | Who | What |
|---|---|---|
| `GET /api/plans` | anyone | the ladder and feature labels |
| `POST /api/signup` · `/api/login` · `/api/logout` · `GET /api/me` | anyone / user | accounts; signup consumes a pending invite for that email |
| `GET`·`PATCH /api/w/<ws>` | member / admin | workspace, plan, usage; name, brand, `customDomain` (Pro), `webhookUrl` (Team), `requireReview` (Team) |
| `GET /api/w/<ws>/projects` | member | demos with 30-day stats and freshness |
| `POST /api/w/<ws>/projects/<slug>/releases` | editor / token | **publish**: raw zip body; query `title`, `entry`, `draft=1`, `notes`, `sha`, `branch`, `pr` |
| `GET`·`PATCH`·`DELETE /api/w/<ws>/projects/<slug>` | editor / admin | releases list; `title`, `gate` (Pro), `cta` (Pro), `password` (Pro) |
| `POST …/releases/<n>/promote` | editor (admin for drafts) | approve a draft (Team) or roll back (Pro) |
| `GET`·`POST …/releases/<n>/comments`, `PATCH …/comments/<id>` | member | review threads (Team) |
| `GET …/analytics?days=N` | editor | totals, daily series, referrers, funnel (Pro), clamped to plan retention |
| `GET …/leads[?format=csv]` | editor | leads; CSV (Pro) with formula injection defused |
| `GET …/strings`, `GET`·`PUT …/strings/<locale>` | translator+ / token | translation workspace (Team); the GET of one locale is the file CI writes back |
| `GET`·`POST`·`DELETE /api/w/<ws>/members[/<userId or email>]` | admin | members and invites, seat-checked |
| `GET`·`POST`·`DELETE /api/w/<ws>/tokens[/<id>]` | admin | CI tokens (shown once, stored hashed) |
| `GET /api/w/<ws>/audit` | admin | audit log (Enterprise) |
| `POST /api/w/<ws>/billing/checkout` · `/portal` · `/dev-plan` | owner | Stripe Checkout / Portal; demo-mode switch |
| `POST /api/billing/webhook` | Stripe | signed plan changes |

## Content origin

| Path | What |
|---|---|
| `/p/<ws>/<demo>/` | live release; redirects to its entry (e.g. `guide/guide.html`) |
| `/r/<previewKey>/` | one specific release (draft review link), marked "Preview", not tracked, `noindex` |
| `/h/<ws>/`, `/h/<ws>/search.json` | help center (Team): search across guides and steps, language filter |
| `/_v/v.js` | viewer script |
| `POST /_v/e` | beacon: `view`, `step`, `complete`, `cta`, `leave`; batched, validated, rate-limited, 204 |
| `POST /_v/lead` | lead form (only when the demo's gate is on and the plan allows it) |
| `POST /_v/unlock` | password form; sets an HMAC cookie scoped to that demo |

Every HTML file of a release is served with `window.__vistaro` (the demo id, the release, which chrome to draw) and `/_v/v.js` injected before `</body>`. The script:
- counts the view and the dwell time;
- reports **tour** steps by listening to the tour shell's `vistaro-tour` messages, per scenario;
- reports **guide** steps as each `section.step` comes into view;
- reports **video** completion on `ended`;
- draws the badge (Free), the CTA (Pro) and the lead gate (Pro).

It sets no cookies. A visit is a random id in `sessionStorage`.

## Operator surface (`/v1`, `SAAS_API_KEYS`)

- `PUT /v1/workspaces/<slug>/plan {"plan": "enterprise"}`: set a plan by hand (sales-led deals, comps, support).
- `POST /v1/builds`, `GET /v1/builds[/<id>]`, `GET /embed/<id>/…`, `GET /ops`: the **render runner**, which runs `npx tsx cli.ts export` on an uploaded project, serially. It is an operator tool for self-hosted installs and internal use. It is **not** sold and has no place in any plan, because Vistaro does not sell rendering. Its contract is unchanged from the MVP (zip body with `index.html` + `vistaro.config.json`; one export at a time; `SAAS_DISABLE_RUNNER=1` queues without running; `SAAS_EXPORT_TIMEOUT_MS` bounds each job).
- `POST /v1/billing/checkout`: the legacy single-price checkout stub (`STRIPE_PRICE_BUILDER`/`STRIPE_PRICE_TEAM`), kept for compatibility. The dashboard uses `/api/w/<ws>/billing/checkout`.

## Deploying

The Cloud is static serving plus a small API. Rendering never runs here, so the image does **not** need Chromium unless you also want the operator render runner.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY saas ./saas
ENV PORT=8080 HOST=0.0.0.0 SAAS_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "saas/server.js"]
```

Run behind TLS with two hostnames on the same process, for example `app.vistaro.dev` (`VISTARO_APP_URL`) and `vistaro.page` (`VISTARO_CONTENT_URL`). Customer custom domains CNAME to the content host. For TLS on them, use an on-demand-TLS proxy (Caddy) or your platform's certificate API.

## Production gaps (the honest list)

1. **Single node.** The JSON store and in-memory rate limits assume one process. Move to Postgres plus a shared rate limiter before running two.
2. **Releases on local disk.** Move them to object storage + a CDN (keep the separate content hostname).
3. **No email.** Invites show a link in the dashboard instead of sending one. Password reset does not exist yet.
4. **Custom domains** are not verified (no CNAME check) and get no automatic TLS.
5. **Webhook SSRF.** Only https is enforced. Production must refuse private and link-local addresses at connect time.
6. **SSO/SAML** is listed on Enterprise but not built.
7. **Lead gate** is client-side (a viewer who disables JS sees the demo). Password protection is server-side and is the right tool for secrecy.

## Verified

- `node saas/smoke.mjs`: **47 checks passed**. The original 17 operator checks, plus 30 Vistaro Cloud checks over real HTTP: signup and session, CSRF refusal, CI token publish, entry redirect, viewer injection and badge, app/content origin separation both ways, traversal, beacon → analytics, 402 on a Free gate, operator plan change, lead → CSV with formulas defused, help center, password lock/unlock, Stripe webhook signature refusal, 501 checkout without keys.
- `test/saas-cloud-*.test.ts`: 41 unit tests over a real disk. Among them, a canary that fails if any plan grows a render, build, minute or token meter.
- In a real Chromium: the dashboard (sign-in, demos, analytics, billing, settings, translations), the lead gate on a published guide, and step tracking per scenario on a published `tour` build.
