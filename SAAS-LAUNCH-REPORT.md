> **Superseded (2026-10-18).** This report describes the October 3 "Demoforge" plan, which sold cloud build-minutes and API calls. The product is now **Vistaro**, launching **free and open source**; a hosted service was designed and built (`saas/`) but is parked. Read [`docs/saas/BUSINESS-MODEL.md`](docs/saas/BUSINESS-MODEL.md) for the current decision. This report is kept for its history and verification record.

# SaaS launch report — Demoforge

*Written 2026-10-03 for the repo owner, who was away while this was built. Everything below
describes the current working tree: **nothing is committed and nothing is published** — the
repo's agent rules forbid agents from committing, pushing or publishing, so those acts are
deliberately yours; §7.1 gives you the commit plan. The tree also carries older uncommitted
work that predates this launch run (the `demo/` content rework, `AGENTS.md` edits, a
`src/engine/runtime.js` box-sizing fix, an `OUTPUT_REVISION` bump in
`src/commands/build-all.ts`); it was left untouched and shares the tree. Every claim cites a
file read, a command run (executor named per gate in §4), or the material handed to this
report. Owner questions the first draft left open are answered in §7.*

---

## 1. Executive summary

- **Strategic recommendation made: go to market as Demoforge** — "product demos as code:
  versioned with your repo, reviewed in the pull request, rebuilt in CI when the UI changes."
  The name is *validated, not adopted*: the npm name was verified free on 2026-10-02, but
  nothing is renamed (the package is still `screenshot-animator@2.0.0`), no domain is bought,
  no trademark cleared — your sign-off is the gate, tradeoffs in §7.3. Full strategy doc:
  `docs/saas/BUSINESS-MODEL.md`.
- **Two new agent-facing CLI surfaces, built and executed:** `verify <dir>` (build + audit a
  demo in one command, writes `verify.json`) and `record --learn` (record a live app once,
  get a draft timeline back). The package was made installable (`bin/` shim, `files`
  whitelist, `prepublishOnly`) — **not published**.
- **The cloud half exists and works:** a zero-runtime-dependency Node SaaS MVP under `saas/`
  — zip upload → serial export queue → public embed URLs, a Stripe Checkout stub, a dark
  dashboard. For this report I re-ran the 17-check smoke test *and* a real end-to-end build
  (zip in, MP4 served back) — both passed (§4).
- **The marketing site exists:** `website/index.html`, a single self-contained dark landing
  page whose hero plays a reel the CLI generated during this run; pricing matches the
  strategy doc; not hosted anywhere yet (§7.2).
- **All 7 launch gates pass on the final tree — every one re-executed while writing this
  report**, command output quoted per row in §4. What remains is owner-gated work (accounts,
  keys, legal, the name/publish decisions: §5) plus the engineering that work unblocks (the
  PR-preview GitHub App, SaaS hardening). What you can actually sell on day one: §7.4.

## 2. Business model digest

Full doc: [`docs/saas/BUSINESS-MODEL.md`](docs/saas/BUSINESS-MODEL.md) (decisions §0, pricing
rationale §4, human launch checklist §8).

| | |
|---|---|
| **Name** | **Demoforge** — the strategy doc's recommendation; npm name verified free 2026-10-02, **not registered**; trademark **not cleared**; domain **not bought**. The package still says `screenshot-animator` — see §7.3 |
| **Positioning** | Developer-first demo compiler: the demo is two text files in the repo, regenerable in CI, agent-reviewable as text, compiled to video + guide + reel + tour + every locale from one source. Not a GUI editor, not capture-first (that's Arcade/Scribe/Supademo's buyer, deliberately not chased) |
| **Free** | The OSS CLI, forever: unlimited local builds, every output type, no watermark |
| **Builder** | **$29/mo** per workspace — 3 seats, 500 build-min, 25 hosted embeds, PR-preview builds¹, 2,000 API calls, 5 locales |
| **Team** | **$99/mo** per workspace — 15 seats, 2,500 build-min, 100 embeds, 25,000 API calls, unlimited locales, custom embed domain |
| **Enterprise** | **Custom** (~$500/mo anchor) — SSO, audit log, **self-hosted build runners**: demos of UI your company hasn't launched yet render on machines you control instead of being uploaded to a vendor's cloud — the capture tools have no equivalent option |
| **Overage** | $0.10/build-minute · $1/hosted embed/mo · $5 per extra 1k API calls — hard caps, no surprise bills |

