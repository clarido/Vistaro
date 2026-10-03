# Demoforge SaaS — MVP backend

The cloud half of [Demoforge](../../docs/saas/BUSINESS-MODEL.md): an HTTP API that
accepts a **project zip** (a Demoforge screen: `index.html` + `anim.config.json` + media),
queues an export through this repo's own CLI (`npx tsx cli.ts export …`), and serves the
resulting video and guide artifacts at public embed URLs — plus a minimal dark dashboard
and a Stripe Checkout stub for the Builder/Team ladder.

**Zero runtime dependencies** — `node:http`, `node:crypto`, `node:zlib` and the built-in
`fetch` only. No `npm install` is needed to run the server or its smoke test. (Running
*builds* does need the parent repo's `node_modules`, see below.)

```
saas/
  server.js         entry point: env, routing, auth, embed serving
  lib/
    httputil.js     JSON responses, capped body reads, Range-capable file serving
    auth.js         Bearer API keys (SAAS_API_KEYS), timing-safe compare
    zip.js          ZIP reader written by hand (no built-in unzip in Node):
                    stored + deflate, UTF-8 names, zip-slip / symlink / bomb guards
    project.js      unzip into <job>/project/, unwrap a wrapper folder, require a screen
    jobs.js         job store: saas/data/jobs/<id>/{job.json,upload.zip,project/,out/}
    queue.js        serial in-process export queue (one browser-driven CLI at a time)
    stripe.js       Stripe Checkout Sessions over the REST API with fetch
  public/index.html dark dashboard (plain HTML/CSS/JS, no framework)
  smoke.mjs         boots the server on an ephemeral port, no browser needed
```

## Quickstart

```bash
# from the repo root — the server is zero-dep, nothing to install for the API itself
SAAS_API_KEYS="dfk_dev_local_1" node saas/server.js
# → listening on http://127.0.0.1:8787

node saas/smoke.mjs        # 17 checks, boots its own server, exits clean: PASS
```

Open `http://127.0.0.1:8787/` for the dashboard (paste the API key; it is kept in
localStorage). Or drive it with curl — see [API](#api).

**Running real builds** needs the parent repo's toolchain next to the server, because
each job spawns `npx tsx cli.ts export <job>/project -o <job>/out/demo.mp4` with `cwd`
set to the repo root:

```bash
npm install && npx playwright install chromium   # the repo's own setup (AGENTS.md)
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port (`0` = ephemeral; the boot line on stdout carries the real one). |
| `HOST` | `127.0.0.1` | Bind address. |
| `SAAS_API_KEYS` | *(none)* | Comma-separated Bearer keys. **Unset ⇒ every `/v1/*` request gets 401** — the server never runs open. |
| `SAAS_DATA_DIR` | `saas/data` | Where jobs live (`jobs/<id>/…`). Gitignored. |
| `SAAS_REPO_ROOT` | parent of `saas/` | cwd for the spawned CLI — must be a checkout of this repo with its dependencies installed. |
| `SAAS_MAX_UPLOAD_MB` | `100` | Upload cap; larger bodies get 413. |
| `SAAS_EXPORT_TIMEOUT_MS` | `1800000` (30 min) | Hard cap per export; SIGTERM, then SIGKILL 10 s later. |
| `SAAS_DISABLE_RUNNER` | unset | `1`: accept and queue jobs but never spawn the CLI. Test hook — used by `smoke.mjs`; jobs then stay `queued` forever. |
| `STRIPE_SECRET_KEY` | unset | Enables checkout. **Unset ⇒ `POST /v1/billing/checkout` returns 501 `billing not configured`.** |
| `STRIPE_PRICE_BUILDER` | unset | Stripe price ID for the Builder plan ($29/mo). |
| `STRIPE_PRICE_TEAM` | unset | Stripe price ID for the Team plan ($99/mo). |
| `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` | request origin | Checkout redirect URLs (e.g. `https://demoforge.dev/billing/success`). |

## API

Auth: every `/v1/*` endpoint requires `Authorization: Bearer <key>` with a key from
`SAAS_API_KEYS`. `/health`, `/` and `/embed/*` are public.

### `GET /health`

```bash
curl -s http://127.0.0.1:8787/health | jq
# { "ok": true, "service": "demoforge-saas", "version": "0.1.0",
#   "queue": { "depth": 0, "running": false, "runnerDisabled": false },
#   "billing": "not_configured", "plans": ["builder", "team"], "repoRoot": "…" }
```

### `POST /v1/builds` — upload a project, queue an export

Body: the project zip as the **raw request body** with `Content-Type: application/zip`
(`415` for anything else, `413` over the cap, `400` when the zip is unreadable or does
not contain `index.html` + `anim.config.json` at its root — a single wrapper folder is
unwrapped automatically).

```bash
cd my-demo && zip -r ../my-demo.zip index.html anim.config.json media/ && cd ..
curl -s -X POST http://127.0.0.1:8787/v1/builds \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/zip" \
  --data-binary @my-demo.zip | jq
# { "id": "bld_9f2c…", "status": "queued", "queuePosition": 1,
#   "links": { "self": "/v1/builds/bld_9f2c…", "embed": "/embed/bld_9f2c…/" }, … }
```

The upload is unpacked to `saas/data/jobs/<id>/project/` and queued. **Builds run one at
a time** — the repo manual warns that concurrent browser-driven exports corrupt each
other — so a second job waits (`queuePosition` tells you where).

### `GET /v1/builds` and `GET /v1/builds/<id>`

```bash
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/builds | jq '.jobs[0]'
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8787/v1/builds/bld_9f2c | jq
# { "id": "bld_9f2c…", "status": "done", "durationMs": 4269,
#   "artifacts": { "video": "/embed/bld_9f2c…/out/demo.mp4",
#                  "subtitles": "/embed/bld_9f2c…/out/demo.vtt",       // when the timeline has subtitles
#                  "guideHtml": "/embed/bld_9f2c…/project/guide/guide.html", // when the CLI wrote a guide
#                  "poster": "…/project/guide/assets/poster.png" },
#   "command": "npx tsx cli.ts export … -o …/out/demo.mp4",
#   "log": "…last 8 kB of the CLI's stdout+stderr…" }
```

`status` is `queued` → `running` → `done` | `failed` (with `error` and the CLI's `log`
tail). A server restart marks `queued`/`running` jobs `failed` — the queue is in-memory
by design at this stage.

### `GET /embed/<id>/<path>` — public artifacts

No auth: these URLs are what you iframe or hand to a customer. Range requests are
supported, so `<video>` seeking works.

- `/embed/<id>/` — tiny status page linking whatever artifacts exist.
- `/embed/<id>/out/demo.mp4` — the video.
- `/embed/<id>/out/demo.vtt` — subtitles, when the timeline has any.
- `/embed/<id>/project/guide/guide.html` — the step guide, when one was captured.
- `job.json` and `upload.zip` are internal (`403`), and path traversal (`..`, `%2f`,
  symlinks inside the archive) is rejected before it reaches the filesystem.

### `POST /v1/billing/checkout` — Stripe Checkout

```bash
# without STRIPE_SECRET_KEY (the honest stub):
curl -s -X POST http://127.0.0.1:8787/v1/billing/checkout \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"plan": "builder"}' -i | head -1
# HTTP/1.1 501 Internal Server Error   {"error":"billing not configured"}

# with STRIPE_SECRET_KEY and STRIPE_PRICE_BUILDER set:
# → 200 {"id":"cs_live_…","url":"https://checkout.stripe.com/c/pay/…","mode":"subscription","price":"price_…"}
```

Body: `{"plan": "builder" | "team"}` (mapped through `STRIPE_PRICE_*`) or
`{"price": "price_…"}` for a specific price ID. Talks to
`https://api.stripe.com/v1/checkout/sessions` with `fetch`, form-encoded — the Stripe
npm package is deliberately not a dependency. Stripe-side errors surface as `502` with
Stripe's message. Enterprise (custom pricing) is not wired to self-serve checkout.

### Dashboard — `GET /`

`saas/public/index.html`: paste the key, upload a zip, watch the queue, open the
artifacts. Plain HTML/CSS/JS, no build step, dark theme, no telemetry.

## Deploy guide (sketch)

The API process is a single Node file; the only heavyweight fact is that **builds run
Chromium + ffmpeg inside the same machine**, so the container needs the Playwright
browser and its OS libraries.

```dockerfile
# saas/deploy sketch — NOT CI-tested; tune to your base image and registry.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    # Playwright chromium deps (see playwright docs for the authoritative list):
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libatspi2.0-0 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY . .
ENV PORT=8080 HOST=0.0.0.0 SAAS_DATA_DIR=/data
VOLUME /data          # jobs + artifacts live here; mount a volume or an EBS/Fly volume
EXPOSE 8080
CMD ["node", "saas/server.js"]
```

```toml
# fly.toml sketch — NOT deployed; read with the Fly docs at hand.
app = "demoforge-saas"
primary_region = "cdg"

[build]
  dockerfile = "Dockerfile"

[env]
  HOST = "0.0.0.0"
  PORT = "8080"
  # secrets, not env: `fly secrets set SAAS_API_KEYS=… STRIPE_SECRET_KEY=…`

[http_service]
  internal_port = 8080
  force_https = true
  # A build occupies a full browser for minutes: 1 machine, no autoscale below 1.
  min_machines_running = 1

[[vm]]
  size = "performance-2x"   # exports are CPU- and memory-hungry (headless Chromium)

[mounts]
  source = "demoforge_data"
  destination = "/data"
```

The server binds `HOST=0.0.0.0` from env; put TLS termination (Fly proxy, Caddy, nginx)
in front. Artifacts are served from the API's origin, which is fine for an internal MVP
and wrong for a public product — see below.

## MVP vs production — what this deliberately is not

Honest list, in rough order of pain:

1. **Auth is static shared keys.** `SAAS_API_KEYS` is a flat list of bearer tokens: no
   users, no workspaces, no sessions, no rotation, no revocation per customer, and the
   dashboard holds a raw key in localStorage. Production needs accounts (e.g. OAuth
   magic link), per-workspace keys with hashing at rest, and scoped permissions.
2. **The queue is in-process and in-memory.** One Node process runs one export at a
   time; a restart marks in-flight jobs `failed`; there is no retry, no priority, no
   per-plan concurrency (BUSINESS-MODEL.md §4 sells "per-plan concurrency queues"), and
   no visibility into a job's live progress. Production wants a durable queue (even
   Postgres-backed) with worker processes separate from the API, retries with backoff,
   and job progress streaming.
3. **Artifacts live on local disk** under `saas/data/jobs/…`. No S3, no CDN, no
   lifecycle policy, no signed URLs — and `/embed/*` is public-by-design with no
   capability URLs. Production wants object storage + CDN, signed or scoped embed URLs,
   and ideally artifacts served from a *different domain* than the API: an uploaded
   `index.html` is arbitrary HTML, so serving it same-origin with the API is an XSS
   co-residency risk the day real user sessions exist.
4. **No webhooks / job events.** Clients poll `GET /v1/builds/<id>`. Production wants
   signed webhooks (`build.done`, `build.failed`) and/or SSE progress.
5. **No metering.** The model sells build-minutes and API calls; nothing counts them.
   The manifest-style `durationMs` per job is recorded but there is no usage ledger,
   no hard caps, no overage.
6. **Billing is a stub plus two price IDs.** No customer records, no subscription
   state, no webhook from Stripe (`checkout.session.completed`, invoice paid/failed),
   no entitlement checks tying a paid plan to API limits. Checkout returns a session
   URL and that is all.
7. **One machine does API + rendering.** Exports drive a real headless Chromium; the
   repo manual warns they are sensitive to machine load and must not run concurrently.
   Production separates API nodes from a pool of build runners (the Enterprise
   "self-hosted runner" story is exactly this, customer-side).
8. **Hardening gaps:** no rate limiting, no request IDs, no structured logs/metrics,
   no CORS story (embeds don't need one; the API assumes same-origin), no input
   validation beyond the zip parser's guards, and `SAAS_EXPORT_TIMEOUT_MS` is the only
   circuit breaker.
9. **The CLI spawn assumes a warm repo**: correct `node_modules`, installed Chromium,
   and ffmpeg via `ffmpeg-static`. A cold container must run the setup first; there is
   no per-job sandbox (a malicious zip's timeline can only touch its own project
   directory through the CLI, but the CLI runs with full server privileges).

## Verified

- `node saas/smoke.mjs` → **17 checks passed, PASS**, exit 0 (boots its own server on an
  ephemeral port, `SAAS_DISABLE_RUNNER=1`, no browser; always kills the server and
  removes its temp data dir).
- The runner spawn path is additionally exercised end-to-end with a real browser export
  (zip upload → serial queue → `npx tsx cli.ts export` → `out/demo.mp4` served with a
  valid MP4 header); that path needs the repo toolchain, so it is *not* part of
  `smoke.mjs`, which must run without it.
