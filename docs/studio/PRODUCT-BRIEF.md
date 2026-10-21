# Demoforge Studio — Product Brief

**Status:** shipped (M1 + M2) · **Owner:** JF · **Last updated:** 2026-10-04 · **Implementation:** `src/studio/`, `src/commands/studio.ts`, launched by `npx tsx cli.ts studio <dir>`

---

## One line

A local web editor over the demo timeline: pick what to make, edit it with your hands — drag elements, grab the cursor, translate the copy — while the file it saves stays the plain `vistaro.config.json` that agents, CI and the CLI already read.

## The problem it solves

Demoforge's core promise is *demos as code*: two text files in the repo that compile to video, guides, reels and tours in every locale. That power had one gate — you had to author JSON. Three audiences stalled at that gate differently:

- **Developors who know what they want but not in JSON** — a camera push at 1.3× is a feeling, not a `scale: 1.3`.
- **The people around developers** (PMs, DevRel, founders) — no terminal, no workflow.
- **Everyone, at the broken moments** — a timeline that fails validation or a corrupt file was worst-served by the tool built around it.

Capture tools (Arcade, Supademo, Tango) solve the same problem by *recording pixels* — and inherit its weaknesses: the capture rots when the UI changes, edits are manual, nothing is versioned. The studio solves it without becoming one of them.

## Positioning

The studio is the **middle rung of the authoring ladder**:

| Rung | Tool | For |
|---|---|---|
| Click once | `record --learn` | People who'd rather demonstrate than describe |
| **Edit visually** | **the studio** | **People who'd rather drag than type JSON** |
| Write directly | any editor / agent | Agents, CI, diffs |

The anti-Arcade stance, stated in the UI itself: **a view over the file, never a second source of truth.** There is no project database, no hidden state, no "export to code" — the editor holds a dirty in-memory copy, saves are explicit (⌘S), unknown fields survive byte-for-byte, and git is the undo system. The opposite arrangement — a GUI that owns your demo and deigns to emit code — is precisely the product we are not.

## Users

- **Primary — the visual developer.** Has the repo open, wants the cursor path and the camera push to *feel* right before committing. Lives on the keyboard; every interaction that falls back to a form field is a tax on them.
- **Adjacent — PM/DevRel/founder.** Served today by sitting next to the primary; served directly later by the same editor bundle hosted in the SaaS (M3) with server-side export.
- **Unaffected — agents and CI.** The studio changes no schema, no command, no output. A studio-authored timeline is byte-compatible with a hand-written one; that equivalence is a test, not an aspiration.

## What it does today

**Authoring** — concept picker on an empty directory (product demo + guide / marketing reel / blank — the same scaffolds `init-config` writes); a step rail (add, duplicate, reorder, delete, time/action/id at a glance); a schema-driven inspector that shows the fields the selected action needs plus whatever the step has set, with everything else behind one "all fields" disclosure; a raw-JSON escape hatch per step so fields the forms don't know still round-trip.

**The preview tells the truth** — the mockup runs in an iframe driven by the same tour scheduler the product ships; playback is seekable (jump to any step), and the timeline is resolved exactly as export would resolve it: per **device** (a mobile-only step genuinely disappears from the desktop build; the canvas reframes to 390×844) and per **locale** (the preview plays the translated demo — from the `locales/<locale>/` directory when it exists, else with the strings file overlaid).

**Direct manipulation** (the premium layer) — click an element to select it; drag it to author the step's motion (`to.x`/`to.y`); corner handles to scale (`to.scale`); Alt-drag the cursor glyph to nudge it off its target (`xOffset`/`yOffset` — fields the runtime always honored that no UI ever surfaced); a guarded Layout mode that moves absolutely-positioned boxes by patching inline styles into `index.html`, refusing flow elements honestly. A live W×H badge rides the selection while you gesture; the inspector's fields update as you drag — the form and the hand edit the same JSON, visibly.

**Effects** — a palette of reveal/camera/transition presets that write plain `from`/`to`/`ease` fields, and an easing picker whose previews run the runtime's real cubic-bezier curves.

**Verification and output in-app** — Check runs the real browser pass and lists findings beside the step that caused them (click to seek); Export encodes `studio.*` artifacts through the same pipeline, against the device and locale being previewed.

**Localization** — a locale switcher covering both product conventions; in a locale, the text fields become translation fields that write `strings.<locale>.json` (never the inline base text), missing translations marked in the rail, "+ new locale…" scaffolds the same pre-filled shape `localize` writes. Renaming a step id moves its strings keys in every file, across both conventions.

**The broken-file promise** — a timeline that fails to parse is the editor's headline state, not a dead end: the parse error leads the footer and the Raw tab becomes a whole-file editor; fix it there, Apply, save.

## Guardrails (what we will not do)

- The file is the truth. No hidden state, no database, no lock-in. Every gesture ends as plain JSON or a reviewable inline-style diff in `index.html`.
- Git is the undo. No in-editor history that pretends to replace it.
- Palette, not a video editor. The vocabulary stays steps + actions + presets. No free-form keyframing, no timeline trimming, no surgery on rendered pixels — editing after export is the same act as editing before it, because the video is an output, never the source.
- One browser job at a time (the repo's own law); check/export serialize in-process.
- Concurrency honesty: mtime guards refuse to overwrite a file that changed on disk (timeline, screen, or strings); another window's work is never silently lost.

## Verification (how we know it works)

- Nine browser tests in `test/studio.test.ts` cover the contracts: unknown-field round-trip, strings-key renames, corrupt-file recovery, drag-to-animate and Alt-drag cursor deltas (expected values derived from the measured transform scale), mockup patching with structure/mtime refusals, device mapping and resolved previews, translation round-trip with grammar and 409 refusals.
- A dual-agent design critique scored the editor 25/40 (Acceptable) at M1 and every finding — keyboard correctness, inspector disclosure, screen-reader wiring, corrupt-file silence, small-viewport honesty — was fixed and verified; the snapshot lives in `.impeccable/critique/` for the next scoring round.
- A fresh-context code review before each commit; its findings (HTML injection into `index.html`, tag-count drift from runtime chrome, camera-space layout math, a stuck-gesture pointer bug, drive-by CORS) were all fixed with proofs before landing.
- The dogfooding rule: every claim above is exercised against this repo's own `demo/` (nine steps, one mobile-only step, device overrides, a full French locale).

## Roadmap

- **M3 — the hosted studio.** The same editor bundle served by the SaaS backend with authenticated remote export: the cloud tier's visual-authoring story, completing the ladder for non-terminal users without forking the product.
- **Deferred tail, in rough value order:** an in-session undo stack (git stays the history), a keyboard path for target picking, a template gallery (promote the `reels/ask-anything`-class examples), the trace-geometry overlay (`check --trace` rendered over the preview), tour-concept support in the concept picker.
- **Explicitly out of scope:** pixel editing, audio editing, collaboration features, any stateful "project" model.

## Packaging

Free, part of the CLI, forever — the studio is distribution, not premium (per the business model: the CLI is the distribution engine; the cloud sells hosting, CI and the API). The M3 hosted variant is a paid-tier surface, using the identical bundle.