¹ *Roadmap: the PR-preview feature needs a GitHub App that is not built yet (§5.5). What the
MVP actually runs today: cloud builds, hosted embed URLs and the bearer HTTP API (tested,
§3.4). Analytics, PR previews, locale management, metering and live checkout are not built —
that's what §5.1–2 buy.*

Why these numbers (doc §4): $29 undercuts the per-seat GUI median (Arcade/Supademo/Scribe/
Tango at $38–50/seat, fetched 2026-10-02); $99 flat undercuts the $500+/mo hosting tiers
(Storylane/Navattic); usage metering maps to the real cost driver — every build runs a full
headless Chromium + ffmpeg. What the numbers *don't* have yet is measured unit economics —
§7.5.

## 3. What was built, and how to run it

### 3.1 CLI: `verify` — build and audit in one command

- Code: `src/commands/verify.ts` (report contract at `src/commands/verify.ts:22-29`), registered
  in `cli.ts:306-309`, documented in README/AGENTS reference blocks.
- Contract example:

  ```bash
  npx tsx cli.ts verify demo        # any dir with index.html + anim.config.json
  ```

  Writes, into that directory: `verify.mp4` + `verify.vtt` (the export pipeline reused whole),
  `verify.strip.png` (filmstrip contact sheet), and `verify.json` — exactly
  `{ ok, durationMs, steps: [{index, id, action, actualMs, completedMs, error?}], chapters, issues }`
  (failed timings serialize as `null`, `error` only on failed steps). Exit 1 on any failed
  step, error-level issue, or missing artifact; a one-screen summary prints instead of a video
  you'd have to watch.
- Executed for this report: `npx tsx cli.ts verify test/fixtures/basic` → exit 0, "OK: every
  step ran, no errors", 9 steps with measured timings, artifacts written. The failure path
  (exit 1, `ok: false`, failed steps named) was drilled during the run on a `/tmp` copy with a
  broken target — workstream-attested, not re-run here. Two honest footnotes: it deliberately
  takes no options beyond `<dir>`, and it has no dedicated automated test file (§4 note 2).

### 3.2 CLI: `record --learn` — record a live app, get a timeline draft back

- Code: `src/commands/learn.ts`, wired into `record` via `cli.ts:266` and the driver's
  `afterStep` hook (plain `export` is untouched — byte-identical path). Marked
  **(experimental)** in the help.
- Contract example:

  ```bash
  npx tsx cli.ts record demo --url https://app.local/save --storage-state auth.json \
      -o demo.mp4 --learn draft/learned.json
  ```

- What you get: `draft/learned.json` — a schema-valid draft `anim.config.json` of the
  interactions the recording actually performed (click/type/press/navigate, observed times,
  targets re-resolved to the stablest selector: `data-help` > `#id` > `tag.class` > positional)
  — plus `draft/learned.json.notes.md` (what was captured, which selectors are fragile, and the
  add-titles checklist). No titles are invented; add them before building a guide. Exits 1 with
  no files when nothing was captured; hook failures degrade to warnings, so learning can never
  fail a recording.
- Executed for this report: `node --import tsx --test --test-concurrency=1 test/learn.test.ts`
  → 2/2 pass (11.5 s), including a real browser recording with `--learn` (a 7-step two-page
  flow proving e.g. `data-help` beats `#id`, and the empty-capture exit-1 path).

### 3.3 npm packaging — ready, NOT published

- `bin/screenshot-animator.mjs` (executable shim). One disclosed deviation from a naive shim:
  `cli.ts` only runs under `require.main === module` (`cli.ts:451`), so importing it
  in-process would load it and run nothing — the shim instead spawns
  `node --import tsx <pkg>/cli.ts <args>` with exit-code forwarding, the repo's own canonical
  no-build invocation.
