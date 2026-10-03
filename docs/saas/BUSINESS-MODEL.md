# Demoforge — Business Model

Strategy doc for taking this repo (today `screenshot-animator@2.0.0`, `package.json`) to market as a SaaS.
Written 2026-10-02. All pricing evidence was fetched the same day; see [§9 Evidence](#9-evidence--sources).

---

## 0. Decisions at a glance

| Decision | Call |
|---|---|
| **Name** | **Demoforge** (confirmed — npm name free, no active same-named company/product) |
| **Positioning** | Developer-first **demo compiler**: the product demo as code — validated, sharpened, not overturned |
| **Free tier** | OSS CLI, unlimited local builds, no watermark (the repo as it stands) |
| **Paid ladder** | Builder **$29/mo** · Team **$99/mo** · Enterprise **custom** |
| **What the cloud sells** | Hosted tour/guide/reel embeds with analytics · GitHub PR-preview builds · agent HTTP API · localization management |
| **Who we are not** | Not a GUI editor, not capture-first, not a general-purpose video framework |

---

## 1. Positioning & ICP

**Positioning.** Demoforge is for teams whose demos, help guides and product clips are engineering artifacts: developers, DevRel engineers, doc engineers and technical founders who live in git and CI. It wins because a Demoforge demo is two text files in the repo — reviewed in a pull request, diffed pixel-by-pixel, rebuilt only when the UI changed, driven end-to-end by a coding agent, and compiled into video, guide, reel, tour and every locale from one source.

**ICP (primary):** engineering-led product teams (seed→Series C) that ship UI weekly and need their demos/guides to keep up; DevRel and docs teams already comfortable with CLIs; solo technical founders creating launch assets. The operator is increasingly **an AI agent** — the manual (`AGENTS.md`) is literally written for an LLM, and the review loop (`check` reporting camera framing as facts, `preview --motion`, `filmstrip`) exists so motion can be judged without watching (README.md:84).

**ICP (secondary):** PMs and doc engineers who can read a JSON timeline but would never build a GUI-editor demo themselves.

**Deliberately not our buyer:** the marketing/enablement user who wants a browser-extension capture and a GUI editor. Arcade, Supademo, Storylane, Navattic and Tango own that segment with funded GUI products and per-seat sales motion. We do not chase them; we take the teams they cannot serve — the ones who refuse a binary blob in their repo.

**Validation of the owner's positioning (why it holds):**

1. The differentiation is structural, not cosmetic. A capture tool records pixels; a dead recording. Demoforge's output is regenerable: `build-all --changed-only` rebuilds only what changed against a content-hash build key (AGENTS.md:217, 362) and `--diff` flags drifted frames pixel-by-pixel. That is a CI property, and only a code-first tool can have it.
2. The product is already agent-shaped. Target probing per step, camera framing reported as facts, `--json` issues, `trace.json` geometry, `filmstrip --diff` motion facts — the entire review surface is text and JSON (README.md:84). Competing GUI tools have no agent surface at all.
3. "Demo as code" has paying precedent next door: Remotion charges companies for programmatic video ($100/mo minimum once >3 employees, remotion.pro) — proof that engineering teams pay for source-driven video. Nobody sells *demo semantics* (cursor, spotlight, camera, subtitles, guides, locales) as code. That is the open wedge.

---

## 2. Name decision

**Final name: Demoforge.** Used everywhere downstream (product, npm, docs, site).

**Evidence gathered 2026-10-02:**

| Check | Command / source | Result |
|---|---|---|
| npm availability | `npm view demoforge` | **E404 — free.** Claim it before launch. |
| GitHub name search | GitHub API `search/repositories?q=demoforge in:name` | 43 repos. Most noise; **4–5 are in our exact category but all are personal projects with 0–4 stars** (top: `granth-agarwal/DemoForge`, "paste a URL, get a clean MP4 walkthrough", 4 stars, active Feb–Mar 2026; `upxill/agent-demoforge`, `rznies/demoforge`, `holburn-hornssentinel/demoforge` ≤1 star). No company, no product, no traction. |
| Historical brand | Web search | "DemoForge" was a defunct 2000s Windows screen-recording/FTP vendor (DemoForge Studio, BlackMoon FTP, a virtual-display driver). Dead brand; trademark clearance is a human launch task (§8). |
| Alternates | `npm view demokit` → **taken (v7.0.0)**; `npm view demogen` → **taken (0.1.1)**; `npm view democraft` / `reelwright` / `demo-craft` → free | see below |

**Alternates considered (and rejected):**

1. **Democraft** — npm free; reads toy-like and carries no "built from source" connotation.
2. **Reelwright** — npm free; covers only the reel output, not guides/tours/localization; narrower than the product.
3. **Demokit** — rejected outright: npm name taken (v7.0.0).

**Why confirm Demoforge:** short, verb-y, and "forge" lands the dev-first story (built from source, like GitLab/Forgejo "forge" vocabulary). The same-category GitHub repos are all sub-5-star weekend projects — the name converging on this category is mild evidence it *fits* it. With a first-party site and an OSS launch we take over the search results; we cannot take over "demokit". Residual cost: some GitHub search noise at launch; trademark clearance against the dead DemoForge brand is required (human task, §8). Domain and GitHub-org availability were **not** checked in this session (§9).

---

## 3. Value proposition & messaging pillars

**Value proposition (site, one sentence):** Your product demo is two text files in your repo — Demoforge compiles them into demo videos with subtitles and chapters, step-by-step help guides, looping marketing reels and interactive tours, in every language, regenerated whenever the UI changes.

### Pillar 1 — Regenerate, don't re-record

The UI moved? Run the command again; `build-all --changed-only` rebuilds only what changed and `--diff` marks guides whose frames drifted (README.md:17; build-key mechanics at AGENTS.md:217, OUTPUT_REVISION at AGENTS.md:362). Screen recordings and capture-tool projects are dead ends that rot on contact with the sprint cadence; a Demoforge demo has a freshness check in CI. *Message: "Demos that keep up with your sprint."*

### Pillar 2 — Reviewable like code, without watching

The timeline is JSON in a pull request and the whole pipeline runs headless in CI (README.md:20). Motion is auditable as text: `check` probes every target right before its step and reports each camera push's framing as facts — what's in frame, what's cut (AGENTS.md Workflow step 3; README.md:84); `preview --motion` samples a real playback pass; `check --trace` writes per-step cursor/spotlight/subtitle/camera geometry; `filmstrip --diff` turns the exported MP4 into what-moved-when facts. A coding agent fixes a badly aimed zoom like any other lint finding. No GUI tool offers an agent anything. *Message: "Your agent can review the demo, so you don't have to watch it."*

### Pillar 3 — One source, every output, every language

The same timeline compiles to MP4 (+`.vtt`, chapters, narration), a Scribe-style step guide (`guide.json`/`.md`/`.html` + cropped frames), a marketing reel (MP4/WebM/poster/GIF, embeddable looping page) and an interactive tour site — and `localize` shares the choreography across locales so a French build is a strings file, not a re-shoot (README.md:18–19, 27–32; AGENTS.md Localization, line 26). Numbers and currency formats localize too (`$2.4M → 2,4 M$`), because a translated American product reads as a translated American product (AGENTS.md, Localization). *Message: "Write it once; ship the video, the guide, the reel and the tour — in ten languages."*

---

## 4. Pricing ladder

Free OSS CLI forever (unlimited local builds, no watermark) + paid cloud workspace. The CLI stays free because every cloud product below is genuinely server-side; the free CLI is the distribution engine, not lost revenue.

| Tier | Price | Who buys | What they get |
|---|---|---|---|
| **Free (OSS CLI)** | $0 | every developer, agents | Everything local: unlimited `check`/`build`/`preview`/`export`/`tour`/`localize`, no watermark, all output types, batch `build-all`. No hosting, no analytics, no PR previews, no API. |
| **Builder** | **$29/mo** per workspace | solo devs, technical founders, first DevRel hire | 3 seats · 500 cloud build-minutes/mo · 25 hosted tour/guide/reel embeds with view/completion analytics · GitHub App PR-preview builds (`--changed-only` + stale-frame diff report on every PR) · agent HTTP API 2,000 calls/mo · 5 managed locales · email support |
| **Team** | **$99/mo** per workspace | product/docs/DevRel teams | 15 seats · 2,500 build-minutes/mo · 100 hosted embeds · 12-month analytics retention · 25,000 API calls/mo · unlimited managed locales + translation memory · custom embed domain · priority support |
| **Enterprise** | **custom** (anchor ~$500/mo+) | orgs with security review | SSO/SAML · audit log · **self-hosted build runners** (recordings never leave the customer's infra; cloud serves embeds + analytics only) · SLA · DPA · private preview domains · dedicated support |

**Overage:** $0.10/build-minute; $1/hosted embed/mo beyond plan; $5 per extra 1k API calls. Hard caps, no surprise bills.

**Why these numbers:**

- **Flat per-workspace, not per-seat.** Our ICP adds teammates the way git does — freely — and per-seat pricing is the capture-tools pattern we explicitly reject. Remotion prices per company + usage (remotion.pro); Vercel/Netlify normalize flat + metered for dev tools. Usage dimensions (build-minutes, embeds, API calls) map to real cost: each build drives a headless Chromium + ffmpeg.
- **$29 entry undercuts the GUI median** — Arcade Growth $42.50–50/seat, Supademo Scale $38–50/creator, Scribe Pro Personal $25–35/seat, Tango $20–26/user, Guidde Pro $19–29/creator (all fetched 2026-10-02, §9). The po story is "one line item, not five seats."
- **Team $99 flat vs. the $500+ hosting tiers** (Storylane Growth $500–625/mo, Navattic Base/Growth unpriced but historically ~$500/mo+): we are 5× cheaper because our analytics is honest about being simpler — we sell CI + agent + localization, and say so on the pricing page.
- **Enterprise self-hosted runners are the wedge within the wedge:** capture tools must route your product's pixels through their cloud; our CLI already runs fully on-prem, so "your unreleased UI never leaves your VPC" closes security reviews the GUI vendors fail.

---

## 5. Competitive landscape & our wedge

Prices fetched from vendor pricing pages on **2026-10-02** (§9); annual-per-month in parentheses.

| Vendor | How demos are made | Entry paid tier | Top tier shown | Basis | Why we don't fight / what we take |
|---|---|---|---|---|---|
| **Arcade** | GUI editor + browser capture | Growth $50/mo ($42.50) | Enterprise custom | per seat | Their buyer wants zero code. We take teams needing git/CI/agent workflows. |
| **Supademo** | GUI editor + AI capture | Scale $50/mo ($38)/creator | Growth $450/mo ($350) | per creator | Same. Their AI-credit pricing ($99–500 packs) is a different cost model entirely. |
| **Storylane** | GUI editor, HTML demo editor | Starter $50/mo ($40) | Premium $1,500/mo ($1,200) | flat + seats | Deep sales/marketing analytics (account reveals, deal intelligence) — not our job. |
| **Navattic** | GUI editor, HTML demos | Base/Growth unpriced ("contact us") | Enterprise custom | flat/annual | Same segment; opaque pricing itself repels the dev buyer. |
| **Scribe** | Extension capture → step guides | Pro Personal $35/mo ($25)/seat; Team $17/mo ($13) | Enterprise custom | per seat | **Closest output overlap** (step guides!) but capture-based: not regenerable, no diff, no CI, no multi-output compile. |
| **Tango** | Extension capture → workflows | Pro $26/mo ($22)/user | Enterprise custom | per user | Same story as Scribe. |
| **Guidde** | Capture + AI voiceover → video guides | Pro $29/mo ($19)/creator | Business $59/mo ($39)/creator | per creator | Video-guides overlap; again capture-first, single output, no source of truth. |
| **Remotion** | **Code-first**, general programmatic video | Company license ~$100/mo min (creators $25/seat, or $0.01/render) | Enterprise custom | per company | Neighbour, not enemy: no demo semantics (cursor/spotlight/camera/subtitles), no guides, no tours, no localization — and a much steeper authoring cliff. Proof devs pay for source-driven video. |
| **Motion Canvas** | Code-first, free OSS animation lib | free | free | — | Validates the authoring model; general animation, zero demo semantics, no CLI pipeline. |

**Our wedge, one line:** *the only tool where the demo is source code* — regenerable in CI (Pillar 1), agent-reviewable as text (Pillar 2), compiled to video + guide + reel + tour + N locales from one timeline (Pillar 3) — with the local/free-first deployment story (unreleased UI can stay in your VPC) that no capture SaaS can copy without becoming a different product.

---

## 6. GTM plan

| # | Channel | First moves |
|---|---|---|
| 1 | **GitHub OSS** | Rename to `demoforge` (name verified free), MIT-or-keep-ISC decision, landing README with generated outputs, Discussions open, apply to GitHub Stars. Get listed on relevant awesome lists (documentation, devtools, CI themes) via PRs — the README's "why not just record your screen" section (README.md:13–23) is the pitch. |
| 2 | **Show HN** | "Show HN: Demoforge – product demos as code (MP4 + guides + tours from two text files)". Lead with the regeneration/diff story and a demo *made with Demoforge* (dogfooding: `reels/` and `tour.catalog.json` in this repo are already that). Ship on a Tuesday–Wednesday morning US. |
| 3 | **Dev Twitter/X + LinkedIn** | Build-in-public from the maintainer account; every clip is generated by the tool (the marketing asset *is* the product demo). Post the agent workflow: paste screenshots → agent ships localized demo in a PR. |
| 4 | **Docs SEO** | Programmatic pages: "demo as code", "screenshot to video CLI", "open-source Scribe alternative", "Arcade/Supademo alternative for engineering teams", "regenerate product demos in CI", "programmatic video for product demos (Remotion compared)". Each guide/reel output type gets a page with a live embed (hosted = the paid product, demonstrated). |
| 5 | **AI-agent ecosystem** | The agent *is* the channel: publish `AGENTS.md` as the canonical integration manual, ship an agent skill (the repo already carries `skills-lock.json`), add `llms.txt`, later an MCP server; list in agent-tool directories. Every coding agent that can run `npx demoforge` is a distribution point; the cloud API is how agents without a sandbox become paid users. |

**Motion:** OSS adoption (1–2) creates the CLI user base; PR-preview builds and hosted embeds are the natural first dollar (they need a server); localization management + API expand accounts (4–5). Target: 1k GitHub stars and 10 paying workspaces in the first two quarters post-launch.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| GUI incumbents (Arcade, Scribe…) ship a "code export" and blur the wedge | Depth wins, not checkbox: diff/CI/build-keys/agent review/localization compile is a pipeline, not a feature flag; OSS trust + first-mover in "demo as code". Keep shipping the agent surface they structurally lack. |
| Market too small (dev-first demo tooling is a niche of a niche) | The ICP is widening on its own (DevRel + docs teams + agents); free CLI removes adoption risk; localization (Pillar 3) sells to every product-led SaaS going multi-locale, well beyond the demo niche. |
| "Demoforge" namespace noise: 4–5 tiny same-category GitHub repos + dead DemoForge brand | Claim npm name and GitHub org immediately; first-party site + SEO from day one; trademark clearance as a pre-launch human gate (§8). |
| Free-forever CLI cannibalizes cloud revenue | Cloud sells only server-side value (hosting, analytics, PR builds, API, locale management); Remotion precedent shows companies pay for source-driven video; metered build-minutes capture heavy users. |
| Cloud builds are heavy/flaky (headless Chromium + ffmpeg per build; repo docs warn about machine load) | Metered minutes with hard caps, per-plan concurrency queues, the existing timeout ladders (`FFMPEG_TIMEOUT_MS`, per-step abandonment) as templates; self-hosted runner option on Enterprise offloads the worst tail. |
| Remotion-adjacent LLM tools erode "write a timeline yourself" | The moat is not the renderer, it's the review pipeline (check facts, trace, filmstrip diff, build-keys) + demo semantics + compile-to-N-outputs. Make Demoforge the layer agents call, whatever renders underneath. |
| Solo-maintainer bus factor / support load from OSS | Free tier is CLI-only with docs (`AGENTS.md` already is the support doc); paid tiers fund support; Community Discussions deflect repeats. |

---

## 8. Launch checklist (human tasks)

1. **Domain:** check and buy `demoforge.dev` (primary) / `.io` (defensive). *Not verified in this session.*
2. **Trademark:** clearance search for "Demoforge" (classes 9/42) — specifically against the defunct DemoForge screen-recorder brand; file if clean.
3. **GitHub org + npm name:** create `demoforge` org; `npm publish` rights on the `demoforge` package (verified free 2026-10-02). Claim same-day as the public announcement.
4. **Stripe account:** activate Stripe Tax, set up the two plan prices + metered overage (`build-minutes`, `embeds`, API calls) as usage records.
5. **OSS license call:** repo is ISC today (`package.json`) — confirm ISC vs MIT/Apache-2.0 for the renamed CLI before the announcement.
6. **Beta cohort:** 10–20 hand-picked DevRel/docs/engineering teams from network; instrument onboarding with the existing manifest + `--json` outputs; collect timeline-telemetry consent.
7. **GitHub App for PR previews:** build the app that runs `build-all --changed-only --diff` on PRs and comments with preview links + stale-frame report (Builder/Team gating).
8. **Marketing site:** landing page, pricing page (§4), docs; every demo asset on the site generated by Demoforge itself.
9. **Show HN:** draft post + a 60–90s Demoforge-made clip; stage 1 and 2 above first so the thread has something to star.
10. **Analytics + SLA plumbing:** embed analytics collector (the client-side events already exist — `tourstep`/`tourend`/`tourready`, AGENTS.md:284), billing alerts, status page.

---

## 9. Evidence & sources

**Checks run this session (2026-10-02):**

- `npm view demoforge` → E404 (name free). `npm view demokit` → taken v7.0.0; `npm view demogen` → taken v0.1.1; `npm view democraft|reelwright|demo-craft` → all E404 (free).
- GitHub API `search/repositories?q=demoforge in:name` → 43 repos; top same-category: `granth-agarwal/DemoForge` (4★, pushed 2026-03-08, "paste a URL, get a clean MP4 walkthrough"), `upxill/agent-demoforge` (1★), `rznies/demoforge` (0★), `holburn-hornssentinel/demoforge` (1★), `karansaini46/DEMOFORGE` (1★).
- `package.json` → name `screenshot-animator`, version 2.0.0, license ISC.
- Repo grounding: README.md:13–23, 27–32, 84; AGENTS.md:26, 217, 284, 362, 462 (line numbers from `grep -n` this session).

**Pricing pages fetched 2026-10-02** (numbers quoted in §4/§5 come verbatim from these fetches): supademo.com/pricing; scribe.com/pricing (via redirect); navattic.com/pricing (dollar prices not published); storylane.io/pricing; tango.ai/pricing (via redirect); guidde.com/pricing; arcade.software/pricing; motion-canvas.io (OSS confirmed; license text not stated on page).

**Web search (rate-limited backend; used where fetches failed):** Remotion license tiers (free ≤3 employees; creators $25/mo/seat from ~3 seats; automators $0.01/render, $100/mo min) via search results citing remotion.dev; initial Arcade figure (~$42/seat/mo) later confirmed directly on arcade.software/pricing.

**Not run / not verifiable here (human launch tasks):** domain DNS availability, GitHub org-name availability, trademark search, Stripe setup. Navattic's Base/Growth dollar prices are not published anywhere public as of this date.
