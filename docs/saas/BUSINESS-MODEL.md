# Vistaro: business model

*Revised 2026-10-18. Decision of the day: **Vistaro is free for now.** Get users first, then decide whether a business model exists. The paid "Vistaro Cloud" design below is kept as parked notes, not as a plan.*

---

## Current decision: free, and watch

**What ships:** the open-source CLI and the website. That's all.

**Why free works:** the CLI runs on the user's computer, driven by the agent they already pay for (Claude Code, Codex, Antigravity). Rendering uses their machine; the AI uses their subscription. Our cost is a static web page and an npm package, close to zero, so there's no pressure to charge before we know who the users are.

**Why not run Vistaro Cloud for free:** it's built and tested (`saas/`), but running it means hosting HTML strangers upload (phishing and spam magnet), storing other people's visitors' emails (privacy obligations), and maintaining a server with accounts and backups. That's real cost and risk for a feature nobody has asked for yet. It stays in the repo, undeployed, ready to switch on in days.

**What we watch to find a model:**

| Signal | Where | What it would tell us |
|---|---|---|
| Adoption | npm downloads, GitHub stars, website traffic | Whether anyone wants the tool at all |
| Requests | GitHub issues and discussions | What's missing; especially "how do I host this?" or "how do I see who watched?" |
| Waitlist | "Join the waitlist" on the site (email to hello@vistaro.dev, with a prompt asking what they'd use it for) | Whether a hosted service has demand, and for which feature |
| Who shows up | Issues, waitlist emails | Developers only, or also marketing, sales and support people? Only the second group plausibly pays (see below). |
| What they do with output | Issues, examples shared publicly | Where demos end up: docs, homepages, sales emails |

No telemetry in the CLI: a tool whose pitch is "runs locally" shouldn't phone home.

**Decision point:** revisit after three months, or earlier if the waitlist or issues show a clear pattern.

---

## What we learned designing the paid version

**Developers won't pay for collaboration on files they already have.** The CLI's output is ordinary files. A developer can review them in a pull request, share the MP4 in Slack, and host the folder on GitHub Pages or Netlify for free. So review workflows, release history, plain hosting, password protection, a static help center and translation editing are all weak paid features: each has a free do-it-yourself version that developers already use.

**What a laptop genuinely can't do involves people outside the company:**
1. *Seeing what viewers did:* which step they quit at, completion per scenario. Generic web analytics doesn't understand demo steps.
2. *Turning viewers into leads:* an email form before the demo, a button at the end, leads sent to the CRM. That needs a server receiving personal data.
3. Further ideas, not built: identifying which company watched (IP-to-company lookup) and alerting sales; personalized demo links per prospect; A/B testing two versions of a demo; native HubSpot and Salesforce integrations.

**So the plausible buyer is marketing and sales, not the developer.** The developer gets everything free; the person judged on what demos bring in might pay for audience insight and lead capture. That's the same buyer Arcade, Storylane and Navattic sell to. If the "who shows up" signal stays developers-only, a hosted business probably isn't there.

**The rule that holds either way:** never charge for rendering, credits or minutes. It would mean charging people for what they can do themselves with one command.

---

## Appendix: the hosted model we built and parked

Everything below is the 2026-10-18 design for Vistaro Cloud. It's kept for reference. The pricing in it is **not** on the website and should be revisited against the lessons above before any revival (in particular, the Team tier leans on review and translation features that developers can do for free).

### 0. Decisions at a glance

| Decision | Call |
|---|---|
| **The rule** | **Never sell generation.** No tokens, credits, render minutes or per-video fees. The CLI renders on the customer's laptop or CI, for free and without limits, forever, and its design does not change. |
| **Name** | **Vistaro** ("Show. Don't Tell."): the CLI, the website and the paid service, **Vistaro Cloud**. |
| **What the Cloud sells** | Everything that happens *after* the render: **publishing** (hosting, embeds, custom domain, password protection, release history), **measuring** (step drop-off, completion, referrers), **converting** (lead-capture gates, CTAs, CRM webhooks), **operating as a team** (help center, review and approval, translation workspace, seats, audit). |
| **Ladder** | Free $0 · Pro **$24/mo** ($19 billed yearly) · Team **$79/mo** ($64 billed yearly) · Enterprise from about **$1,000/mo**, annual. |
| **Pricing unit** | A flat price per **workspace** with seats included. Limits are seats, live demos, release history and analytics retention. **No meter tracks compute.** |
| **The free tier's job** | Distribution. Every free demo carries a "Made with Vistaro" badge that links back, the way Loom, Calendly and Typeform grew. |
| **First dollar** | A team that wants the badge gone, a custom domain or a lead form on a demo that already works (Free → Pro). |
| **Expansion dollar** | A help center that spans every guide and language, translators and reviewers who are not engineers, CRM sync (Pro → Team). |

---

### 1. Why the rule is also the right strategy

The owner set the constraint: no selling tokens or video generation, and the CLI stays as designed. It is also the stronger business:

1. **Selling renders would compete with our own free product.** The CLI already renders anything locally and in CI, and coding agents drive it. A paid "render in our cloud" button only sells to users who could get the same thing free with one `npx` command. That is a thin, price-sensitive wedge.
2. **Renders are cost of goods, and publishing is nearly free to serve.** Each render drives headless Chromium and ffmpeg for minutes. Serving a published demo is static files plus a 2 KB beacon. Margin sits on the hosting side.
3. **The value is downstream.** A demo nobody watches, that can't capture a lead and that rots silently when the UI changes earns nothing, however well it was rendered. Buyers in this category pay for distribution, measurement and conversion. Every incumbent's paid tier is built from those (§2).
4. **It keeps the open-source story clean.** "Unlimited, no watermark on what you export, no account needed" stays true for the CLI. The badge exists only on pages *we host for free*, and that is a fair trade.

---

### 2. What the market pays for

Prices fetched 2026-10-02 (§10). The pattern matters more than the numbers.

| Vendor | How demos are made | What is behind the paywall | Entry paid tier |
|---|---|---|---|
| **Arcade** | Browser capture + GUI editor | Branding removal, custom domain, analytics, lead forms, CRM integrations, team workspace | Growth $42.50–50 per seat |
| **Supademo** | Capture + AI | Branding removal, analytics, lead gates, CRM, custom domains, team | Scale $38–50 per creator |
| **Storylane** | HTML capture + editor | Lead forms, analytics, CRM, demo hubs, custom domains | Starter $40–50; Growth $500+/mo |
| **Navattic** | HTML capture | Analytics, CRM, demo center, custom domain | Unpublished ("contact us") |
| **Scribe** | Extension capture → step guides | Branding removal, custom branding, export, sharing controls, team | Pro $25–35 per seat |
| **Tango** | Extension capture → workflows | Branding, export, admin, analytics | Pro $22–26 per user |
| **Guidde** | Capture + AI voice → video guides | Branding, more videos, team | Pro $19–29 per creator |

What every one of them monetizes is **hosting, branding, analytics, lead capture, CRM sync, custom domains and team features**. None of them charges for "rendering" as such: the capture is the free hook. We take the same proven monetization surface and attach it to a product they cannot copy:

- **Their demos are dead recordings.** A capture rots the day the UI ships. A Vistaro demo is two text files in the repo, rebuilt in CI, with `build-all --diff` flagging stale guides. The Cloud *displays* that freshness (stale badges, webhook alerts). No capture tool can show that signal.
- **Their localization is a re-shoot.** Ours is a strings file, and the Cloud adds the translator workflow on top (§3, Team).
- **Their buyer is a marketer with a browser extension.** Ours is an engineering-led team, plus that team's coding agent, which now produces the demo from one sentence. The Cloud is where the marketer and the support lead come in: analytics, lead forms, the help center, review. That brings a second buyer into the same account.

**Pain points the Cloud answers** (what a buyer actually says):

| "We need…" | Feature | Plan |
|---|---|---|
| "…a link I can send / embed in the docs" | Hosted demos, embed snippet | Free |
| "…to know if anyone watches it, and where they quit" | Views, completion, step drop-off funnels, referrers | Free (7 days) / Pro (funnels, 1 year) |
| "…it to look like ours" | Badge removal, custom domain, accent colour | Pro |
| "…leads from the demo on our homepage" | Email gate, CTA button, CSV export | Pro |
| "…to show an unreleased feature to one partner" | Password-protected demos | Pro |
| "…to undo a bad publish" | Release history, one-click rollback | Pro |
| "…one help site for all our guides, in every language" | Branded, searchable help center on our domain | Team |
| "…marketing to approve before it goes live" | Draft releases from PRs, review links, comments, approvals | Team |
| "…our translators (not engineers) to fix the French" | Translation workspace, translator seats, CI pull-back | Team |
| "…leads in HubSpot / alerts in Slack" | Webhooks (Slack-compatible JSON, works with Zapier and Make) | Team |
| "…SSO, an audit trail, our own VPC" | SSO/SAML, audit log, self-hosted Cloud, SLA, DPA | Enterprise |

---

### 3. The product

```
 repo (index.html + vistaro.config.json)
        │   free, unlimited, local or CI: the CLI as it is today
        ▼
 npx tsx cli.ts export|tour|build-all …  →  guide/ · tour site · reel embed · video
        │
        │   saas/bin/vistaro-cloud.mjs publish <dir> --project <slug>   (static upload, no rendering)
        ▼
 Vistaro Cloud
   APP origin      dashboard + /api: workspaces, seats, tokens, releases, analytics, leads,
                   review, translations, webhooks, billing
   CONTENT origin  /p/<ws>/<demo>/ hosted demos (+ viewer script: beacon, gate, CTA, badge)
                   /h/<ws>/ help center · /r/<key>/ review links · custom domains
```

Built in this repo (all under `saas/`, zero runtime dependencies, nothing in `cli.ts` or `src/` changed):

| Capability | Where |
|---|---|
| Accounts, sessions (HttpOnly cookie, CSRF header), workspaces, roles (owner/admin/editor/translator), invites, seats, hashed CI tokens, audit log | `saas/lib/cloud/accounts.js` |
| Plans as code; every gate returns **402 with `upgradeTo`**, so each limit becomes an upgrade prompt | `saas/lib/cloud/plans.js` |
| Publishing bundles the CLI already built: kind and entry detection (guide, tour, reel, video, page), versioned releases, drafts, approval, rollback, history pruning, `strings.*.json` capture, freshness from `build-all` `index.json` | `saas/lib/cloud/publish.js` |
| Content origin: hosted demos, viewer-script injection, password unlock, lead endpoint, beacon, help center, custom domains | `saas/lib/cloud/content.js`, `saas/public/v.js` |
| Cookieless analytics: views, visits, completion, CTA rate, median dwell, referrers, per-step/per-scenario funnels, plan-bound retention | `saas/lib/cloud/analytics.js` |
| Webhooks (Slack-compatible) for leads, publishes, review requests, stale guides | `saas/lib/cloud/notify.js` |
| Stripe: subscription Checkout, Billing Portal, signed webhooks driving plan changes | `saas/lib/cloud/billing.js` |
| Dashboard (demos, analytics, leads, releases & review, translations, settings, team, CI tokens, billing, audit) | `saas/public/app.html`, `app.js`, `app.css` |
| Publish / pull-strings client for CI | `saas/bin/vistaro-cloud.mjs` |
| Operator: set a plan by hand (Enterprise deals) | `PUT /v1/workspaces/<slug>/plan` |

The old operator **render runner** (`POST /v1/builds`) is still there for self-hosted installs and internal use, behind operator keys. It is **not** part of any plan and is not sold.

---

### 4. Pricing

| | **Free** | **Pro** | **Team** | **Enterprise** |
|---|---|---|---|---|
| Price | $0 | $24/mo, or $19/mo billed yearly | $79/mo, or $64/mo billed yearly | from ~$12k/yr |
| Seats | 1 | 3 | 10 | unlimited |
| Live demos | 3 | unlimited | unlimited | unlimited |
| Releases kept per demo | 3 | 50 | 200 | unlimited |
| Analytics retention | 7 days | 1 year | 2 years | unlimited |
| CLI (render anything, any number of times) | ✓ | ✓ | ✓ | ✓ |
| Hosting, embeds, cookieless analytics | ✓ | ✓ | ✓ | ✓ |
| "Made with Vistaro" badge on hosted demos | shown | removable | removable | removable |
| Custom domain, CTA, lead gate, CSV, password, funnels, rollback | | ✓ | ✓ | ✓ |
| Help center, review & approvals, translations + translator seats, webhooks | | | ✓ | ✓ |
| Audit log, SSO/SAML, self-hosted Cloud, SLA, DPA, invoicing | | | | ✓ |

**Why these numbers.**

- **Pro at $24 is one line item, not five seats.** The GUI tools charge $38–50 *per seat* for badge removal, analytics and lead forms (§2). Three seats for $24 means a three-person team pays about a sixth of Arcade's price. The annual $19 sits at Guidde's entry point.
- **Team at $79 is priced against the $500/mo hosting tiers** (Storylane Growth, Navattic) that first unlock a demo center and CRM sync. We are 6× cheaper, and say so honestly: our analytics is simpler than their deal intelligence. What we sell instead is the help center, translations and review, which they do not have.
- **Flat per workspace with seats included.** Our users add teammates the way they add git collaborators. Per-seat pricing is the capture tools' pattern, and our buyer resents it. Seats still cap each tier, so a growing team climbs the ladder.
- **Enterprise is about security, not volume.** SSO, an audit trail, a DPA and "your unreleased UI never leaves your VPC" (the self-hosted Cloud, next to a CLI that already runs on-prem). A capture SaaS fails this security review by design.

**Fair use instead of meters.** Storage and bandwidth are real costs, but tiny ones (§6). Policy, not yet enforced in code: 10 GB stored per Pro workspace and 50 GB per Team workspace, with a polite email beyond that. A meter would contradict the promise for a cost under a dollar.

---

### 5. Upsell mechanics, where each upgrade happens

The product is built so every wall shows up at the moment of need, with the plan that removes it:

| Trigger (in product) | What the user sees | Upgrade |
|---|---|---|
| A visitor clicks the badge on a free demo | vistaro.dev, with the "make this yours" offer | new signup (viral loop) |
| 4th demo published | `402 … hosts 3 live projects` in CLI output and dashboard | Free → Pro |
| Lead gate, CTA, password, custom domain toggled on | Locked card, "See plans" | Free → Pro |
| Funnel card on Analytics | "Step-by-step drop-off funnels — included in Pro" | Free → Pro |
| Rollback button on an archived release | disabled, "Rollback is part of Pro" | Free → Pro |
| Inviting a 2nd person | `402 … includes 1 seat` | Free → Pro |
| Inviting a 4th person, or a translator | seat / role gate | Pro → Team |
| Help center tab, Translations tab, Webhooks, Review policy, `--draft` from a PR | locked cards, `402 … Team plan` | Pro → Team |
| Audit log tab, SSO question in sales | locked card, "Talk to us" | Team → Enterprise |

Each 402 carries `feature`, `upgradeTo` and `upgradeUrl`, so the publish client prints the exact upgrade link in CI logs (`saas/bin/vistaro-cloud.mjs`).

**Natural progression of an account.** An engineer's agent builds a demo → publishes it free and embeds it in the docs → marketing asks for it on the homepage with a lead form (Pro) → support asks for every guide in one help center in four languages, with marketing approving releases (Team) → security asks for SSO (Enterprise).

---

### 6. Unit economics

Nothing is rendered on our side, so the cost of serving a customer is storage + egress + a share of a small VM:

- A published guide is about 5–30 MB (frames + MP4). A tour site is under 1 MB plus media.
- Egress at CDN list prices is about $0.01–0.08/GB. A demo viewed 2,000 times a month at an average 10 MB transferred is 20 GB, or about $0.20–1.60.
- The API and dashboard run on one small VM ($5–30/mo) for the first several hundred workspaces. The JSON store is the first thing to replace (§8).

At $19–24 a Pro workspace costs us under $1–2/mo, a gross margin above 90%. Compare the old build-minute model, where each render tied up a performance VM for minutes.

**Targets for the first two quarters** (to replace with measured numbers): activation (first publish within 7 days of signup) 40%, free → paid 4–6% of activated workspaces, 30% of paid on annual, Pro → Team 15% within 6 months.

---

### 7. Go-to-market

1. **The CLI is the funnel.** Open source, unlimited, agent-first (AGENTS.md is the integration manual). The website's hero stays "ask your agent", and the second CTA becomes "publish it".
2. **The badge is the viral loop.** Every free hosted demo links to vistaro.dev with `?ref=badge`; measure that referral.
3. **Help centers are SEO surface.** A Team help center on `help.customer.com` is indexed content made with Vistaro (with the footer link on Free).
4. **CI is the habit.** The "Publish from CI" page hands out a ready GitHub Actions workflow: PRs publish drafts with review links, main goes live. Once a team's pipeline publishes, churn is low.
5. **Agent ecosystem.** Publishing is one more command the agent can run (`vistaro-cloud publish`). Listing in agent-tool directories and an MCP server later.
6. **Launch.** Show HN with a demo made and hosted by Vistaro, with live analytics shown in the post. A beta cohort of 10–20 DevRel, docs and support teams gets Team free for 3 months in exchange for feedback.

---

### 8. Before charging money: what production still needs

Honest list. The code above is a working, tested product, but a single-node one:

1. **Storage:** move releases to object storage plus a CDN (keep the content origin a separate hostname, as now). Move `cloud.json` to Postgres.
2. **Custom domains:** automate TLS (Caddy on-demand TLS, or the host's certificate API) and verify the CNAME before activating.
3. **Email:** invites and password resets currently show a link in the dashboard and send nothing. Wire an email provider (Postmark, Resend).
4. **Webhook SSRF guard:** today the guard is https-only. Production must also refuse private and link-local IPs at connect time.
5. **SSO/SAML:** sold on Enterprise, not built. Use WorkOS or similar when the first deal needs it.
6. **Legal:** terms, privacy policy, DPA. Analytics is cookieless by design and leads are the customer's data (we are a processor).
7. **Stripe setup:** products and prices for `STRIPE_PRICE_{PRO,TEAM}_{MONTHLY,ANNUAL}`, the webhook endpoint `/api/billing/webhook` with `STRIPE_WEBHOOK_SECRET`, Stripe Tax and the customer portal configuration.
8. **Ops:** backups of the data dir, uptime monitoring, rate limits shared across nodes (they are in-memory today).

---

### 9. Risks

| Risk | Mitigation |
|---|---|
| Customers self-host the static output and never pay | That is fine. The free CLI is distribution. The Cloud sells the parts that need a server and a team (analytics, leads, review, translators, help center); static hosting alone was never the product. |
| GUI incumbents add "code export" | They can export; they cannot regenerate. The freshness signal, the translation pull-back and the agent workflow are pipeline properties, and they live in our free CLI. |
| Too small a market (dev-led demo tooling) | The Cloud's second buyer is marketing and support, which the incumbents prove pays. The help center and translations sell to every product-led SaaS going multi-locale. |
| Badge resentment | The badge is only on pages we host for free, never in exported files. Removing it is the cheapest paid step. |
| Single-node scaling | Fine for launch; §8 is the path. Rendering never touches the server, so load is static serving. |

---

### 10. Evidence

- Competitor pricing pages fetched 2026-10-02: arcade.software/pricing, supademo.com/pricing, storylane.io/pricing, navattic.com/pricing (no public prices), scribe.com/pricing, tango.ai/pricing, guidde.com/pricing. Remotion's license (remotion.dev) is the precedent that companies pay for source-driven video.
- The competitor research and naming checks of the superseded model stay readable in this file's git history (the 2026-10-02 revision).
- Product claims in §3 are covered by `test/saas-cloud-*.test.ts` (41 tests, including a canary that fails if any plan ever meters rendering) and the end-to-end HTTP checks in `saas/smoke.mjs`.