- `package.json`: `bin` (line 9), `files` whitelist (line 16), `prepublishOnly` =
  `tsc --noEmit && npm run docs:check` (line 30), `tsx` moved to `dependencies` (line 50 —
  an installed bin needs it at runtime). `repository.url` is a **placeholder**
  (`github.com/OWNER/screenshot-animator`, line 14).
- Re-run for this report: `npm pack --dry-run` → `screenshot-animator-2.0.0.tgz`, **45 files,
  204.1 kB** (the run's earlier measure said 44 files / 198.5 kB; the difference is
  `src/commands/learn.ts`, which landed after it). No test/, fixtures or demo junk inside;
  shim tested from the repo cwd (exit 0) and from `/tmp` (exit 1 forwarded) during the run.
- **Not published. Nothing committed.** Final package name is an open decision (§7.3).

### 3.4 SaaS backend (`saas/`) — MVP, runs today, money is stubbed

- Files: `saas/server.js`, `saas/lib/{httputil,auth,zip,project,jobs,queue,stripe}.js`,
  `saas/public/index.html` (dark dashboard), `saas/smoke.mjs`, `saas/README.md` (the real
  documentation — quickstart, API, env vars, deploy sketch, honest gap list).
- Quickstart (zero `npm install` for the API itself; real builds need the repo toolchain):

  ```bash
  SAAS_API_KEYS="dfk_dev_local_1" node saas/server.js   # http://127.0.0.1:8787
  node saas/smoke.mjs                                   # 17 checks, exits PASS
  ```

- Endpoints: `GET /health` · `POST /v1/builds` (project zip → 202 queued) ·
  `GET /v1/builds[/<id>]` · `POST /v1/billing/checkout` · `GET /embed/<id>/<path>` (public,
  Range-capable) · `GET /` (dashboard). Auth: Bearer keys from `SAAS_API_KEYS`; unset ⇒ every
  `/v1/*` call is 401 — the server never runs open.
