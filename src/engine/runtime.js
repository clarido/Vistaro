/*
 * anim-cli in-page runtime (plain browser JavaScript, no build step).
 *
 * Loaded two ways:
 *   - `build` inlines it before </body> followed by `__anim.boot({...timeline...})`;
 *   - `record`/`check`/`preview`/`export` inject it via Playwright (addInitScript or
 *     addScriptTag) and drive it step by step from Node with `__anim.runStep(step, {leadMs})`.
 *
 * It holds the visual primitives (cursor, spotlight highlight, click ripple, typing,
 * camera, scroll, subtitles, fades) and a ~20-line optional scheduler (`play`) used
 * only when animated.html is opened directly in a browser. When Node drives the page
 * it sets `window.__ANIM_DRIVEN = true` before load so `boot` never self-plays.
 *
 * Timing: a step's `timeMs` is the moment the interaction happens. `runStep` is
 * started `leadMs` earlier and spends `leadMs - 150` travelling the cursor, then
 * highlights + presses for 150ms, then acts and dispatches `anim:step`.
 *
 * Must not use require/import/TypeScript. Must survive injection at document start
 * (DOM creation is deferred until DOMContentLoaded when document.body is null).
 */
(function () {
  'use strict';
  if (window.__anim) return;

  var PRESS_MS = 150;
  var DEFAULT_LEAD_MS = 950;
  var DEFAULT_CPS = 25;
  var DEFAULT_CAMERA_S = 2.5;
  var FADE_MS = 800;
  var SCROLL_MS = 600;
  var DEFAULT_TAIL_MS = 2500;
  var CAMERA_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
  var DEFAULT_ANIMATE_S = 0.6;
  // Named curves for `animate` and `camera`. schema.ts duplicates the NAMES to validate a step
  // before the browser sees it (it cannot import this file); test/constants.test.ts keeps them equal.
  var EASINGS = {
    linear: 'linear',
    easeInCubic: 'cubic-bezier(0.32, 0, 0.67, 0)',
    easeOutCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
    easeInOutCubic: 'cubic-bezier(0.65, 0, 0.35, 1)',
    easeOutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
    easeOutExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
    spring: 'cubic-bezier(0.22, 1.61, 0.36, 1)'
  };
  /** A step's named easing, or `fallback` when it names none (or names one we do not have). */
  function easingOf(step, fallback) {
    return (step && typeof step.ease === 'string' && EASINGS[step.ease]) || fallback;
  }
  var SUBTITLE_HOLD_MS = 4000;

  var ALIASES = { showText: 'fadeIn' };
  var CURSOR_ACTIONS = { click: 1, focus: 1, type: 1, highlight: 1, hover: 1 };
  var TARGET_REQUIRED = { click: 1, focus: 1, type: 1, highlight: 1, hover: 1, scroll: 1, fadeIn: 1, transitionScreen: 1 };

  // --- CSS (ported verbatim from the previous inline engine) ---------------------
  var CURSOR_CSS = {
    mac: `#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 28px; height: 28px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%230F172A" stroke="white" stroke-width="1.5"><path d="M4 2v20l5.83-5.83 3.96 8.5 3.65-1.7-3.96-8.5H22L4 2z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }`,
    windows: `#anim-cli-cursor { position: fixed; top: 0; left: 0; transform: translate(50vw, 120vh); width: 20px; height: 20px; z-index: 99999; pointer-events: none; background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1"><path d="M2 2l20 10-8 2-2 8z"/></svg>') no-repeat; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.3)); transform-origin: top left; transition: transform 0.8s cubic-bezier(0.16, 1, 0.3, 1); }`
  };
  // The chip's font size and wrap width come from the layer as px custom properties set by
  // sizeSubtitleLayer(): viewport units cannot express "a share of the recorded frame" on a
  // scaled recording (measured: 4.2vh paints at 8.4% of the frame under --scale 2). Every other
  // length is in em so the chip keeps its proportions at any size. Placement rules per
  // data-place: the chip is abspos in a full-viewport layer, so "bottom" sits 40px above the
  // frame's bottom edge and so on; reflowSubtitle() picks the attribute to keep the chip off the
  // spotlighted target and the cursor, and :not([data-place]) keeps the never-placed default
  // identical to the old bottom-centred chip.
  //
  // The stadium variant (a reel with subtitles on, see subtitleStyle) is the same chip drawn as a
  // flat capsule: the glass recipe -- 75% charcoal, backdrop blur, hairline border, deep shadow --
  // merges with an app's own dark cards and stacks four decorative systems under the biggest text
  // in the frame. A reel's caption is the voiceover of a muted autoplay clip, so it drops the
  // decoration, goes near-opaque (separation by construction, nothing showing through), takes the
  // stadium radius apps use for badges, and is sized by its own law in sizeSubtitleLayer().
  var SUBTITLE_CSS = `#anim-cli-subtitle-layer { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99998; pointer-events: none; }
.anim-cli-sub-item { position: absolute; box-sizing: content-box; width: max-content; max-width: min(var(--anim-sub-max, 800px), calc(100% - 80px)); background: rgba(20,20,20,0.75); color: white; padding: 0.8em 1.6em; border-radius: 0.6em; font-family: -apple-system, sans-serif; font-size: var(--anim-sub-size, 20px); line-height: 1.4; text-align: center; box-shadow: 0 1em 2em -0.4em rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.015em; backdrop-filter: blur(0.8em); -webkit-backdrop-filter: blur(0.8em); border: 1px solid rgba(255,255,255,0.15); }
.anim-cli-sub-item:not([data-place]), .anim-cli-sub-item[data-place="bottom"] { left: 0; right: 0; margin: 0 auto; bottom: 40px; top: auto; }
.anim-cli-sub-item[data-place="top"] { left: 0; right: 0; margin: 0 auto; top: 40px; bottom: auto; }
.anim-cli-sub-item[data-place="bottom-left"] { left: 40px; right: auto; margin: 0; bottom: 40px; top: auto; }
.anim-cli-sub-item[data-place="bottom-right"] { right: 40px; left: auto; margin: 0; bottom: 40px; top: auto; }
.anim-cli-sub-item[data-place="top-left"] { left: 40px; right: auto; margin: 0; top: 40px; bottom: auto; }
.anim-cli-sub-item[data-place="top-right"] { right: 40px; left: auto; margin: 0; top: 40px; bottom: auto; }
#anim-cli-subtitle-layer.anim-cli-sub-stadium .anim-cli-sub-item { background: rgba(15,18,24,0.92); border: none; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; border-radius: 999em; padding: 0.5em 1.4em; font-weight: 600; letter-spacing: 0.01em; }
@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(0.75em) scale(0.95); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); } 10%, 90% { opacity: 1; transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); } 100% { opacity: 0; transform: translateY(-0.5em) scale(0.95); } }`;
  var EFFECTS_CSS = `#anim-cli-highlight { position: fixed; box-sizing: content-box; border-radius: 10px; border: 2px solid #3B82F6; box-shadow: 0 0 0 4px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.35); pointer-events: none; z-index: 99996; opacity: 0; transition: left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1), width 0.5s cubic-bezier(0.16,1,0.3,1), height 0.5s cubic-bezier(0.16,1,0.3,1); }
#anim-cli-highlight.anim-cli-pulse { animation: anim-cli-highlightPulse 1.3s cubic-bezier(0.16,1,0.3,1) forwards; }
#anim-cli-highlight.anim-cli-hold { opacity: 1; animation: none; }
@keyframes anim-cli-highlightPulse { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
.anim-cli-ripple { position: fixed; box-sizing: content-box; width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; border-radius: 50%; background: rgba(59,130,246,0.35); border: 2px solid rgba(59,130,246,0.65); pointer-events: none; z-index: 99997; animation: anim-cli-rippleAnim 0.6s cubic-bezier(0.16,1,0.3,1) forwards; }
@keyframes anim-cli-rippleAnim { 0% { width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; opacity: 0.9; } 100% { width: 80px; height: 80px; margin-left: -40px; margin-top: -40px; opacity: 0; } }`;
  // The numbered badge is guide-capture furniture, not chrome the viewer sees during playback, so it
  // is installed even when the spotlight and ripple are off.
  var CALLOUT_CSS = `#anim-cli-callout { position: fixed; box-sizing: content-box; width: 32px; height: 32px; border-radius: 50%; background: #3B82F6; color: #fff; font: 600 15px/32px -apple-system, sans-serif; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); pointer-events: none; z-index: 99998; display: none; }`;

  // --- state ----------------------------------------------------------------------
  var state = {
    booted: false,
    ready: false,
    opts: { cursor: 'mac', resetFocusStyles: false, drift: true, loop: false, spotlight: true, ripple: true, subtitles: true, subtitleScale: 1, subtitleStyle: 'glass', autoplay: 'immediate', zoom: 1, timeline: null, durationMs: null, cursorPoint: null },
    cursor: null,
    subtitleLayer: null,
    subtitleEl: null,
    /** Placement pinned by the running cue's step ("subtitlePlace"), or null: while set, reflowSubtitle() does not move the chip. */
    subtitlePin: null,
    subtitleSizer: null,
    /** Layout epoch: bumped whenever page content can have moved (step start, camera settle, resize,
     *  restart). framedContentObstacles() memoizes its scan boxes for the current epoch. */
    framingEpoch: 0,
    framingCache: { epoch: -1, boxes: null },
    point: null,
    t0: null,
    currentScreen: null,
    lastSpot: null,
    snapshot: null,
    snapshotScripts: null,
    snapshotStyle: '',
    cameraOn: false,
    /** Window (page coordinates) the active camera transform leaves inside the viewport, set by
     *  camera() and read by framingReport(); null when no camera move has reframed the page. */
    cameraWindow: null,
    playback: null,
    timers: [],
    intervals: [],
    completions: {},
    holds: {},
    driverTyping: {},
    nextToken: 1
  };

  function onReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }
  /**
   * The overlays live under <html>, which carries `:root { zoom: N }` on a scaled recording, while
   * getBoundingClientRect reports PAINTED pixels. A coordinate read from the page is therefore in a
   * different space from the one it is written into, and applying it unconverted places every
   * overlay at N times its intended position. These two helpers are the only place that conversion
   * happens; everything else keeps working in painted space.
   *
   * Measured rects are divided, position and size alike, so the ring still frames its target. The
   * overlays' own constants (the 6px spotlight pad, the 32px badge, the ripple) are NOT divided:
   * they are authored in CSS px and should paint N times larger in an N-times denser recording,
   * exactly as the page content does.
   */
  function rootZoom() {
    var z = state.opts.zoom;
    return typeof z === 'number' && z > 0 ? z : 1;
  }
  /** Painted point -> overlay space. Returns the input untouched at zoom 1, so the common path is exact. */
  function toOverlayPoint(x, y) {
    var z = rootZoom();
    return z === 1 ? { x: x, y: y } : { x: x / z, y: y / z };
  }
  /** Painted rect -> overlay space (position and size both). Untouched at zoom 1. */
  function toOverlayRect(r) {
    var z = rootZoom();
    if (z === 1) return r;
    return { left: r.left / z, top: r.top / z, width: r.width / z, height: r.height / z };
  }

  function overlayRoot() {
    // A transformed <body> becomes the containing block for its position:fixed descendants,
    // which would double-apply the camera/zoom transform to the cursor/highlight/ripple overlays.
    // Reparent them to <html> (never transformed) so they stay correctly viewport-relative.
    return document.documentElement;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms || 0)); }); }

  /**
   * A timeout that removes itself from state.timers when it fires, so a long driven run (a tour
   * replaying steps, a recording) does not accumulate thousands of spent handles. stop() still
   * clears whatever is pending, and the fire time is exactly what setTimeout alone would give.
   */
  function setAnimTimeout(fn, ms) {
    var id = setTimeout(function () {
      var at = state.timers.indexOf(id);
      if (at >= 0) state.timers.splice(at, 1);
      fn();
    }, ms);
    state.timers.push(id);
    return id;
  }
  function clearAnimInterval(id) {
    clearInterval(id);
    var at = state.intervals.indexOf(id);
    if (at >= 0) state.intervals.splice(at, 1);
  }
  function now() {
    if (state.t0 == null) state.t0 = performance.now();
    return Math.round(performance.now() - state.t0);
  }
  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) { /* ignore */ }
  }
  function parseTime(t) {
    if (typeof t === 'number') return Math.round(t * 1000);
    if (typeof t !== 'string') return NaN;
    var s = t.trim(), m;
    if ((m = /^(-?\d+(?:\.\d+)?)\s*ms$/i.exec(s))) return Math.round(parseFloat(m[1]));
    if ((m = /^(-?\d+(?:\.\d+)?)\s*s?$/i.exec(s))) return Math.round(parseFloat(m[1]) * 1000);
    return NaN;
  }
  function timeMsOf(step) { return typeof step.timeMs === 'number' ? step.timeMs : parseTime(step.time); }
  function rectOf(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  /**
   * The part of `el` a viewer can actually see: its box intersected with every ancestor that hides
   * overflow, on the axis that hides it. The ring's job is to frame what the frame shows, and an
   * element taller than its clipping container would otherwise be ringed well outside the app.
   * `auto`/`scroll` is deliberately left alone: the runtime scrolls a clipped target into view
   * before interacting, so content below the fold of a scrollable pane is reachable and belongs
   * inside the ring.
   */
  function visibleRect(el) {
    var r = el.getBoundingClientRect();
    // Overflow only clips a descendant that sits inside its own containing block. A fixed element's
    // containing block is the viewport, so an overflow:hidden ancestor does not clip it at all:
    // measured, a fixed 300x200 inside a 200x100 hidden pane paints in full, and clamping it would
    // ring a third of the box. An absolutely positioned one is clipped up to its nearest positioned
    // ancestor and no further.
    var pos = getComputedStyle(el).position;
    if (pos === 'fixed') return r;
    var stopAtPositioned = pos === 'absolute';
    var l = r.left, t = r.top, rt = r.right, b = r.bottom;
    var a = el.parentElement;
    while (a && a !== document.documentElement) {
      var cs = getComputedStyle(a);
      var box = null;
      if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') { box = a.getBoundingClientRect(); l = Math.max(l, box.left); rt = Math.min(rt, box.right); }
      if (cs.overflowY === 'hidden' || cs.overflowY === 'clip') { box = box || a.getBoundingClientRect(); t = Math.max(t, box.top); b = Math.min(b, box.bottom); }
      // The containing block itself clips (handled just above); nothing above it does.
      if (stopAtPositioned && cs.position !== 'static') break;
      a = a.parentElement;
    }
    // Nothing survives (a target clipped away entirely): keep the unclamped box rather than
    // collapsing to an invisible or negative-sized ring. `check` reports that case as a warning of
    // its own, and a ring in the wrong place is more debuggable than no ring at all.
    if (rt - l <= 0 || b - t <= 0) return r;
    return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
  }
  /** The box the spotlight actually framed, in painted px (what guide.json reports and crops to). */
  function spotRectOf(el) {
    if (!el) return null;
    var r = visibleRect(el);
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  /** Nearest self-or-ancestor with a non-zero box (an empty <span> has none). */
  function anchorOf(el) {
    var a = el;
    while (a && a !== document.documentElement) {
      var r = a.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return a;
      a = a.parentElement;
    }
    return el;
  }
  /** A readable CSS selector for an element (#id, else tag.class:nth-of-type chain up to an id'd ancestor). */
  function selectorOf(n) {
    var parts = [];
    var cur = n;
    while (cur && cur !== document.documentElement) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      var part = cur.tagName.toLowerCase();
      if (cur.classList.length) part += '.' + Array.prototype.map.call(cur.classList, function (c) { return CSS.escape(c); }).join('.');
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }
  /** Is the element's centre outside the viewport or outside an overflow-clipping ancestor? */
  function isClipped(el) {
    var r = el.getBoundingClientRect();
    var px = r.left + r.width / 2, py = r.top + r.height / 2;
    if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) return true;
    var a = el.parentElement;
    while (a && a !== document.documentElement) {
      var cs = getComputedStyle(a);
      if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        var ar = a.getBoundingClientRect();
        if (px < ar.left || px > ar.right || py < ar.top || py > ar.bottom) return true;
      }
      a = a.parentElement;
    }
    return false;
  }

  /**
   * Compact identity of an element for reports: tag#id, tag.class or the bare tag, plus a short
   * text snippet. Reports are read by an author (often an agent) diffing them against the
   * timeline's intent, so the name and the snippet are what make "this selector resolved to the
   * wrong element" legible as text.
   */
  function describeEl(el) {
    var tag = el.tagName.toLowerCase();
    var name = el.id ? tag + '#' + el.id : (el.classList && el.classList.length ? tag + '.' + el.classList[0] : tag);
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 24) text = text.slice(0, 24) + '…';
    return name + (text ? ' "' + text + '"' : '');
  }

  /**
   * Whether `el` or any ancestor is scaled to nothing: a CSS scale(0) pre-hide anywhere on the
   * chain hides the element as surely as opacity 0, while any other transform (the standard
   * translate(-50%, -50%) centering idiom) hides nothing. Used by check's reveal warning.
   */
  function transformHidden(el) {
    var n = el;
    while (n && n.nodeType === 1) {
      var t = getComputedStyle(n).transform;
      if (t && t !== 'none') {
        try {
          var m = new DOMMatrix(t);
          if (Math.hypot(m.a, m.b) < 0.01 && Math.hypot(m.c, m.d) < 0.01) return true;
        } catch (e) { /* unparsable transform: treat as visible */ }
      }
      if (n === document.documentElement) break;
      n = n.parentElement;
    }
    return false;
  }

  /** Tags that count as nameable content even with no id and no class. */
  var FRAMING_LANDMARKS = 'h1,h2,h3,h4,h5,h6,p,li,button,a,img,svg,canvas,video,table,input,textarea,select,label';

  /**
   * The shared element scan behind framingReport() and the subtitle's camera obstacle: every named
   * (id'd or classed) or landmark element with its painted rect, visibility, whether it paints
   * anything of its own, its viewport intersection and the layout-wrapper flag -- sorted by that
   * intersection, biggest first. `allSet` is the visible, non-layout set the coverage walk uses.
   */
  function framingScan() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var skipTags = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, BR: 1, HR: 1, META: 1, LINK: 1, TITLE: 1 };
    var all = document.body.querySelectorAll('*');
    // On a very large DOM the per-element getComputedStyle pass gets costly; id'd elements and
    // landmark tags still identify the page, so class-named elements are the ones dropped.
    var heavy = all.length > 4000;
    var named = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (skipTags[el.tagName]) continue;
      if (el.id && el.id.indexOf('anim-cli-') === 0) continue;
      var isLandmark = !!(el.matches && el.matches(FRAMING_LANDMARKS));
      var isNamed = !!el.id || (el.classList && el.classList.length > 0);
      if (heavy && !el.id && !isLandmark) continue;
      if (!isNamed && !isLandmark) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      // Visible NOW, through the whole ancestor chain: reel cards legitimately sit at opacity 0
      // until their reveal, and invisible content is not "in frame" even when its box intersects
      // the window. checkVisibility's option names were renamed mid-spec; pass both spellings and
      // let unknown keys fall on the floor.
      var vis = false;
      if (typeof el.checkVisibility === 'function') {
        vis = el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
      } else {
        vis = cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
      }
      // Whether the element paints anything of its own (a background colour or image). A wrapper
      // that paints nothing is layout, not content: on the common mockup shape -- a transparent
      // #app spanning the viewport around the real blocks -- its box would otherwise cover the
      // whole window and content coverage could never drop, deafening the background warning
      // exactly where a push onto an empty corner should trip it. Transparent spelled the modern
      // way (color(srgb ... / 0), oklch(... / 0)) serializes with a slash alpha, hence the second
      // pattern alongside the legacy comma form.
      var bg = cs.backgroundColor;
      var transparentBg = bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg) || /\/\s*0\)$/.test(bg);
      var paints = cs.backgroundImage !== 'none' || !transparentBg;
      var ix = Math.min(r.right, vw) - Math.max(r.left, 0);
      var iy = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      named.push({ el: el, r: r, area: r.width * r.height, inter: Math.max(0, ix) * Math.max(0, iy), paints: paints, vis: vis, layout: false });
    }
    // "Contains named content", visible or not (a reel's cards are named and pre-hidden): one
    // ancestor-marking pass instead of a contains() scan per element.
    var hasNamedDesc = new Map();
    for (var n0 = 0; n0 < named.length; n0++) {
      for (var pa = named[n0].el.parentElement; pa && pa.nodeType === 1; pa = pa.parentElement) {
        if (!hasNamedDesc.has(pa)) hasNamedDesc.set(pa, true);
      }
    }
    // A non-painting wrapper of named content is layout, not content: it is not a list entry, not
    // a coverage contributor and not a slice; its children are measured directly.
    for (var n1 = 0; n1 < named.length; n1++) named[n1].layout = !named[n1].paints && hasNamedDesc.has(named[n1].el);
    // The set the top-level test walks: visible, non-layout elements.
    var allSet = [];
    for (var n2 = 0; n2 < named.length; n2++) if (named[n2].vis && !named[n2].layout) allSet.push(named[n2].el);
    named.sort(function (a, b) { return b.inter - a.inter; });
    return { named: named, allSet: allSet };
  }

  /**
   * The facts a `camera` step leaves the viewer looking at, measured in the settled state: which
   * named elements are in frame and how much of the window they cover, which are cut by its edge,
   * how much of the window is content rather than background, and where the step's own target
   * landed. This is what lets an author notice "the zoom is in the wrong place" without watching
   * the video: compared against the timeline's intent, the report is a text diff. Rects and the
   * window are reported in the page's authored px (painted / rootZoom); coverage fractions are
   * scale-free. Returns null unless a camera step has reframed the page.
   */
  function framingReport(targetSel) {
    if (!state.cameraOn || !state.cameraWindow) return null;
    var z = rootZoom();
    var vw = window.innerWidth, vh = window.innerHeight;
    var vpArea = vw * vh;
    var targetEl = null;
    if (targetSel) { try { targetEl = document.querySelector(targetSel); } catch (e) { targetEl = null; } }
    var scan = framingScan();
    var named = scan.named;
    var allSet = scan.allSet;
    // In-frame list: the largest blocks first, skipping anything nested inside an already-listed
    // element (a card says more than its heading, and both is noise) and layout-only wrappers.
    var inSet = [];
    var inFrame = [];
    for (var j = 0; j < named.length && inFrame.length < 8; j++) {
      if (named[j].inter <= 0) break;
      if (!named[j].vis || named[j].layout) continue;
      var nested = false;
      for (var k = 0; k < inSet.length; k++) if (inSet[k].contains(named[j].el)) { nested = true; break; }
      if (nested) continue;
      inSet.push(named[j].el);
      inFrame.push({ name: describeEl(named[j].el), coverage: Math.round(named[j].inter / vpArea * 100) / 100 });
    }
    // Content coverage: the top-level visible elements' intersections summed, capped at 1.
    // Siblings rarely overlap, so the sum tracks the union closely enough to tell content from
    // background. Layout wrappers contribute nothing themselves -- their children are summed.
    var cover = 0;
    for (var c = 0; c < named.length; c++) {
      var ce = named[c];
      if (ce.inter <= 0 || !ce.vis || ce.layout) continue;
      var topLevel = true;
      for (var p = ce.el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (allSet.indexOf(p) >= 0) { topLevel = false; break; }
      }
      if (topLevel) cover += ce.inter;
    }
    cover = Math.min(1, cover / vpArea);
    // Sliced: named content crossing a viewport edge. The page-spanning canvas and non-painting
    // wrappers are skipped (they are always cut by a push-in and say nothing), so is the step's own
    // target (its visibility is its own line) and its descendants (they share its edges), and so is
    // a child whose ancestor is already listed: one name for one edge is the whole point of the
    // list. The canvas test compares AUTHORED sizes (painted area / scale^2 against the authored
    // viewport), so a deep push-in does not start hiding half-page content as "canvas".
    var s2 = state.cameraWindow.scale * state.cameraWindow.scale;
    var minCut = 8 * z;
    var sliced = [];
    var slicedPicked = [];
    if (targetEl) slicedPicked.push(targetEl);
    for (var m = 0; m < named.length && sliced.length < 5; m++) {
      var it = named[m];
      if (it.inter <= 0 || !it.vis || it.layout) continue;
      if (it.area > vpArea * 2 * s2) continue;
      var nestedCut = false;
      for (var sc = 0; sc < slicedPicked.length; sc++) if (slicedPicked[sc].contains(it.el)) { nestedCut = true; break; }
      if (nestedCut) continue;
      var sides = [['left', -it.r.left], ['right', it.r.right - vw], ['top', -it.r.top], ['bottom', it.r.bottom - vh]];
      var worstSide = null, worstPx = minCut;
      for (var q = 0; q < 4; q++) if (sides[q][1] > worstPx) { worstSide = sides[q][0]; worstPx = sides[q][1]; }
      if (worstSide) {
        slicedPicked.push(it.el);
        sliced.push({ name: describeEl(it.el), by: worstSide + ' ' + Math.round(worstPx / z) + 'px' });
      }
    }
    var target = null;
    if (targetEl) {
      var tr = targetEl.getBoundingClientRect();
      var tix = Math.max(0, Math.min(tr.right, vw) - Math.max(tr.left, 0));
      var tiy = Math.max(0, Math.min(tr.bottom, vh) - Math.max(tr.top, 0));
      var tInter = tix * tiy;
      var tArea = tr.width * tr.height;
      target = {
        selector: targetSel,
        name: describeEl(targetEl),
        rect: { x: Math.round(tr.left / z), y: Math.round(tr.top / z), w: Math.round(tr.width / z), h: Math.round(tr.height / z) },
        visibleFraction: tArea > 0 ? Math.round(tInter / tArea * 100) / 100 : 0,
        windowCoverage: Math.round(tInter / vpArea * 100) / 100
      };
    }
    return {
      scale: Math.round(state.cameraWindow.scale * 100) / 100,
      window: { x: Math.round(state.cameraWindow.x), y: Math.round(state.cameraWindow.y), w: Math.round(state.cameraWindow.w), h: Math.round(state.cameraWindow.h) },
      target: target,
      inFrame: inFrame,
      sliced: sliced,
      contentCoverage: Math.round(cover * 100) / 100
    };
  }

  /**
   * Whether the placed subtitle chip currently covers something it must not (the spotlighted
   * target, the cursor, the content a camera push framed). reflowSubtitle() picks the
   * least-overlapping placement when none is clear, so a collision here means every placement
   * collided -- or that the cue is pinned where it is by "subtitlePlace": the frame is crowded
   * at this moment. Returns null when no chip is showing, else [{ what, areaPx }] worst-first.
   */
  function subtitleCollisions() {
    var el = state.subtitleEl;
    if (!el || !state.opts.subtitles) return null;
    var text = el.textContent || '';
    if (!text.trim()) return null;
    var obstacles = subtitleObstacles();
    var z = rootZoom();
    var l = el.offsetLeft * z, t = el.offsetTop * z;
    var box = { left: l, top: t, right: l + el.offsetWidth * z, bottom: t + el.offsetHeight * z };
    var hits = [];
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      var ow = Math.min(box.right, o.right) - Math.max(box.left, o.left);
      var oh = Math.min(box.bottom, o.bottom) - Math.max(box.top, o.top);
      if (ow > 0 && oh > 0) hits.push({ what: o.what || 'target', areaPx: Math.round(ow * oh) });
    }
    hits.sort(function (a, b) { return b.areaPx - a.areaPx; });
    return hits;
  }

  /**
   * Where the runtime's own furniture sits right now, in the page's authored px: the cursor point,
   * the spotlight box, the placed subtitle chip, and the active camera window. check --trace
   * records one of these per step (interaction and completion), which turns "where did everything
   * move" into data an author can read instead of motion they have to watch. Rects are null when
   * the piece is absent; the camera object only exists under an active camera step.
   */
  function overlayState() {
    var z = rootZoom();
    var out = { cursor: null, spotlight: null, subtitle: null, camera: null };
    if (state.point) out.cursor = { x: Math.round(state.point.x / z), y: Math.round(state.point.y / z) };
    var h = document.getElementById('anim-cli-highlight');
    if (h) {
      var hr = h.getBoundingClientRect();
      if (hr.width > 0 && hr.height > 0) out.spotlight = { x: Math.round(hr.left / z), y: Math.round(hr.top / z), w: Math.round(hr.width / z), h: Math.round(hr.height / z) };
    }
    var chip = state.subtitleEl;
    if (chip && (chip.textContent || '').trim()) {
      out.subtitle = { x: Math.round(chip.offsetLeft), y: Math.round(chip.offsetTop), w: Math.round(chip.offsetWidth), h: Math.round(chip.offsetHeight), place: chip.getAttribute('data-place') || 'bottom' };
    }
    if (state.cameraWindow) {
      out.camera = {
        scale: Math.round(state.cameraWindow.scale * 100) / 100,
        window: { x: Math.round(state.cameraWindow.x), y: Math.round(state.cameraWindow.y), w: Math.round(state.cameraWindow.w), h: Math.round(state.cameraWindow.h) }
      };
    }
    return out;
  }


  // --- boot: styles + overlays ----------------------------------------------------
  // Idempotent: a second boot with a different cursor swaps the cursor CSS.
  function installStyles() {
    var css = '';
    // A scaled recording: the viewport is N times larger and the page is zoomed back down, so the
    // layout box keeps its authored size while every CSS pixel is painted N video pixels wide.
    if (state.opts.zoom && state.opts.zoom !== 1) css += ':root { zoom: ' + state.opts.zoom + '; }\n';
    if (state.opts.cursor && state.opts.cursor !== 'none') css += (CURSOR_CSS[state.opts.cursor] || CURSOR_CSS.mac) + '\n';
    if (state.opts.subtitles) css += SUBTITLE_CSS + '\n';
    if (state.opts.spotlight || state.opts.ripple) css += EFFECTS_CSS + '\n';
    css += CALLOUT_CSS + '\n';
    var style = document.getElementById('anim-cli-runtime-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'anim-cli-runtime-style';
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  /**
   * Sizes the burned-in subtitle as a share of the RECORDED FRAME, not a fixed px: the caption
   * norm is roughly 4% of frame height, and a fixed 20px was under half of that at 1080p (which
   * lands around 7px once a help article shows a 1920px video at a third of its width). Viewport
   * units cannot express that share: on a scaled recording the viewport is N times larger and
   * `:root { zoom: N }` shrinks the layout back, but vw/vh resolve against the SCALED viewport
   * and then paint multiplied by the zoom again -- 4.2vh measured at 8.4% of the frame at
   * --scale 2. So the size is computed here in authored pixels (real viewport / zoom) and set as
   * px; living under the zoomed root it paints N times larger in the N-times-denser frame, the
   * same share of the frame at any scale, exactly like every other authored constant (see the
   * note on toOverlayPoint).
   */
  function sizeSubtitleLayer() {
    var layer = state.subtitleLayer;
    if (!layer) return;
    var z = rootZoom();
    var w = window.innerWidth / z;
    var h = window.innerHeight / z;
    // meta.subtitleScale (default 1) multiplies the automatic size: a design that finds the chip
    // too subtle or too loud tunes it once, at the timeline level, instead of per step. isFinite,
    // not just > 0: an Infinity that slipped past validation would emit "Infinitypx", an invalid
    // var() substitution the chip silently inherits its parent font from.
    var scale = typeof state.opts.subtitleScale === 'number' && Number.isFinite(state.opts.subtitleScale) && state.opts.subtitleScale > 0 ? state.opts.subtitleScale : 1;
    // Landscape: 4.2% of frame height (2.3vw when the frame is wider than 16:9), floored at 20px
    // for small windows, capped at 5vh so an ultrawide frame does not run away. Portrait keys on
    // width (6vw) instead: 4.2% of a tall frame's height is huge relative to its narrow width.
    var portrait = h >= w;
    var font, wrapBase;
    if (state.opts.subtitleStyle === 'stadium') {
      // A reel is watched muted and autoplaying, usually at a fraction of its recording width in a
      // feed or an embed: burned captions there run 5-8% of frame height, and the glass law's 4.2%
      // measured 9.4px on a 400px-wide embed. 5% of height (2.8vw on wider-than-16:9 frames),
      // capped at 6vh; portrait keys on width (7.5vw) for the same reason as the glass law. The
      // wrap is one-line-first (58% of width): a real sentence should sit on one line rather than
      // double the chip's height at the glass chip's 42%.
      font = portrait ? Math.max(20, 0.075 * w) : Math.max(20, 0.028 * w, 0.05 * h);
      font = Math.min(font, Math.max(20, 0.06 * h));
      wrapBase = 0.58 * w;
    } else {
      font = portrait ? Math.max(20, 0.06 * w) : Math.max(20, 0.023 * w, 0.042 * h);
      font = Math.min(font, Math.max(20, 0.05 * h));
      // Wrap room: about 42% of the frame width (the old 800px chip on a 1920 render), widened to
      // the taller dimension's proportion when the frame is portrait-ish.
      wrapBase = Math.max(0.42 * w, 0.75 * h);
    }
    // Never past the layer's own 40px side gutters, and scaled with meta.subtitleScale.
    var max = Math.min(w - 80, wrapBase * scale);
    layer.style.setProperty('--anim-sub-size', (Math.round(font * scale * 100) / 100) + 'px');
    layer.style.setProperty('--anim-sub-max', Math.max(120, Math.round(max)) + 'px');
  }

  /** Rects the subtitle chip must not cover, in PAINTED px: the spotlighted target (the thing the
   *  cue is about, held for the whole cue even after the ring's pulse fades), the cursor, and --
   *  while a camera push-in is showing -- the content that push framed. lastSpot is set at the
   *  START of a step, before the cursor travels, so a reflow on travel already protects the
   *  destination; spotAnchor (set by positionHighlight) is the fallback when a highlight was
   *  placed without a step, and survives until restart(). Each box carries a `what` label for
   *  subtitleCollisions(); reflowSubtitle() only reads the edges. */
  function subtitleObstacles() {
    var out = [];
    var z = rootZoom();
    var spotEl = (state.lastSpot && state.lastSpot.el && state.lastSpot.el.isConnected)
      ? state.lastSpot.el
      : (state.spotAnchor && state.spotAnchor.isConnected ? state.spotAnchor : null);
    if (spotEl) {
      var r = visibleRect(spotEl);
      var pad = 16 * z;
      if (r.width > 0 && r.height > 0) out.push({ what: 'spotlight target', left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad });
    }
    if (state.cursor && state.point) {
      // The cursor sprite is 28px at its tip's top-left plus a shadow; give it air on all sides.
      var grow = 14 * z;
      out.push({ what: 'cursor', left: state.point.x - grow, top: state.point.y - grow, right: state.point.x + 42 * z, bottom: state.point.y + 46 * z });
    }
    var framed = framedContentObstacles();
    if (framed.length) out = out.concat(framed);
    return out;
  }

  /**
   * While a camera push-in (scale > 1) is showing, the content it framed joins the obstacle list.
   * The push exists to put that content on screen, and the camera step's own target ends up
   * centred -- safe by construction -- while everything around it slides toward the frame edges,
   * straight under the chip's bottom home (measured on a real reel: a 1.25x push delivered its
   * checklist rows into the chip's band). Same selection framingReport calls "in frame": visible,
   * non-layout, top-level content boxes, clipped to the viewport and padded like the spotlight
   * obstacle. A pull-back (scale ~1) shows the whole page again -- the ordinary no-camera case
   * the two classic obstacles already cover -- so it adds nothing. Capped at 12 boxes; a framed
   * region is rarely more than a handful of cards.
   */
  function framedContentObstacles() {
    if (!state.cameraOn || !state.cameraWindow || !(state.cameraWindow.scale > 1.001)) return [];
    // One full-document scan per layout epoch, not per reflow: the dodge rechecks on every cursor
    // travel and highlight while a push-in is held, and the scan (querySelectorAll('*') plus a
    // computed-style pass per named element) would otherwise force a synchronous layout pass
    // several times per step inside a real-time recording, where a hitch drops frames. Content
    // only moves when the page does -- a camera settle, a resize, a restart, or the start of
    // another step -- and each of those bumps state.framingEpoch; the mid-hold rechecks that
    // matter (cursor, highlight) do not, and reuse the same boxes.
    if (state.framingCache.epoch === state.framingEpoch && state.framingCache.boxes) return state.framingCache.boxes;
    var vw = window.innerWidth, vh = window.innerHeight;
    var pad = 16 * rootZoom();
    var scan = framingScan();
    var picked = [];
    var out = [];
    for (var i = 0; i < scan.named.length && out.length < 12; i++) {
      var it = scan.named[i];
      if (it.inter <= 0 || !it.vis || it.layout) continue;
      var nested = false;
      for (var k = 0; k < picked.length; k++) if (picked[k].contains(it.el)) { nested = true; break; }
      if (nested) continue;
      picked.push(it.el);
      out.push({ what: 'framed content', left: Math.max(0, it.r.left) - pad, top: Math.max(0, it.r.top) - pad, right: Math.min(vw, it.r.right) + pad, bottom: Math.min(vh, it.r.bottom) + pad });
    }
    state.framingCache = { epoch: state.framingEpoch, boxes: out };
    return out;
  }

  var SUB_PLACES = ['bottom', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right'];
  /**
   * Keeps the chip off the obstacles. A fresh cue is evaluated from the home position ("bottom");
   * a mid-hold recheck (a highlight or a cursor move landing on the chip) keeps where the chip
   * already is whenever that is clear, so a held caption does not wander between placements.
   * When every placement overlaps something, the smallest overlap wins -- least bad, and still
   * deterministic. Chip and obstacles are both measured painted, which stays correct under root
   * zoom because everything scales together.
   */
  function reflowSubtitle(fresh) {
    var el = state.subtitleEl;
    if (!el || !state.opts.subtitles) return;
    // A pinned cue stays where its step put it, mid-hold rechecks included: the pin is the author
    // overriding the dodge on purpose. subtitleCollisions() still reports what the pin covers, so
    // check can warn about a bad one.
    if (state.subtitlePin) { el.setAttribute('data-place', state.subtitlePin); return; }
    var obstacles = subtitleObstacles();
    var current = el.getAttribute('data-place') || 'bottom';
    var order = fresh ? SUB_PLACES.slice() : [current].concat(SUB_PLACES.filter(function (p) { return p !== current; }));
    var z = rootZoom();
    var best = null, bestOverlap = Infinity;
    for (var i = 0; i < order.length; i++) {
      el.setAttribute('data-place', order[i]);
      // Measured through offset* on purpose: getBoundingClientRect reports the VISUAL box, which
      // mid-fade carries the entry animation's translateY/scale (a ~0.75em bias exactly when a
      // fresh cue is placed), while offset* are layout geometry the animation never touches. The
      // chip's offsetParent is the fixed layer at the viewport origin, so offsets x rootZoom()
      // are the settled painted rect.
      var l = el.offsetLeft * z, t = el.offsetTop * z;
      var r = { left: l, top: t, right: l + el.offsetWidth * z, bottom: t + el.offsetHeight * z };
      var overlap = 0;
      for (var j = 0; j < obstacles.length; j++) {
        var o = obstacles[j];
        var ow = Math.min(r.right, o.right) - Math.max(r.left, o.left);
        var oh = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top);
        if (ow > 0 && oh > 0) overlap += ow * oh;
      }
      if (overlap === 0) { best = order[i]; break; }
      if (overlap < bestOverlap) { bestOverlap = overlap; best = order[i]; }
    }
    el.setAttribute('data-place', best);
  }

  // Idempotent: creates missing overlays, removes the cursor when cursor is 'none'.
  function createOverlays() {
    var root = overlayRoot();
    var cursor = document.getElementById('anim-cli-cursor');
    if (state.opts.cursor && state.opts.cursor !== 'none') {
      if (!cursor) { cursor = document.createElement('div'); cursor.id = 'anim-cli-cursor'; }
      if (cursor.parentNode !== root) root.appendChild(cursor);
      state.cursor = cursor;
    } else {
      if (cursor) cursor.remove();
      state.cursor = null;
    }
    var layer = document.getElementById('anim-cli-subtitle-layer');
    if (!layer) { layer = document.createElement('div'); layer.id = 'anim-cli-subtitle-layer'; }
    if (layer.parentNode !== root) root.appendChild(layer);
    layer.className = state.opts.subtitleStyle === 'stadium' ? 'anim-cli-sub-stadium' : '';
    state.subtitleLayer = layer;
    sizeSubtitleLayer();
    if (!state.subtitleSizer) {
      // animated.html: keep the chip proportional AND clear of the target/cursor when the viewer
      // resizes the window -- both the chip's box and the obstacle rects move with the window.
      state.subtitleSizer = function () { state.framingEpoch++; sizeSubtitleLayer(); reflowSubtitle(false); };
      window.addEventListener('resize', state.subtitleSizer);
    }
  }

  function applyDrift() {
    var stage = document.body;
    if (state.opts.drift === false) return;
    stage.style.transformOrigin = 'center center';
    stage.style.transition = 'transform 16s cubic-bezier(0.16, 1, 0.3, 1)';
    stage.style.transform = 'scale(1.025)';
  }

  function boot(opts) {
    opts = opts || {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) state.opts[k] = opts[k];
    onReady(function () {
      installStyles();
      createOverlays();
      if (!state.booted) {
        state.booted = true;
        document.body.style.transformOrigin = 'center center';
        applyDrift();
      }
      if (state.opts.cursorPoint && state.cursor) placeCursor(state.opts.cursorPoint.x, state.opts.cursorPoint.y);
      state.ready = true;
      dispatch('anim:ready', { driven: !!window.__ANIM_DRIVEN });
      var tl = state.opts.timeline;
      var steps = tl && (Array.isArray(tl) ? tl : tl.steps);
      // No steps (e.g. `animate --loop` without a config): nothing to play, and no loop.
      if (steps && steps.length && !window.__ANIM_DRIVEN) {
        // Taken before the first step runs, so the clone is the authored page.
        snapshot();
        startPlayback(tl);
      }
    });
    return api;
  }

  // --- primitives -----------------------------------------------------------------
  function placeCursor(x, y) {
    if (!state.cursor) return;
    var p = toOverlayPoint(x, y);
    state.cursor.style.transition = 'none';
    state.cursor.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px)';
    void state.cursor.offsetWidth;
    // state.point stays in painted space: it is the canonical coordinate the driver reports and the
    // next step measures against.
    state.point = { x: x, y: y };
    reflowSubtitle(false);
  }
  function moveCursor(x, y, ms, easing) {
    if (!state.cursor) return;
    if (!ms || ms <= 0) { placeCursor(x, y); return; }
    var p = toOverlayPoint(x, y);
    state.cursor.style.transition = 'transform ' + ms + 'ms ' + (easing || 'cubic-bezier(0.16, 1, 0.3, 1)');
    state.cursor.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px)';
    state.point = { x: x, y: y };
    // The destination is known the moment travel starts: a chip that would sit under it moves
    // before the cursor arrives, not after it has been covering the pointer for a beat.
    reflowSubtitle(false);
  }
  /**
   * Remember where the cursor came to rest as an element plus a fraction of its box, so a camera
   * move can carry the cursor with the page (the cursor is position:fixed in the overlay layer, so
   * a transform on <body> would otherwise slide the page out from under it). Fractions, not pixels:
   * the element's box is scaled by the camera.
   */
  function setCursorAnchor(el, spotEl, point) {
    var host = el;
    var r = el.getBoundingClientRect();
    var outside = !r.width || !r.height || point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom;
    if (outside && spotEl && spotEl !== el) { host = spotEl; r = spotEl.getBoundingClientRect(); }
    state.cursorAnchor = (r.width && r.height)
      ? { el: host, fx: (point.x - r.left) / r.width, fy: (point.y - r.top) / r.height }
      : { el: host, fx: 0.5, fy: 0.5 };
  }
  function pressCursor(x, y, ms) {
    if (!state.cursor) return;
    var p = toOverlayPoint(x, y);
    state.cursor.style.transition = 'transform ' + Math.max(0, ms) + 'ms ease';
    state.cursor.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px) scale(0.85)';
  }
  function releaseCursor(x, y) {
    if (!state.cursor) return;
    var p = toOverlayPoint(x, y);
    state.cursor.style.transition = 'transform 150ms ease';
    state.cursor.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px) scale(1)';
  }

  function ripple(x, y) {
    if (!state.opts.ripple) return;
    var p = toOverlayPoint(x, y);
    var r = document.createElement('div');
    r.className = 'anim-cli-ripple';
    r.style.left = p.x + 'px';
    r.style.top = p.y + 'px';
    overlayRoot().appendChild(r);
    setTimeout(function () { r.remove(); }, 700);
  }

  function getHighlightBox() {
    var h = document.getElementById('anim-cli-highlight');
    if (!h) {
      h = document.createElement('div');
      h.id = 'anim-cli-highlight';
      overlayRoot().appendChild(h);
    }
    return h;
  }

  /** Move the spotlight box onto `el`; `snap` skips the 0.5s position transition (guide marks). */
  function positionHighlight(el, snap) {
    var rect = toOverlayRect(visibleRect(el));
    var h = getHighlightBox();
    // The ring is position:fixed like the cursor, so a camera move has to carry it too.
    state.spotAnchor = el;
    if (snap) h.style.transition = 'none';
    h.style.left = (rect.left - 6) + 'px';
    h.style.top = (rect.top - 6) + 'px';
    h.style.width = (rect.width + 12) + 'px';
    h.style.height = (rect.height + 12) + 'px';
    if (snap) { void h.offsetWidth; h.style.transition = ''; }
    return h;
  }

  function highlight(el) {
    if (!state.opts.spotlight) return;
    if (!el) return;
    var h = positionHighlight(el);
    h.classList.remove('anim-cli-hold');
    h.classList.remove('anim-cli-pulse');
    void h.offsetWidth;
    h.classList.add('anim-cli-pulse');
    // A highlight landing on a held chip (this step has no subtitle of its own) must push it away.
    reflowSubtitle(false);
  }
  /** Keep the spotlight on `el` until releaseHighlight() (used for guide screenshots). */
  function holdHighlight(el) {
    if (!el) return;
    // A held mark is a static frame element: it snaps into place, no transition to be caught mid-flight.
    var h = positionHighlight(el, true);
    h.classList.remove('anim-cli-pulse');
    h.classList.add('anim-cli-hold');
    reflowSubtitle(false);
  }
  /**
   * Carry the spotlight (and the badge, when a guide capture is holding one) to `rect` over `ms`,
   * on the camera's curve. The default 0.5s position transition is restored once it lands, so an
   * ordinary step-to-step move keeps its own timing.
   */
  function glideHighlight(rect, ms, easing) {
    var h = document.getElementById('anim-cli-highlight');
    if (!h) return;
    var curve = easing || CAMERA_EASING;
    var ease = function (p) { return p + ' ' + ms + 'ms ' + curve; };
    var box = toOverlayRect(rect);
    h.style.transition = ms > 0 ? [ease('left'), ease('top'), ease('width'), ease('height')].join(', ') : 'none';
    h.style.left = (box.left - 6) + 'px';
    h.style.top = (box.top - 6) + 'px';
    h.style.width = (box.width + 12) + 'px';
    h.style.height = (box.height + 12) + 'px';
    var c = document.getElementById('anim-cli-callout');
    var badgeShowing = c && c.style.display === 'block';
    if (badgeShowing) {
      var pos = toOverlayPoint(calloutPosition(rect).x, calloutPosition(rect).y);
      c.style.transition = ms > 0 ? [ease('left'), ease('top')].join(', ') : 'none';
      c.style.left = pos.x + 'px';
      c.style.top = pos.y + 'px';
    }
    if (ms > 0) {
      setAnimTimeout(function () {
        h.style.transition = '';
        if (c) c.style.transition = '';
      }, ms + 50);
    } else {
      h.style.transition = '';
      if (c) c.style.transition = '';
    }
  }

  function releaseHighlight() {
    var h = document.getElementById('anim-cli-highlight');
    if (h) { h.classList.remove('anim-cli-hold'); h.classList.remove('anim-cli-pulse'); }
  }

  var CALLOUT_SIZE = 32;
  /** Badge position: centred on the highlight box's top-left corner, clamped into the viewport
   *  (moved inside the box when there is no room outside). Returns the clamped CSS px position. */
  function calloutPosition(rect) {
    var x = rect.left - 6 - CALLOUT_SIZE / 2;
    var y = rect.top - 6 - CALLOUT_SIZE / 2;
    if (x < 0) x = Math.max(0, rect.left + 4);
    if (y < 0) y = Math.max(0, rect.top + 4);
    if (x + CALLOUT_SIZE > window.innerWidth) x = Math.max(0, window.innerWidth - CALLOUT_SIZE);
    if (y + CALLOUT_SIZE > window.innerHeight) y = Math.max(0, window.innerHeight - CALLOUT_SIZE);
    return { x: Math.round(x), y: Math.round(y) };
  }
  function showCallout(n, el) {
    var c = document.getElementById('anim-cli-callout');
    if (!c) { c = document.createElement('div'); c.id = 'anim-cli-callout'; overlayRoot().appendChild(c); }
    // Clamped against the viewport in painted space, then converted once for the style. The value
    // returned stays painted: guide.json and the screenshot crop both work in that space.
    var pos = calloutPosition(visibleRect(el));
    var placed = toOverlayPoint(pos.x, pos.y);
    c.textContent = String(n);
    c.style.left = placed.x + 'px';
    c.style.top = placed.y + 'px';
    c.style.display = 'block';
    return { number: n, x: pos.x, y: pos.y };
  }
  function hideCallout() {
    var c = document.getElementById('anim-cli-callout');
    if (c) c.style.display = 'none';
  }

  /**
   * Guide capture session (all DOM, no image processing):
   *   beginCapture({hideCursor}) hides the subtitle bar (and optionally the cursor) for EVERY guide
   *   frame; markStep({target, number}) additionally holds the spotlight on the box runStep used for
   *   that target (the sized ancestor chosen at arrival, so the frame, rect and crop agree even
   *   after typing gave a 0x0 span a size) and shows the numbered badge; endCapture() undoes both.
   */
  function beginCapture(o) {
    o = o || {};
    if (state.subtitleLayer) state.subtitleLayer.style.visibility = 'hidden';
    if (o.hideCursor && state.cursor) state.cursor.style.visibility = 'hidden';
  }
  /**
   * Guide capture furniture, deliberately independent of playback chrome: a numbered step shows what
   * it points at even when the step opted out of the spotlight during playback (`spotlight: false`)
   * or the whole profile turned it off. The two are different concerns -- one is what a viewer sees
   * moving, the other is what a reader sees in a still.
   */
  function markStep(o) {
    o = o || {};
    var el = o.target === 'body' ? document.body : (o.target ? document.querySelector(o.target) : null);
    if (!el) return null;
    var spot = (state.lastSpot && state.lastSpot.target === o.target && state.lastSpot.el.isConnected) ? state.lastSpot.el : anchorOf(el);
    holdHighlight(spot);
    var callout = o.number != null ? showCallout(o.number, spot) : null;
    return { rect: spotRectOf(spot), targetRect: spot !== el ? rectOf(el) : undefined, callout: callout };
  }
  function endCapture() {
    releaseHighlight();
    hideCallout();
    if (state.subtitleLayer) state.subtitleLayer.style.visibility = '';
    if (state.cursor) state.cursor.style.visibility = '';
  }
  /** Resolves after n animation frames (lets held marks paint before a screenshot). */
  function nextFrames(n) {
    return new Promise(function (resolve) {
      var left = Math.max(1, n || 1);
      (function tick() { requestAnimationFrame(function () { if (--left <= 0) resolve(); else tick(); }); })();
    });
  }

  function resetFocusStyles() {
    document.querySelectorAll('.input, button').forEach(function (n) {
      n.style.borderColor = '#E2E8F0';
      n.style.boxShadow = 'none';
      n.style.background = (n.tagName === 'BUTTON' && n.classList.contains('btn-primary')) ? '#3B82F6' : '#FAFAFA';
    });
  }
  function focusStyle(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.style.borderColor = '#3B82F6';
      el.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
      el.style.background = '#FFF';
    }
  }

  function isField(el) { return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'; }
  // Input types a keyboard can actually fill character by character. A date/time/color/range/file
  // input ignores typed text (its value has to be assigned), and a disabled or readonly field never
  // receives the keystrokes at all: those keep the in-page typist, which is correct for frameworks
  // too now that setTyped goes through the native setter.
  var KEYBOARD_INPUT_TYPES = { text: 1, search: 1, url: 1, tel: 1, email: 1, password: 1, number: 1 };
  function isKeyboardTypable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return KEYBOARD_INPUT_TYPES[String(el.type || 'text').toLowerCase()] === 1;
    // The editable host itself, not a caret span that merely inherits editability from an ancestor.
    return el.contentEditable === 'true' || el.contentEditable === 'plaintext-only';
  }
  function typedTextOf(el) { return isField(el) ? String(el.value) : String(el.textContent); }
  // Always assign the whole prefix: `innerText += ' '` loses the trailing space (innerText reads
  // back collapsed whitespace), so typing "a b" char by char would render as "ab".
  // React & co. keep a value tracker on the node and ignore an `input` event whose value matches what
  // the tracker last saw. `el.value = text` runs the tracker's own setter, so it records the new value
  // and the framework never sees a change (a controlled input stays empty, its submit button disabled).
  // Assigning through the prototype's native setter leaves the tracker stale, so the event lands.
  function nativeSetValue(el, text) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
    var desc = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
  }
  function setTyped(el, text) {
    if (isField(el)) nativeSetValue(el, text); else el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // `onProgress` (every 5 chars and at the end) lets the caller re-position the spotlight as the content grows.
  function typeInto(el, value, cps, instant, onProgress) {
    value = value == null ? '' : String(value);
    setTyped(el, '');
    if (instant) {
      setTyped(el, value);
      if (onProgress) onProgress(value.length);
      return Promise.resolve();
    }
    var interval = 1000 / (cps > 0 ? cps : (state.opts.defaultCps || DEFAULT_CPS));
    return new Promise(function (resolve) {
      var i = 0;
      function tick() {
        if (i < value.length) {
          i++;
          setTyped(el, value.slice(0, i));
          if (onProgress && (i % 5 === 0 || i === value.length)) onProgress(i);
        } else {
          clearAnimInterval(intId);
          resolve();
        }
      }
      tick(); // first character lands exactly at the interaction moment
      var intId = setInterval(tick, interval);
      state.intervals.push(intId);
      if (value.length <= 1) { clearAnimInterval(intId); resolve(); }
    });
  }

  function camera(step, instant) {
    var stage = document.body;
    var x = step.x != null ? step.x : '0px';
    var y = step.y != null ? step.y : '0px';
    // A bare number here would produce an invalid unitless translate() and drop the whole transform.
    if (typeof x === 'number') x = x + 'px';
    if (typeof y === 'number') y = y + 'px';
    // xOffset/yOffset nudge the framing once its centre is solved -- the target's centre, an
    // authored x/y point, or the resting centre of a bare push: the focus point moves right/down
    // by the offset, matching the cursor-point offsets of the same name on click/type steps. The
    // centre moving by +d means d comes OFF the translate, so it is applied to the solved values
    // and composes with every way a centre can be chosen. Authored units, like x/y themselves.
    var dx = step.xOffset != null ? (parseFloat(step.xOffset) || 0) : 0;
    var dy = step.yOffset != null ? (parseFloat(step.yOffset) || 0) : 0;
    var scale = step.scale || 1;
    if (step.target) {
      var el = document.querySelector(step.target);
      if (el) {
        // Measure with the body transform removed so consecutive camera moves never compound:
        // the target's untransformed position is what `scale() translate()` is computed from.
        var current = getComputedStyle(stage).transform;
        var prevTransition = stage.style.transition;
        stage.style.transition = 'none';
        stage.style.transform = 'none';
        var r = el.getBoundingClientRect();
        // The body's own box in the same (untransformed) state: the transform origin is its
        // centre, and the translate below has to account for where that centre actually is.
        var bb = stage.getBoundingClientRect();
        stage.style.transform = current === 'none' ? '' : current;
        void stage.offsetWidth;
        stage.style.transition = prevTransition;
        // getBoundingClientRect and innerWidth are PAINTED pixels, but this translate is applied to
        // <body>, inside `:root { zoom: N }`, where one local px paints N. Without the division the
        // pan is multiplied by the zoom a second time: at N=2 the page overshoots by exactly the pan
        // distance, so a centred target still lands correctly (zero pan) while an off-centre one is
        // thrown across the frame. Only the translate converts; the scale factor is dimensionless,
        // and an authored step.x/step.y is already in the page's own units.
        var z = rootZoom();
        // `transform-origin: center center` is the centre of the BODY box, which is the viewport's
        // centre only when the two coincide. The old shortcut (translate = viewportCentre - target)
        // silently assumed they do: on a mockup wider or taller than the viewport -- a wide
        // dashboard, a page longer than the frame -- a zoom onto a target sitting at the viewport's
        // centre still landed off it, by (bodyCentre - viewportCentre) * (1 - scale). This is the
        // exact inverse map instead: the translate that puts the target's centre on the viewport's
        // centre under scale(S) about the body box's centre. At scale 1 it collapses to the same
        // plain pan as before, so pans and pull-backs are unchanged.
        var vx = window.innerWidth / 2 / z, vy = window.innerHeight / 2 / z;
        var bx = (bb.left + bb.width / 2) / z, by = (bb.top + bb.height / 2) / z;
        var px = (r.left + r.width / 2) / z, py = (r.top + r.height / 2) / z;
        x = ((vx - bx) / scale + bx - px) + 'px';
        y = ((vy - by) / scale + by - py) + 'px';
      }
    }
    // xOffset/yOffset as their own translate term: authored x/y values pass through verbatim
    // (a unit-bearing "50%" stays meaningful), and the nudge composes after them instead of being
    // parseFloat'd into the solved numbers.
    var dur = instant ? 0 : (step.duration != null ? step.duration : DEFAULT_CAMERA_S);
    var finalTransform = 'scale(' + scale + ') translate(' + x + ', ' + y + ')'
      + ((dx || dy) ? ' translate(' + (-dx) + 'px, ' + (-dy) + 'px)' : '');
    stage.style.transformOrigin = 'center center';

    // Where the overlays' anchor elements end up under the final transform: measured by applying it
    // with transitions off, not computed, so transform-origin, a body box that is not the viewport
    // and compounding camera moves are all handled by the browser. Cursor, spotlight and badge are
    // all fixed-position overlays outside the transformed stage, so all three have to be carried.
    // The same dance yields the window the transform leaves inside the viewport (state.cameraWindow,
    // read by framingReport): a uniform scale about any origin maps the body box linearly onto its
    // transformed box, so the viewport rect maps straight back through the two measured boxes --
    // measured rather than re-derived for exactly the reasons above.
    var cursorTo = null;
    var spotTo = null;
    var anchor = state.cursorAnchor;
    var spot = state.spotAnchor;
    var moveCursorToo = !!(state.cursor && anchor && anchor.el && anchor.el.isConnected);
    var moveSpotToo = !!(spot && spot.isConnected && document.getElementById('anim-cli-highlight'));
    {
      var beforeTransform = stage.style.transform;
      var beforeTransition = stage.style.transition;
      stage.style.transition = 'none';
      stage.style.transform = finalTransform;
      void stage.offsetWidth;
      var tBox = stage.getBoundingClientRect();
      if (moveCursorToo) {
        var ar = anchor.el.getBoundingClientRect();
        cursorTo = { x: ar.left + anchor.fx * ar.width, y: ar.top + anchor.fy * ar.height };
      }
      if (moveSpotToo) spotTo = visibleRect(spot);
      stage.style.transform = 'none';
      void stage.offsetWidth;
      var uBox = stage.getBoundingClientRect();
      stage.style.transform = beforeTransform;
      void stage.offsetWidth;
      stage.style.transition = beforeTransition;
      // The uniform scale comes from the width ratio; the height may be 0 on a body that holds
      // only absolutely-positioned content, and the map is still exact from the box anchors.
      if (tBox.width > 0 && uBox.width > 0) {
        var s = tBox.width / uBox.width;
        var zw = rootZoom();
        var wl = uBox.left + (0 - tBox.left) / s;
        var wt = uBox.top + (0 - tBox.top) / s;
        var wr = uBox.left + (window.innerWidth - tBox.left) / s;
        var wb = uBox.top + (window.innerHeight - tBox.top) / s;
        state.cameraWindow = { x: wl / zw, y: wt / zw, w: (wr - wl) / zw, h: (wb - wt) / zw, scale: s };
      } else {
        state.cameraWindow = null;
      }
    }
    // The settled transform is a new layout epoch for the framed-content obstacles (this bump also
    // matters mid-pass: the step started the move, the settle finishes it).
    state.framingEpoch++;

    var cameraEase = easingOf(step, CAMERA_EASING);
    state.cameraOn = true;
    stage.style.transition = dur > 0 ? 'transform ' + dur + 's ' + cameraEase : 'none';
    stage.style.transform = finalTransform;
    if (dur === 0) void stage.offsetWidth;
    // Cursor and spotlight ride the same curve for the same time, so both stay on their element
    // throughout the move instead of being left behind over empty background.
    if (cursorTo) moveCursor(cursorTo.x, cursorTo.y, dur * 1000, cameraEase);
    if (spotTo) glideHighlight(spotTo, dur * 1000, cameraEase);
    // Once the pan has settled, the carried cursor/spot have their final rects: recheck the chip
    // against where they actually landed (the framing centre moves under a push-in, so the
    // placement taken at the step's start can be stale by the end of it). Registered through
    // setAnimTimeout so stop()/restart() cancels it with every other pending callback instead of
    // it firing at a page that no longer plays.
    if (dur > 0) setAnimTimeout(function () { reflowSubtitle(false); }, dur * 1000);
    else reflowSubtitle(false);
    return wait(dur * 1000);
  }

  var TRANSFORM_KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate'];

  /** A CSS length from a number (px) or a string that already carries its unit. */
  function lengthOf(v) {
    return typeof v === 'number' ? v + 'px' : String(v);
  }

  /**
   * One keyframe from an authored {opacity, x, y, scale, rotate, ...} block. The transform keys
   * compose into a single transform in a fixed order -- translate, scale, rotate -- so a step that
   * mixes them is well defined; every other key is passed through as a raw CSS property.
   */
  function keyframeOf(spec) {
    var kf = {};
    if (!spec) return kf;
    var parts = [];
    if (spec.x != null || spec.y != null) parts.push('translate(' + lengthOf(spec.x == null ? 0 : spec.x) + ', ' + lengthOf(spec.y == null ? 0 : spec.y) + ')');
    if (spec.scale != null) parts.push('scale(' + spec.scale + ')');
    else if (spec.scaleX != null || spec.scaleY != null) parts.push('scale(' + (spec.scaleX == null ? 1 : spec.scaleX) + ', ' + (spec.scaleY == null ? 1 : spec.scaleY) + ')');
    if (spec.rotate != null) parts.push('rotate(' + (typeof spec.rotate === 'number' ? spec.rotate + 'deg' : spec.rotate) + ')');
    if (parts.length) kf.transform = parts.join(' ');
    for (var k in spec) {
      if (!Object.prototype.hasOwnProperty.call(spec, k)) continue;
      if (TRANSFORM_KEYS.indexOf(k) >= 0) continue;
      kf[k] = spec[k];
    }
    return kf;
  }

  /**
   * `animate`: the Web Animations API rather than CSS transitions, so `whenSettled()` (which awaits
   * document.getAnimations()) settles guide and preview frames without any extra bookkeeping.
   * `fill: 'both'` holds the end state after the clip has played.
   */
  function animateStep(step, instant) {
    var nodes = [];
    if (step.all) {
      var all = document.querySelectorAll(step.target);
      for (var i = 0; i < all.length; i++) nodes.push(all[i]);
    } else {
      var one = document.querySelector(step.target);
      if (one) nodes.push(one);
    }
    if (!nodes.length) return Promise.resolve();
    var durationMs = instant ? 0 : Math.round((typeof step.duration === 'number' ? step.duration : DEFAULT_ANIMATE_S) * 1000);
    var staggerMs = instant || typeof step.stagger !== 'number' || step.stagger <= 0 ? 0 : Math.round(step.stagger * 1000);
    var easing = easingOf(step, EASINGS.easeOutCubic);
    var frames = [keyframeOf(step.from), keyframeOf(step.to)];
    var running = [];
    for (var n = 0; n < nodes.length; n++) {
      var anim = nodes[n].animate(frames, { duration: durationMs, easing: easing, delay: n * staggerMs, fill: 'both' });
      // Under check/preview every element lands on its end state at once, so a frame shows the result.
      if (instant) anim.finish();
      else running.push(anim.finished.catch(function () {}));
    }
    if (!running.length) return Promise.resolve();
    return Promise.all(running).then(function () {});
  }

  function scrollTo(el, instant) {
    el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
    return wait(instant ? 0 : SCROLL_MS);
  }

  function isVisible(el) {
    var cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  // `durationMs` (from a step's `duration`, seconds) overrides the element's own transition;
  // without it an element that transitions its own opacity (e.g. `transition: all 3s`) keeps it.
  function fadeIn(el, instant, durationMs) {
    var explicit = typeof durationMs === 'number' && durationMs >= 0;
    var ms = instant ? 0 : (explicit ? durationMs : FADE_MS);
    var cs = getComputedStyle(el);
    var props = (cs.transitionProperty || '').split(',').map(function (s) { return s.trim(); });
    var durs = (cs.transitionDuration || '').split(',').map(function (s) { return parseFloat(s) || 0; });
    var ownOpacityMs = 0;
    if (!explicit) {
      props.forEach(function (p, i) {
        if (p === 'opacity' || p === 'all') ownOpacityMs = Math.max(ownOpacityMs, (durs[i] != null ? durs[i] : durs[0]) * 1000);
      });
    }
    var inlineTransition = el.style.transition;
    if (cs.display === 'none') {
      el.style.display = el.getAttribute('data-anim-display') || '';
      if (getComputedStyle(el).display === 'none') el.style.display = 'block';
      el.style.opacity = '0';
      void el.offsetWidth;
    } else if (parseFloat(cs.opacity) >= 1) {
      el.style.transition = 'none';
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = inlineTransition;
    }
    if (!ownOpacityMs && ms > 0) {
      // Add an opacity transition without dropping an existing inline one (e.g. the body's camera transform).
      el.style.transition = (inlineTransition ? inlineTransition + ', ' : '') + 'opacity ' + ms + 'ms ease';
    } else if (explicit && ms === 0) {
      el.style.transition = 'none';
    }
    el.style.opacity = '1';
    return wait(instant ? 0 : Math.max(ms, ownOpacityMs));
  }
  function transitionScreen(el, instant, durationMs) {
    var explicit = typeof durationMs === 'number' && durationMs >= 0;
    var ms = instant ? 0 : (explicit ? durationMs : FADE_MS);
    var prev = [];
    if (state.currentScreen && state.currentScreen !== el) prev = [state.currentScreen];
    else if (el.parentElement) {
      prev = Array.prototype.filter.call(el.parentElement.children, function (c) {
        return c !== el && !(c.id && c.id.indexOf('anim-cli') === 0) && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE' && isVisible(c);
      });
    }
    prev.forEach(function (p) {
      p.style.transition = 'opacity ' + Math.round(ms / 2) + 'ms ease';
      p.style.opacity = '0';
      setTimeout(function () { p.style.display = 'none'; }, Math.round(ms / 2));
    });
    state.currentScreen = el;
    return wait(Math.round(ms / 2)).then(function () { return fadeIn(el, instant, explicit ? ms : undefined); });
  }
  function stepDurationMs(step) {
    return typeof step.duration === 'number' && step.duration >= 0 ? Math.round(step.duration * 1000) : undefined;
  }

  function showSubtitle(text, ms, place) {
    if (!state.opts.subtitles) return;
    if (!state.subtitleLayer) return;
    var el = state.subtitleEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'anim-cli-sub-item';
      state.subtitleLayer.appendChild(el);
      state.subtitleEl = el;
    }
    // A step's "subtitlePlace" pins its cue for as long as it runs: the author knows the
    // composition (a camera push framing low content) and takes the cue out of the automatic
    // dodge. An unknown value is ignored -- schema validated it -- leaving the dodge in charge.
    state.subtitlePin = place && SUB_PLACES.indexOf(place) >= 0 ? place : null;
    el.innerHTML = text;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'anim-cli-subFade ' + Math.max(1, ms || SUBTITLE_HOLD_MS) + 'ms ease forwards';
    // A fresh cue is placed clear of this step's target and the cursor from the start (the entry
    // fade hides the positioning), rather than appearing over the button and jumping away.
    reflowSubtitle(true);
  }
  function hideSubtitle() {
    state.subtitlePin = null;
    if (state.subtitleEl) { state.subtitleEl.style.animation = 'none'; state.subtitleEl.style.opacity = '0'; }
  }

  // --- runStep: one step, from cursor travel to interaction --------------------------
  var NOT_STARTED = 'runtime not started on this document (the page navigated before this step; the driver must re-boot it)';

  function runStep(step, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      onReady(function () {
        // Under a driver, a document that was never booted/started is a navigation the driver has not
        // seen yet: refuse instead of silently booting with default options and a clock at 0
        // (which is how a step could report actualMs = 0 without an error).
        if (window.__ANIM_DRIVEN && (!state.booted || state.t0 == null)) { reject(new Error(NOT_STARTED)); return; }
        if (!state.booted) boot({});
        try { runStepReady(step, o, resolve, reject); } catch (e) { reject(e); }
      });
    });
  }

  function runStepReady(step, o, resolve, reject) {
    // A new step may move content (scroll, animate, camera, a click that swaps screens): the
    // framed-content obstacle boxes from the previous epoch are stale from here on.
    state.framingEpoch++;
    var action = ALIASES[step.action] || step.action;
    var instant = !!o.instant;
    var leadMs = instant ? 0 : (typeof o.leadMs === 'number' ? Math.max(0, o.leadMs) : DEFAULT_LEAD_MS);
    var el = null;
    if (typeof step.target === 'string' && step.target.trim()) {
      el = step.target === 'body' ? document.body : document.querySelector(step.target);
      if (!el && TARGET_REQUIRED[action]) {
        reject(new Error('target not found: ' + step.target));
        return;
      }
    } else if (TARGET_REQUIRED[action]) {
      reject(new Error('action "' + action + '" requires a target'));
      return;
    }

    var hasPoint = !!(el && CURSOR_ACTIONS[action]);
    // A target hidden inside a scrolled/overflow container (e.g. the caret span at the end of a
    // long editor) is scrolled into view first, like a real user's caret would be.
    if (hasPoint && isClipped(el)) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // A 0x0 target (an empty span/caret) cannot carry a spotlight: use the nearest sized ancestor.
    var spotEl = hasPoint ? anchorOf(el) : el;
    if (hasPoint) state.lastSpot = { target: step.target, el: spotEl };
    function measurePoint() {
      var rect = el.getBoundingClientRect();
      var tx = rect.left + rect.width / 2;
      var ty = rect.top + rect.height / 2;
      if (spotEl !== el) {
        // Keep the cursor on the caret position when it lies inside the anchor, else centre it.
        var a = spotEl.getBoundingClientRect();
        if (tx < a.left || tx > a.right || ty < a.top || ty > a.bottom) { tx = a.left + a.width / 2; ty = a.top + a.height / 2; }
      }
      if (step.xOffset) tx += parseFloat(step.xOffset);
      if (step.yOffset) ty += parseFloat(step.yOffset);
      return { x: tx, y: ty };
    }
    var point = hasPoint ? measurePoint() : null;

    var travelMs = Math.max(0, leadMs - PRESS_MS);
    var pressMs = Math.min(PRESS_MS, leadMs);

    if (point) moveCursor(point.x, point.y, travelMs);

    // Registered so stop() -- and therefore restart() -- cancels them. Unregistered, a step
    // abandoned mid-travel (a tour seek, a replay) still fires its arrival and its interaction
    // against the restored page: the ring re-opens on a detached node and parks in the corner,
    // and el.click() lands on a document that never asked for it. play() calls stop() before it
    // schedules anything, so registering costs the clock-driven path nothing.
    setAnimTimeout(function () {
      if (hasPoint) {
        // Re-measure at arrival: a camera move or a layout-expanding click during the
        // travel would leave the cursor, ripple and highlight on stale coordinates.
        var fresh = measurePoint();
        if (fresh.x !== point.x || fresh.y !== point.y) { point = fresh; placeCursor(point.x, point.y); }
        setCursorAnchor(el, spotEl, point);
        // Opting a step out means no spotlight is visible for it: without the release, the previous
        // step's ring simply stays put and frames the wrong element for the whole step.
        if (step.spotlight === false) releaseHighlight();
        else highlight(spotEl);
        pressCursor(point.x, point.y, pressMs);
      }
      setAnimTimeout(function () {
        if (o.holdBeforeAct) {
          // Two-phase step: report the arrival (cursor pressed, spotlight on, nothing clicked yet) and
          // wait for act(token). Guides capture navigating clicks here, before the page goes away.
          var holdToken = state.nextToken++;
          state.holds[holdToken] = function (res, rej) { if (point) releaseCursor(point.x, point.y); interact(res, rej); };
          resolve({ phase: 'arrival', token: holdToken, index: step.index, id: step.id, action: action, target: step.target,
            scheduledMs: timeMsOf(step), actualMs: NaN, rect: spotRectOf(spotEl), targetRect: spotEl !== el ? rectOf(el) : undefined, point: point });
          return;
        }
        if (point) releaseCursor(point.x, point.y);
        interact(resolve, reject);
      }, pressMs);
    }, travelMs);

    function interact(resolve, reject) {
      var actualMs = now();
      var token = state.nextToken++;
      var result = {
        index: step.index,
        id: step.id,
        action: action,
        target: step.target,
        scheduledMs: timeMsOf(step),
        actualMs: actualMs,
        rect: spotRectOf(spotEl),      // what the spotlight/callout framed (clamped to what is visible)
        targetRect: spotEl !== el ? rectOf(el) : undefined,
        point: point,
        token: token
      };
      if (step.subtitle) showSubtitle(step.subtitle, step.subtitleMs, step.subtitlePlace);
      var done = Promise.resolve();
      try {
        switch (action) {
          case 'click':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            if (point && step.ripple !== false) ripple(point.x, point.y);
            el.focus();
            // el.click() (not el.onclick()) so checkbox toggling, addEventListener
            // listeners, and default actions all fire like a real user click.
            el.click();
            focusStyle(el);
            break;
          case 'focus':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            el.focus();
            focusStyle(el);
            break;
          case 'type':
            if (state.opts.resetFocusStyles) resetFocusStyles();
            el.focus();
            focusStyle(el);
            if (o.driverTypes && isKeyboardTypable(el)) {
              // A Node driver is attached and the target really takes keyboard input: the driver types
              // through the real keyboard (page.keyboard.type), so the app's own keydown/input handlers
              // and any framework value tracker see genuine events. The page only clears the field,
              // keeps the spotlight tracking the text (typingProgress) and completes when the driver
              // says so, answering with what the field ended up holding.
              setTyped(el, '');
              result.typing = 'driver';
              done = new Promise(function (res) {
                state.driverTyping[token] = { resolve: res, el: el, spotEl: spotEl };
              });
            } else {
              done = typeInto(el, step.value, step.cps, instant, function () {
                // A 0x0 caret span gains a line box once text lands; keep it in view and track the spotlight.
                if (isClipped(el)) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                positionHighlight(spotEl);
              });
            }
            break;
          case 'hover':
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseenter'));
            break;
          case 'highlight':
          case 'wait':
          case 'press':    // the Node driver calls page.keyboard.press(value) when runStep resolves; no-op in the page
          case 'navigate': // not implemented until `record` (Phase 4): validation warns, no-op in the page
            break;
          case 'camera':
            done = camera(step, instant);
            break;
          case 'scroll':
            done = scrollTo(el, instant);
            break;
          case 'animate':
            done = animateStep(step, instant);
            break;
          case 'fadeIn':
            done = fadeIn(el, instant, stepDurationMs(step));
            break;
          case 'transitionScreen':
            done = transitionScreen(el, instant, stepDurationMs(step));
            break;
          default:
            throw new Error('unknown action: ' + action);
        }
      } catch (e) {
        dispatch('anim:step', result);
        reject(e);
        return;
      }
      dispatch('anim:step', result);
      // Resolve at the interaction; completion (typing/camera/fade finished) is tracked
      // separately and awaited with whenDone(token) / whenIdle().
      var completion = done.then(function () {
        delete state.completions[token];
        return now();
      }, function (e) {
        delete state.completions[token];
        throw e;
      });
      completion.catch(function () {});
      state.completions[token] = completion;
      resolve(result);
    }
  }

  /** Driver-side typing (runStep returned typing: 'driver'): re-track the spotlight as the text grows. */
  function typingProgress(token) {
    var t = state.driverTyping[token];
    if (!t) return false;
    if (isClipped(t.el)) t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    positionHighlight(t.spotEl);
    return true;
  }
  /**
   * Driver-side typing finished: the step completes now (whenDone(token) resolves with this moment).
   * Returns the text the field ended up holding, so the driver can tell "typed" from "went nowhere".
   */
  function typingDone(token) {
    var t = state.driverTyping[token];
    if (!t) return null;
    typingProgress(token); // one last reposition, while the entry still exists
    delete state.driverTyping[token];
    t.resolve();
    return typedTextOf(t.el);
  }

  /** Second phase of a runStep(step, {holdBeforeAct: true}): perform the interaction now. */
  function act(token) {
    var fn = state.holds[token];
    delete state.holds[token];
    if (!fn) return Promise.reject(new Error('no held step for token ' + token));
    return new Promise(function (res, rej) { try { fn(res, rej); } catch (e) { rej(e); } });
  }
  /** Resolves with the completion time (ms) of the step that returned `token`. */
  function whenDone(token) {
    var c = state.completions[token];
    return c ? c : Promise.resolve(now());
  }
  /** Resolves once every in-flight step has completed. */
  function whenIdle() {
    var all = Object.keys(state.completions).map(function (k) { return state.completions[k].catch(function () {}); });
    return Promise.all(all).then(function () { return now(); });
  }

  /**
   * Resolve once every CSS animation/transition running anywhere in the document (page content,
   * the camera transform on the stage, and the runtime's own overlays: spotlight, badge, ripple)
   * has finished, except the cursor (idle at a capture) and the subtitle layer (hidden at a
   * capture), and except animations that never end (spinners). Guide frames are taken after this so
   * a frame never lands mid-transition (a 1-2% pixel diff between identical runs otherwise).
   * opts.timeoutMs (default 10000) is only a hang guard. Returns { waited, animations, timedOut }.
   */
  function whenSettled(opts) {
    opts = opts || {};
    var started = now();
    var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10000;
    var skipRoots = [state.cursor, state.subtitleLayer].filter(Boolean);
    function skipped(a) {
      var t = a.effect && a.effect.target;
      if (!t) return false;
      for (var i = 0; i < skipRoots.length; i++) if (skipRoots[i] === t || skipRoots[i].contains(t)) return true;
      try { var timing = a.effect.getComputedTiming(); if (timing.iterations === Infinity || timing.endTime === Infinity) return true; } catch (e) { /* ignore */ }
      return false;
    }
    var list = [];
    var anims = [];
    try { anims = document.getAnimations(); } catch (e) { anims = []; }
    anims.forEach(function (a) {
      if (a.playState === 'finished' || a.playState === 'idle' || skipped(a)) return;
      list.push(a.finished.catch(function () {}));
    });
    if (!list.length) return Promise.resolve({ waited: 0, animations: 0, timedOut: false });
    var timedOut = false;
    var timer = new Promise(function (resolve) { setTimeout(function () { timedOut = true; resolve(); }, timeoutMs); });
    return Promise.race([Promise.all(list), timer]).then(function () {
      return { waited: Math.round(now() - started), animations: list.length, timedOut: timedOut };
    });
  }

  // --- optional in-page scheduler (only when animated.html is opened directly) ---------
  function leadFor(step, prev) {
    var t = timeMsOf(step);
    var lead = DEFAULT_LEAD_MS;
    if (isFinite(t)) lead = Math.min(lead, Math.max(0, t));
    if (prev && isFinite(timeMsOf(prev)) && isFinite(t)) lead = Math.min(lead, Math.max(0, t - timeMsOf(prev)));
    return lead;
  }
  /** Start (or, after a navigation, continue) the timeline clock: now() == elapsedMs right after this call. */
  function start(elapsedMs) { state.t0 = performance.now() - (elapsedMs || 0); return elapsedMs || 0; }
  function play(timeline, o) {
    o = o || {};
    var steps = Array.isArray(timeline) ? timeline : (timeline && timeline.steps) || [];
    stop();
    start();
    if (!steps.length) {
      dispatch('anim:play', { steps: 0, durationMs: 0, loop: false });
      return;
    }
    var prev = null, maxMs = 0;
    steps.forEach(function (step, i) {
      if (step.index == null) step.index = i + 1;
      var t = timeMsOf(step);
      if (!isFinite(t)) return;
      var lead = leadFor(step, prev);
      maxMs = Math.max(maxMs, t);
      state.timers.push(setTimeout(function () {
        runStep(step, { leadMs: lead }).catch(function (e) { console.warn('[anim-cli] step ' + step.index + ': ' + e.message); });
      }, Math.max(0, t - lead)));
      prev = step;
    });
    var durationMs = o.durationMs || (maxMs + DEFAULT_TAIL_MS);
    if (o.loop) {
      state.timers.push(setTimeout(function () {
        // A cloned snapshot restores a static mockup exactly; a live app's handlers and state cannot
        // be rebuilt from markup, so those keep the reload path.
        if (state.snapshot) { restart(); play(timeline, o); }
        else location.reload();
      }, durationMs));
    }
    dispatch('anim:play', { steps: steps.length, durationMs: durationMs, loop: !!o.loop });
  }
  /**
   * Clone <body>'s children while the page is still in its authored state. The overlays live under
   * <html> (see overlayRoot), so a body snapshot never captures the cursor, spotlight or badge.
   * Scripts are remembered separately: cloneNode keeps attributes but not addEventListener wiring,
   * and a re-appended script element never re-executes, so restart() re-runs them (see rerunScripts).
   */
  function snapshot() {
    var kids = [];
    var scripts = [];
    for (var i = 0; i < document.body.children.length; i++) {
      var node = document.body.children[i];
      kids.push(node.cloneNode(true));
      // Scripts at ANY depth: a mockup that keeps its wiring inside a screen section (AGENTS.md
      // blesses several screens as sections in one file) loses those listeners on restart just as
      // surely as a top-level one. Collected depth-first per child, i.e. in authored order.
      if (node.tagName === 'SCRIPT') scripts.push(node);
      else if (node.querySelectorAll) {
        var nested = node.querySelectorAll('script');
        for (var j = 0; j < nested.length; j++) scripts.push(nested[j]);
      }
    }
    state.snapshot = kids;
    state.snapshotScripts = scripts;
    state.snapshotStyle = document.body.getAttribute('style') || '';
  }

  /** Cancel every running animation, so a fill:'both' handle cannot outlive the node it holds. */
  function cancelAnimations() {
    if (typeof document.getAnimations !== 'function') return;
    var list = document.getAnimations();
    for (var i = 0; i < list.length; i++) { try { list[i].cancel(); } catch (e) { /* already gone */ } }
  }

  /**
   * Re-execute the snapshot's classic <body> scripts after a restart. Without this, a mockup whose
   * steps rely on page-side handlers (addEventListener) silently stopped working after the first
   * seek or loop: the cloned DOM keeps the markup and loses the wiring. Each script runs in a
   * FRESH node (a re-appended clone never executes); inline sources are wrapped in try/catch so one
   * failing script cannot kill the restore; module/importmap/JSON scripts cannot be re-run and are
   * skipped; data-anim-rerun="false" opts a script out. A script that appended DOM at load will
   * append it again (the snapshot already contains its first output): guard it or opt it out.
   */
  function rerunScripts() {
    var scripts = state.snapshotScripts || [];
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i];
      if (s.getAttribute && s.getAttribute('data-anim-rerun') === 'false') continue;
      // Belt for pages built before the marker existed: the injected runtime block re-running
      // would re-create the scheduler and re-snapshot played state.
      if (!s.src && s.textContent && s.textContent.indexOf('window.__anim.boot(') >= 0) continue;
      var type = (s.getAttribute('type') || '').toLowerCase();
      if (type && type !== 'text/javascript' && type !== 'application/javascript') continue;
      var fresh = document.createElement('script');
      for (var a = 0; a < s.attributes.length; a++) fresh.setAttribute(s.attributes[a].name, s.attributes[a].value);
      fresh.async = false; // keep re-execution in authored order (matters for external scripts)
      if (!s.src) {
        fresh.textContent = 'try {\n' + s.textContent + '\n} catch (e) { try { console.warn("[anim-cli] re-running an inline script failed:", e); } catch (_) {} }';
      }
      document.body.appendChild(fresh);
    }
  }

  /**
   * Put the page back to its authored state so the timeline can run again. Replaying is not enough:
   * typing writes into fields, fadeIn sets inline opacity, transitionScreen hides siblings, camera
   * leaves a transform on <body>, an `animate` step leaves its WAAPI end state behind, and classic
   * scripts' event listeners do not survive cloneNode -- rerunScripts() re-establishes the wiring.
   */
  function restart() {
    if (!state.snapshot) return false;
    stop();
    cancelAnimations();
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    for (var i = 0; i < state.snapshot.length; i++) document.body.appendChild(state.snapshot[i].cloneNode(true));
    if (state.snapshotStyle) document.body.setAttribute('style', state.snapshotStyle);
    else document.body.removeAttribute('style');
    document.body.style.transformOrigin = 'center center';
    applyDrift();
    rerunScripts();
    state.currentScreen = null;
    state.lastSpot = null;
    state.spotAnchor = null;
    state.cameraOn = false;
    state.cameraWindow = null;
    state.framingEpoch++;
    state.cursorAnchor = null;
    state.completions = {};
    state.holds = {};
    state.driverTyping = {};
    hideSubtitle();
    releaseHighlight();
    hideCallout();
    if (state.opts.cursorPoint && state.cursor) placeCursor(state.opts.cursorPoint.x, state.opts.cursorPoint.y);
    start();
    return true;
  }

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  /**
   * Decide when playback starts, per the `autoplay` boot option:
   *   immediate - as soon as the page is ready (the historical behaviour).
   *   inview    - when an IntersectionObserver first sees the clip, pausing when it scrolls away so
   *               several clips on one page do not all burn CPU.
   *   message   - only when the embedding page posts {source:'anim-cli', type:'play'}.
   * postMessage is honoured in every mode: inside an iframe the observer measures against the
   * iframe's own viewport and would report itself visible while off-screen, so the parent has the
   * only trustworthy view and must be able to override.
   * A reduced-motion visitor gets the mockup in its authored state and no playback at all.
   */
  function startPlayback(tl) {
    if (prefersReducedMotion()) {
      dispatch('anim:skipped', { reason: 'prefers-reduced-motion' });
      return;
    }
    var playing = false;
    var started = false;
    function begin() {
      if (playing) return;
      if (started) restart();
      playing = true;
      started = true;
      play(tl, { loop: !!state.opts.loop, durationMs: state.opts.durationMs });
    }
    function halt() {
      if (!playing) return;
      playing = false;
      stop();
    }
    state.playback = { begin: begin, halt: halt, isPlaying: function () { return playing; } };
    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || d.source !== 'anim-cli') return;
      if (d.type === 'play') begin();
      else if (d.type === 'pause') halt();
    });
    if (state.opts.autoplay === 'message') return;
    if (state.opts.autoplay === 'inview' && typeof IntersectionObserver === 'function') {
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) begin();
          else halt();
        }
      }, { threshold: 0.2 });
      io.observe(document.body);
      return;
    }
    begin();
  }

  function stop() {
    state.timers.forEach(clearTimeout);
    state.timers = [];
    state.intervals.forEach(clearInterval);
    state.intervals = [];
  }

  var api = {
    version: 1,
    boot: boot,
    start: start,
    play: play,
    stop: stop,
    runStep: runStep,
    act: act,
    whenDone: whenDone,
    typingProgress: typingProgress,
    typingDone: typingDone,
    whenIdle: whenIdle,
    whenSettled: whenSettled,
    snapshot: snapshot,
    restart: restart,
    playback: function () { return state.playback; },
    now: now,
    isReady: function () { return state.ready; },
    getState: function () {
      return { ready: state.ready, point: state.point, opts: state.opts, cursor: !!state.cursor,
        t0: state.t0, timeOrigin: performance.timeOrigin, inFlight: Object.keys(state.completions).length };
    },
    /** Debug/test only: pending runtime handles. Not a public API; exists so a test can assert
     *  self-removal keeps the arrays from growing across a long driven run. */
    pendingHandles: function () { return { timers: state.timers.length, intervals: state.intervals.length }; },
    moveCursor: moveCursor,
    highlightBox: function () { var h = document.getElementById('anim-cli-highlight'); return h ? rectOf(h) : null; },
    cursorAnchor: function () { var a = state.cursorAnchor; return a && a.el && a.el.isConnected ? { fx: a.fx, fy: a.fy, rect: rectOf(a.el) } : null; },
    placeCursor: placeCursor,
    anchorOf: anchorOf,
    isClipped: isClipped,
    /** Whether a `camera` step has reframed the page: under one, "outside the viewport" is by design. */
    cameraActive: function () { return !!state.cameraOn; },
    /** Framing facts for the active camera (see framingReport); null when no camera is active. */
    framingReport: framingReport,
    /** Whether the placed subtitle chip covers an obstacle anyway (target, cursor, framed content; see subtitleCollisions). */
    subtitleCollisions: subtitleCollisions,
    /** Whether el or an ancestor is scaled to nothing (a CSS scale(0) pre-hide). */
    transformHidden: transformHidden,
    /** Where the cursor/spotlight/subtitle/camera sit right now, in authored px (check --trace). */
    overlayState: overlayState,
    describeEl: describeEl,
    selectorOf: selectorOf,
    highlight: highlight,
    holdHighlight: holdHighlight,
    releaseHighlight: releaseHighlight,
    showCallout: showCallout,
    hideCallout: hideCallout,
    beginCapture: beginCapture,
    markStep: markStep,
    endCapture: endCapture,
    unmark: endCapture,
    nextFrames: nextFrames,
    ripple: ripple,
    typeInto: typeInto,
    camera: camera,
    scroll: scrollTo,
    fadeIn: fadeIn,
    transitionScreen: transitionScreen,
    showSubtitle: showSubtitle,
    hideSubtitle: hideSubtitle
  };
  window.__anim = api;
})();
