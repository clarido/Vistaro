# Website work for the showcase (Lot 6) — to do locally

The engine side of Lot 6 is in the repo: five clips, one per new capability, built by `build-all` from `showcase.catalog.json`, so they rebuild whenever the engine changes. The website side is left to you, as agreed. This note lists exactly what it needs.

## 1. Build the clips

```bash
npx tsx cli.ts build-all showcase.catalog.json
```

Output goes to `showcase-out/` (gitignored by `*-out/`). Measured on 2026-11-13: 5 built, 0 failed, about 15 s per clip.

| Slug | Shows | Frame | Length | MP4 | WebM | Poster (PNG) | Audio |
|---|---|---|---|---|---|---|---|
| `transitions` | push in/out, modal over a scrim, dismiss, toast | 1280x720 | 6.8 s | 603 KB | 361 KB | 105 KB | none |
| `brand-kit` | intro card, accent spotlight, branded caption and cursor, corner logo, outro card (from `showcase-clips/brand.json`) | 1280x720 | 7.5 s | 655 KB | 389 KB | 144 KB | none |
| `auto-zoom` | `camera` with `follow` at 1.5x and the natural cursor | 1280x720 | 8.5 s | 739 KB | 511 KB | 100 KB | none |
| `vertical` | the same screen at 9:16 (`aspect` in the catalog), push up, a sheet, typing | 540x960 | 5.2 s | 505 KB | 290 KB | 143 KB | none |
| `audio` | synthesized clicks under each click (`meta.audio.click`) | 1280x720 | 4.6 s | 477 KB | 275 KB | 142 KB | 1 stream, quiet clicks |

Paths are `showcase-out/<slug>/en/<slug>-en.{mp4,webm,poster.png}`; `showcase-out/index.json` lists them all (rows carry `video`, `poster` and the WebM beside the video).

## 2. Gallery on `website/animations.html`

One card per clip, each beside the timeline snippet that produced it, with a copy button. The snippet is the clip's `showcase-clips/<slug>/anim.config.json`, or for the brand kit `showcase-clips/brand.json` plus the timeline's `meta` block. Show the part that matters, not the whole file:

- transitions: the two `transitionScreen` steps (`"transition": "push"`) and the `overlay` steps;
- brand kit: `"brand": "../brand.json"` plus `brand.json`;
- auto-zoom: the `camera` step with `"follow": true` and `meta.motion.cursor`;
- vertical: the catalog row (`"aspect": "9:16"`, `"scale": 0.5`) and the `@media (max-width: 1100px)` block of `index.html`;
- audio: `"audio": { "click": true }`.

Standards from the plan:

- **Posters in WebP.** `build-all` writes PNG; convert at publish time, e.g. `ffmpeg -i <poster>.png -c:v libwebp -quality 82 <poster>.webp`. Expect roughly a third of the PNG size.
- `<video preload="none" poster="…webp" muted playsinline loop>` with WebM first, then MP4. No autoplay with sound. The audio clip should only play sound after a click on an explicit "sound on" control.
- **Captions on**: these are reels, so their words are in the page. Put each card's one-line caption next to the video as text, not in a `.vtt`. The vertical and brand-kit clips also burn their captions in.
- **Reduced motion**: under `prefers-reduced-motion: reduce`, show the poster only (no `<video>` source, or `autoplay` off and no play-on-scroll).
- **Page-weight budget**, to agree before building. Against the numbers above, five WebMs come to about 1.8 MB and five WebP posters to roughly 0.2 MB. With `preload="none"` the initial page cost is the posters only; agree a cap (for example 300 KB of posters above the fold) before adding clips.

## 3. Elsewhere on the site

- `website/index.html`, outputs section: one row linking to the gallery (`animations.html#showcase`), with the transitions poster as its thumbnail.
- `website/sitemap.xml`: if the gallery gets its own anchor page, add it; otherwise refresh `animations.html`'s `<lastmod>`.
- `website/llms.txt`: Lots 0 and 1 already added two lines (the `capabilities` command, motion and brand). Add one for the gallery URL and one sentence on transitions/overlays, auto-zoom, `--aspect` and `meta.audio`.

## 4. CI

The `deploy-website` job in `.github/workflows/test.yml` should run `npx tsx cli.ts build-all showcase.catalog.json --changed-only` before copying `showcase-out/` into the published site. Keep `test/ci-workflow.test.ts` green: it only asserts the three checks (`docs:check`, `tsc`, `npm test`) stay unguarded on push, so adding a build step to the deploy job does not touch it.

## 5. Test to add with the gallery

`test/showcase.test.ts` already proves every showcase timeline is check-clean and that the catalog names one clip per capability. When the gallery exists, add the plan's other assertion: every clip the gallery references exists after `build-all showcase.catalog.json`. Parse `website/animations.html` for `showcase-out/…` URLs and `fs.existsSync` each one, after a build in the test or against the CI build's output.