- **What is stubbed / MVP by design** (`saas/README.md:213-253`): billing returns
  **501 `billing not configured`** until `STRIPE_SECRET_KEY` + `STRIPE_PRICE_BUILDER` /
  `STRIPE_PRICE_TEAM` are set (no webhooks, no entitlements, no metering); auth is static
  shared keys; the queue is in-process and serial (a restart fails in-flight jobs — one
  browser-driven export at a time, per the repo's own warning); artifacts live on local disk
  and are served **same-origin**, an XSS co-residency risk flagged for production (S3/CDN +
  separate domain); the Dockerfile and `fly.toml` inside the README are labeled sketches,
  **not deployed**. Test hook: `SAAS_DISABLE_RUNNER=1`. Security specifics: §7.6.
- Verified for this report (both re-run by me): `node saas/smoke.mjs` → "17 checks passed,
  0 failed / PASS"; and the path the smoke can't cover — booted the real server, uploaded a
  zip of `test/fixtures/basic`, watched it go queued → done in **12,519 ms** through a
  genuine `npx tsx cli.ts export` spawn, then `GET /embed/<id>/out/demo.mp4` →
  `HTTP/1.1 200 OK`, `content-type: video/mp4`, `accept-ranges: bytes`.

### 3.5 Marketing website (`website/`) — open and look at it

- Open it: `open website/index.html` (fully self-contained: inline CSS, system fonts, no
  build step), or serve the folder (`npx serve website`). Not hosted anywhere yet — §7.2.
- One page, sections: nav → hero → **the reel** → how it works → agent-review band →
  what-you-get (6 cards) → pricing → 7-question FAQ → CTA → footer. Primary CTAs point at
  `/checkout` — a **placeholder** until the SaaS is deployed; all GitHub links point at the
  repo's real remote `github.com/clarido/screenshot-animator` (confirmed via `git remote -v`).
- What's embedded — **all of it real output generated during this run**:
  - `website/src/reel/embed-desktop.html` — the CLI-generated looping embed page
    (`build website/src/reel --embed --device desktop`), playing in the hero via the embed
    snippet's postMessage play/pause protocol (`website/index.html:842-853`).
  - `website/assets/reel.mp4` (2560×1440, ~4.4 MB — exported at 1280×720 `--scale 2`) plus its
    siblings `reel.webm`, `reel.poster.png`, `reel.gif`, from
    `npx tsx cli.ts export website/src/reel -o website/assets/reel.mp4 -w 1280 -H 720 --scale 2`.
  - `website/assets/guide-step.png` — a real captured guide frame
    (`demo/guide/assets/step-08.png`); `website/assets/demo-filmstrip.png` — a real
    `filmstrip demo.mp4` strip (`demo/demo.strip.png`).
- The "check its own work" terminal block quotes a real `check demo` run. I re-ran
  `npx tsx cli.ts check demo` for this report: the quote is a faithful condensation (0×0
  caret on step 5, camera 1.18 / window 1627×915 / target 100% visible on step 6, summary
  "0 error(s), 1 warning(s), 3 info"). I also re-ran the encode-level check on the hero reel
  itself: `filmstrip website/assets/reel.mp4 --diff` → 22-frame strip + 21 motion intervals;
  the largest change is the *authored* rail camera push (8% of frame, 9.0–9.5 s); before it,
  motion is ≤1.5% and localized to the lines being typed — no unintended motion.

## 4. Verification — the gate results

Every gate below was **re-executed for this report on the final tree, 2026-10-03**, by the
report writer; the quoted output is the real output. Two evidence items remain
workstream-attested rather than re-run, and are marked as such: the verify failure-path drill
and the original 44-file npm-pack measure (superseded by my 45-file re-run).

| Gate | Command (re-run) | Evidence (quoted) |
|---|---|---|
| `tsc` | `npx tsc --noEmit` | exit 0, no output |
| `docs` | `npm run docs:check` | "CLI reference up to date in README.md, AGENTS.md." |
| `static-tests` | `npm run test:static` | `# tests 176 … # pass 85 … # fail 0 … # skipped 91`, 20.8 s (browser/TTS tests skipped by design; count differs from the run's earlier 174 because `learn.test.ts` landed after that measure) |
| `verify-command` | `npx tsx cli.ts verify test/fixtures/basic` | `OK: every step ran, no errors.` — exit 0, 9 steps with measured `actual`/`completed` ms, verify.mp4/.vtt/.strip.png/.json written |
| `reel-check` | `npx tsx cli.ts check website/src/reel` | `OK: …/website/src/reel/anim.config.json (9 steps, static + browser check, 2 info)` — the 2 infos are camera-framing facts |
| `saas-smoke` | `node saas/smoke.mjs` | `17 checks passed, 0 failed` / `PASS`, exit 0 |
| `full-suite` | `npm test` (all browser tests included) | `# tests 176 … # pass 176 … # fail 0 … # skipped 0`, exit 0, 697.6 s (11.6 min) |
| SaaS E2E (bonus) | boot server → `POST /v1/builds` (zip) → poll → `GET /embed/<id>/out/demo.mp4` | job `bld_6cfef4c39be30bb9`: `status: done`, `durationMs: 12519`, then `HTTP/1.1 200 OK / content-type: video/mp4 / accept-ranges: bytes` |
| Reel encode check (bonus) | `npx tsx cli.ts filmstrip website/assets/reel.mp4 --diff` | 22-frame strip; 21 motion intervals; busiest = 8% of frame at 9.0–9.5 s (the authored camera push) |

Two things I found while re-verifying (not gate failures — hygiene):

1. `test/fixtures/basic/` contains `verify.mp4/.vtt/.strip.png/.json` and an untracked
   `anim.manifest.json`, timestamped today — my own `verify` re-run recreated what the
   workstream had cleaned. The MP4/strip are gitignored; **`verify.json` and
   `anim.manifest.json` are untracked and not ignored** and would be committed by a future
   `git add -A`. Tests pass with them present (the full suite ran against this exact state),
   so it's tidiness, not breakage — delete before committing (§7.1).
2. No dedicated automated tests exist for `verify` or the packaging shim (their evidence is
   the executed runs above). Fine to ship; worth adding if the CLI becomes a published
   package.

## 5. Known gaps and next steps — ordered by what unblocks revenue first

1. **Deploy the SaaS** (first dollar = hosted embeds + cloud builds). Needs a hosting account
   (the README's Dockerfile/`fly.toml` are sketches to adapt, `saas/README.md:156-211`), a
   domain, and `SAAS_API_KEYS`. Builds need the repo toolchain (Chromium + ffmpeg) in the
   image. Before charging money on it, close at least the account/metering/queue gaps from
   the README's "MVP vs production" list — right now there are no users, no usage counting,
   and a restart loses the queue. Costs: §7.7.
2. **Stripe live keys.** Checkout is an honest 501 stub until `STRIPE_SECRET_KEY`,
   `STRIPE_PRICE_BUILDER`, `STRIPE_PRICE_TEAM` and success/cancel URLs exist
   (`saas/README.md:132-149`). Beyond the stub: webhooks (`checkout.session.completed`),
   subscription state, entitlement checks — not built.
3. **Domain, trademark, website hosting, name claims.** Buy `demoforge.dev` as the primary
   domain, and buy `demoforge.io` as well as a defensive registration so nobody can squat the
   name one keystroke away from yours. Run trademark clearance against the defunct 2000s
   "DemoForge" screen-capture brand (DemoForge Studio / the DfMirage driver — independently
   confirmed defunct by a web search for this report; classes 9 = software, 42 = SaaS; the
   doc's §2/§8.2 found the same). Expect namespace noise: on launch day, searching the name
   surfaces several unrelated same-category hobby repos (largest: `granth-agarwal/DemoForge`,
   4★, "paste a URL, get a clean MP4 walkthrough") plus that dead product — the doc's answer
   is a first-party site plus same-day npm/GitHub-org claims. **And deploy the marketing
   site**: `website/` is a static directory — GitHub Pages/Netlify/Cloudflare Pages; note
   `website/src/reel/embed-desktop.html` is a generated file the hero iframe needs, so commit
   it (or rebuild it in CI) or the site ships without its hero. Costs: §7.7.
4. **npm publish** (free, but it is GTM channel #1 and gates the `npx demoforge` story).
   Blocking decisions first: the package is still `screenshot-animator@2.0.0`
   (`package.json:2`) while every public surface says Demoforge — pick one, rename (name, bin
   key, repository URL placeholder `OWNER`), make the ISC-vs-MIT license call
   (`docs/saas/BUSINESS-MODEL.md` §8.5), then publish. Don't publish under either name until
   the §7.3 criteria are back.
5. **First beta users.** 10–20 hand-picked DevRel/docs/engineering teams
   (`docs/saas/BUSINESS-MODEL.md` §8.6), staged ahead of a Show HN post (§6). What they can
   be sold on day one is narrower than the Builder card — see §7.4. The GitHub App that runs
   `build-all --changed-only --diff` on PRs is the Builder-tier wedge and does not exist yet
   (§8.7 of the doc); it's the first genuinely paid feature to build.

## 6. Review as the human — eyeball these before shipping

1. **The name.** `package.json` still says `screenshot-animator`; the site, SaaS and docs all
   say Demoforge. Recommendation and tradeoffs: §7.3. The decision touches npm publish, the
   GitHub org, the domain and six hardcoded GitHub URLs on the site
   (e.g. `website/index.html:446,472,662,808-810`).
2. **Pricing numbers.** Site pricing table (`website/index.html:650-710`) vs the doc's §4 —
   they match today ($0 / $29 / $99 / custom + the overage line), including plan limits
   (3 seats, 500 min, 25 embeds, 2,000 calls…). The rationale is competitive positioning
   (§2 above); *measured* unit economics don't exist yet (§7.5) — confirm you accept numbers
   whose cost side is still qualitative. Also make the pricing page honest about the ¹
   roadmap item (§2).
3. **Hero copy.** Headline is the positioning verbatim
   (`website/index.html:462`): "Product demos as code: versioned with your repo, reviewed in
   the pull request, rebuilt in CI when the UI changes." Subhead names the ICP and the wedge.
4. **Competitor claims.** The FAQ names Arcade/Supademo/Storylane/Navattic/Scribe/Tango and
   the strategy doc quotes their prices as fetched **2026-10-02** (doc §5, §9). Comparative
   marketing + price quotes age — re-verify before public launch.
5. **`package.json` repository placeholder** — `github.com/OWNER/screenshot-animator`
   (`package.json:14`) must become the real URL before `npm publish`.
6. **The SaaS risk acceptance list.** `saas/README.md:213-253` is the honest list of what
   this MVP is not (shared static keys, in-memory queue, same-origin embeds/XSS, no
   metering, no webhooks). Taking paying users on this build means accepting items 1–6 of
   that list; the same-origin-embeds item is a real security risk, not just debt (§7.6).
7. **`/checkout` and `sales@demoforge.dev`.** Every buy button on the site goes to a
   nonexistent `/checkout` route and the footer to an unwritten mailbox
   (`website/index.html:450,471,706,814`) — fine as placeholders, embarrassing if the site
   ships as-is.
8. **The fixture residue** (`test/fixtures/basic/verify.*` + untracked `anim.manifest.json`,
   Section 4) — delete before your first commit (command in §7.1).

## 7. Owner questions, answered

1. **How do I commit this?** The house rule (this repo's agent instructions) forbids agents
   from `git commit`/`push`/`npm publish` — reviewing and committing is intentionally the
   human's act; that's why everything is sitting in the working tree. Suggested order:
   ```bash
   # 1. generated residue (the .mp4/.strip.png are already gitignored)
   rm test/fixtures/basic/verify.mp4 test/fixtures/basic/verify.vtt \
      test/fixtures/basic/verify.strip.png test/fixtures/basic/verify.json \
      test/fixtures/basic/anim.manifest.json
   # 2. commit in groups: (a) your pre-existing work first — demo/ rework, AGENTS.md,
   #    src/engine/runtime.js, src/commands/build-all.ts; (b) CLI work — src/commands/
   #    {verify,learn}.ts, cli.ts, bin/, package.json, package-lock.json, test/,
   #    README/AGENTS reference blocks, sample/ deletions; (c) saas/; (d) website/ +
   #    docs/ + this report.
   ```
   One decision inside (b/d): `website/src/reel/animated.html` is generated (the manual says
   such files aren't tracked) — skip it; `embed-desktop.html` is *also* generated but the
   live site needs it, so commit it or rebuild it in deploy CI.
2. **Where does the marketing website get deployed?** Nowhere yet — nothing hosts it. It's a
   static directory (`website/`, ~30 MB with the reel assets); any static host works
   (GitHub Pages / Netlify / Cloudflare Pages). Must-ship files: `index.html`, `assets/*`,
   and `src/reel/embed-desktop.html` (the hero iframe's source). Pair the deploy with the
   domain in §5.3.
3. **If I push back on the name — tradeoffs?** Recommendation: adopt **Demoforge**, pending
   the two gates below. For it: npm name free (alternatives demokit/demogen are taken),
   "forge" lands the dev-first story, and every public asset already written to it.
   Against: rename cost (package name + bin key, ~6 site links, GitHub org/repo move, docs),
   launch-period search noise (hobby repos + the dead DemoForge brand), trademark risk.
   Keeping `screenshot-animator` costs nothing to migrate but is generic, long, carries no
   positioning — and you'd rewrite the same site copy anyway. **Decision criteria:** (1)
   trademark clearance comes back clean, (2) `demoforge.dev` is buyable. If clearance fails,
   fallbacks verified npm-free: `democraft`, `reelwright` (doc §2). Nothing is registered
   under either name today, so this decision is still free.
4. **What can I actually sell at $29 on day one?** Less than the Builder card lists. Works
   today (code exists, tested in §4): cloud builds via the API, public hosted embed URLs, the
   dashboard — sellable as a hand-provisioned "cloud builds + hosting" beta with a shared
   key. Not built yet: per-workspace accounts, view/completion analytics, PR-preview builds
   (the GitHub App), locale management, metering/overage, live Stripe checkout. So either
   sell a narrowed founding tier now, or finish the missing pieces first — don't put
   PR-preview builds on the pricing page until the App exists.
5. **Unit economics — what does a build-minute cost?** Unknown: no cost data exists anywhere
   in the repo, and `docs/saas/BUSINESS-MODEL.md` §4 argues cost-mapping qualitatively only.
   The one measured fact: my E2E build of a 9-step/8-s demo took **12.5 s** of export on this
   Mac; builds drive a full headless Chromium + ffmpeg and are load-sensitive (AGENTS.md).
   Arithmetic on public list prices: one dedicated Fly performance VM ≈ $31/mo ≈ $0.0007 per
   machine-minute — so the $0.10/min overage has ~100× headroom on machine cost *if* one
   small machine serves builds serially (real utilisation will be worse; the sketch picks a
   2× VM). Action: after deploy, log p50/p95 `durationMs` per job for two weeks, then
   validate the $0.10 number against the actual host bill.
6. **Who has security-reviewed the SaaS?** No one beyond the builders. What the code does
   give you: timing-safe bearer comparison (`saas/lib/auth.js:39-42`), fail-closed 401 when
   no keys are configured, a hand-written zip reader that rejects path traversal, symlinks,
   zip64 and entry bombs (`saas/README.md:19-20`; the smoke test asserts the 401s, the 403s
   on internal files, and a `%2f` traversal → 400). What it does not have: any external or
   adversarial review, tenants (every key holder can read every job), rate limiting, a CORS
   story, per-job sandboxing — the CLI spawn runs with full server privileges on
   attacker-supplied timeline content (`saas/README.md:250-253`), and uploaded HTML is served
   same-origin (the flagged XSS risk). Minimum before public money: separate embed domain +
   per-workspace keys; a paid penetration test is the real gate.
7. **What will §5.1–3 cost and take?** No estimates existed in any repo source; these are
   public list prices fetched by web search today (2026-10-03), to be re-quoted at purchase:
   **Hosting** — Fly.io performance VM ≈ $31/mo (1 vCPU/2 GB; the sketch picks the bigger
   performance-2×), tiny shared machines from ~$2–6/mo; bandwidth/storage billed separately.
   **Domain** — `.dev` ≈ $10–14/yr at at-cost registrars (Porkbun/Cloudflare via
   [tld-list.com](https://tld-list.com)). **Trademark** — USPTO base filing is $350 per class
   (post-Jan-2025 structure; two classes ≈ $700 government fees, plus surcharges for sloppy
   filings) per [Traverse Legal](https://www.traverselegal.com) and
   [mekiplaw.com](https://www.mekiplaw.com); registration typically 9–12 months, so run
   clearance first and don't block launch on registration; the clearance search itself is a
   counsel quote. **Stripe** — no monthly fee; 2.9% + $0.30 per standard card transaction.
   **Time shape:** deploy + Stripe + domain + site hosting are days of work once the accounts
   exist (accounts themselves: same day); clearance search: counsel-dependent (days–weeks);
   the GitHub App: unestimated engineering. Launch checklist with owners' tasks:
   `docs/saas/BUSINESS-MODEL.md` §8.

---

*Report by the launch run's report writer, revised the same day after cold-reader review.
Grounding: every file cited inline; every gate and check in §4 re-executed for this report
(commands and output quoted); workstream-attested items marked as such; pricing/cost figures
from web searches dated 2026-10-03 with sources linked in §7.7. Nothing was committed,
published, or modified except this file (plus the gitignored side effects of re-running the
gates).*
