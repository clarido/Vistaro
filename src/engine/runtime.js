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
  var SUBTITLE_CSS = `#anim-cli-subtitle-layer { position: fixed; bottom: 40px; left: 0; right: 0; display: flex; justify-content: center; z-index: 99998; pointer-events: none; padding: 0 40px; }
.anim-cli-sub-item { position: absolute; bottom: 0; background: rgba(20,20,20,0.75); color: white; padding: 16px 32px; border-radius: 12px; font-family: -apple-system, sans-serif; font-size: 20px; line-height: 1.4; text-align: center; max-width: 800px; box-shadow: 0 20px 40px -8px rgba(0,0,0,0.5); opacity: 0; font-weight: 500; letter-spacing: 0.3px; backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.15); }
@keyframes anim-cli-subFade { 0% { opacity: 0; transform: translateY(15px) scale(0.95); animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); } 10%, 90% { opacity: 1; transform: translateY(0) scale(1); animation-timing-function: cubic-bezier(0.7, 0, 0.84, 0); } 100% { opacity: 0; transform: translateY(-10px) scale(0.95); } }`;
  var EFFECTS_CSS = `#anim-cli-highlight { position: fixed; border-radius: 10px; border: 2px solid #3B82F6; box-shadow: 0 0 0 4px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.35); pointer-events: none; z-index: 99996; opacity: 0; transition: left 0.5s cubic-bezier(0.16,1,0.3,1), top 0.5s cubic-bezier(0.16,1,0.3,1), width 0.5s cubic-bezier(0.16,1,0.3,1), height 0.5s cubic-bezier(0.16,1,0.3,1); }
#anim-cli-highlight.anim-cli-pulse { animation: anim-cli-highlightPulse 1.3s cubic-bezier(0.16,1,0.3,1) forwards; }
#anim-cli-highlight.anim-cli-hold { opacity: 1; animation: none; }
@keyframes anim-cli-highlightPulse { 0% { opacity: 0; } 15% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
.anim-cli-ripple { position: fixed; width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; border-radius: 50%; background: rgba(59,130,246,0.35); border: 2px solid rgba(59,130,246,0.65); pointer-events: none; z-index: 99997; animation: anim-cli-rippleAnim 0.6s cubic-bezier(0.16,1,0.3,1) forwards; }
@keyframes anim-cli-rippleAnim { 0% { width: 14px; height: 14px; margin-left: -7px; margin-top: -7px; opacity: 0.9; } 100% { width: 80px; height: 80px; margin-left: -40px; margin-top: -40px; opacity: 0; } }`;
  // The numbered badge is guide-capture furniture, not chrome the viewer sees during playback, so it
  // is installed even when the spotlight and ripple are off.
  var CALLOUT_CSS = `#anim-cli-callout { position: fixed; width: 32px; height: 32px; border-radius: 50%; background: #3B82F6; color: #fff; font: 600 15px/32px -apple-system, sans-serif; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); pointer-events: none; z-index: 99998; display: none; }`;

  // --- state ----------------------------------------------------------------------
  var state = {
    booted: false,
    ready: false,
    opts: { cursor: 'mac', resetFocusStyles: false, drift: true, loop: false, spotlight: true, ripple: true, subtitles: true, autoplay: 'immediate', zoom: 1, timeline: null, durationMs: null, cursorPoint: null },
    cursor: null,
    subtitleLayer: null,
    subtitleEl: null,
    point: null,
    t0: null,
    currentScreen: null,
    lastSpot: null,
    snapshot: null,
    snapshotStyle: '',
    cameraOn: false,
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
    state.subtitleLayer = layer;
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
  }
  function moveCursor(x, y, ms, easing) {
    if (!state.cursor) return;
    if (!ms || ms <= 0) { placeCursor(x, y); return; }
    var p = toOverlayPoint(x, y);
    state.cursor.style.transition = 'transform ' + ms + 'ms ' + (easing || 'cubic-bezier(0.16, 1, 0.3, 1)');
    state.cursor.style.transform = 'translate(' + p.x + 'px, ' + p.y + 'px)';
    state.point = { x: x, y: y };
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
  }
  /** Keep the spotlight on `el` until releaseHighlight() (used for guide screenshots). */
  function holdHighlight(el) {
    if (!el) return;
    // A held mark is a static frame element: it snaps into place, no transition to be caught mid-flight.
    var h = positionHighlight(el, true);
    h.classList.remove('anim-cli-pulse');
    h.classList.add('anim-cli-hold');
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
      state.timers.push(setTimeout(function () {
        h.style.transition = '';
        if (c) c.style.transition = '';
      }, ms + 50));
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
          clearInterval(intId);
          resolve();
        }
      }
      tick(); // first character lands exactly at the interaction moment
      var intId = setInterval(tick, interval);
      state.intervals.push(intId);
      if (value.length <= 1) { clearInterval(intId); resolve(); }
    });
  }

  function camera(step, instant) {
    var stage = document.body;
    var x = step.x != null ? step.x : '0px';
    var y = step.y != null ? step.y : '0px';
    // A bare number here would produce an invalid unitless translate() and drop the whole transform.
    if (typeof x === 'number') x = x + 'px';
    if (typeof y === 'number') y = y + 'px';
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
        var cx = (r.left + r.width / 2 - window.innerWidth / 2) / z;
        var cy = (r.top + r.height / 2 - window.innerHeight / 2) / z;
        x = (-cx) + 'px';
        y = (-cy) + 'px';
      }
    }
    var dur = instant ? 0 : (step.duration != null ? step.duration : DEFAULT_CAMERA_S);
    var finalTransform = 'scale(' + scale + ') translate(' + x + ', ' + y + ')';
    stage.style.transformOrigin = 'center center';

    // Where the overlays' anchor elements end up under the final transform: measured by applying it
    // with transitions off, not computed, so transform-origin, a body box that is not the viewport
    // and compounding camera moves are all handled by the browser. Cursor, spotlight and badge are
    // all fixed-position overlays outside the transformed stage, so all three have to be carried.
    var cursorTo = null;
    var spotTo = null;
    var anchor = state.cursorAnchor;
    var spot = state.spotAnchor;
    var moveCursorToo = !!(state.cursor && anchor && anchor.el && anchor.el.isConnected);
    var moveSpotToo = !!(spot && spot.isConnected && document.getElementById('anim-cli-highlight'));
    if (moveCursorToo || moveSpotToo) {
      var beforeTransform = stage.style.transform;
      var beforeTransition = stage.style.transition;
      stage.style.transition = 'none';
      stage.style.transform = finalTransform;
      if (moveCursorToo) {
        var ar = anchor.el.getBoundingClientRect();
        cursorTo = { x: ar.left + anchor.fx * ar.width, y: ar.top + anchor.fy * ar.height };
      }
      if (moveSpotToo) spotTo = visibleRect(spot);
      stage.style.transform = beforeTransform;
      void stage.offsetWidth;
      stage.style.transition = beforeTransition;
    }

    var cameraEase = easingOf(step, CAMERA_EASING);
    state.cameraOn = true;
    stage.style.transition = dur > 0 ? 'transform ' + dur + 's ' + cameraEase : 'none';
    stage.style.transform = finalTransform;
    if (dur === 0) void stage.offsetWidth;
    // Cursor and spotlight ride the same curve for the same time, so both stay on their element
    // throughout the move instead of being left behind over empty background.
    if (cursorTo) moveCursor(cursorTo.x, cursorTo.y, dur * 1000, cameraEase);
    if (spotTo) glideHighlight(spotTo, dur * 1000, cameraEase);
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

  function showSubtitle(text, ms) {
    if (!state.opts.subtitles) return;
    if (!state.subtitleLayer) return;
    var el = state.subtitleEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'anim-cli-sub-item';
      state.subtitleLayer.appendChild(el);
      state.subtitleEl = el;
    }
    el.innerHTML = text;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = 'anim-cli-subFade ' + Math.max(1, ms || SUBTITLE_HOLD_MS) + 'ms ease forwards';
  }
  function hideSubtitle() {
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
    state.timers.push(setTimeout(function () {
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
      state.timers.push(setTimeout(function () {
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
      }, pressMs));
    }, travelMs));

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
      if (step.subtitle) showSubtitle(step.subtitle, step.subtitleMs);
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
   */
  function snapshot() {
    var kids = [];
    for (var i = 0; i < document.body.children.length; i++) kids.push(document.body.children[i].cloneNode(true));
    state.snapshot = kids;
    state.snapshotStyle = document.body.getAttribute('style') || '';
  }

  /** Cancel every running animation, so a fill:'both' handle cannot outlive the node it holds. */
  function cancelAnimations() {
    if (typeof document.getAnimations !== 'function') return;
    var list = document.getAnimations();
    for (var i = 0; i < list.length; i++) { try { list[i].cancel(); } catch (e) { /* already gone */ } }
  }

  /**
   * Put the page back to its authored state so the timeline can run again. Replaying is not enough:
   * typing writes into fields, fadeIn sets inline opacity, transitionScreen hides siblings, camera
   * leaves a transform on <body>, and an `animate` step leaves its WAAPI end state behind.
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
    state.currentScreen = null;
    state.lastSpot = null;
    state.spotAnchor = null;
    state.cameraOn = false;
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
    moveCursor: moveCursor,
    highlightBox: function () { var h = document.getElementById('anim-cli-highlight'); return h ? rectOf(h) : null; },
    cursorAnchor: function () { var a = state.cursorAnchor; return a && a.el && a.el.isConnected ? { fx: a.fx, fy: a.fy, rect: rectOf(a.el) } : null; },
    placeCursor: placeCursor,
    anchorOf: anchorOf,
    isClipped: isClipped,
    /** Whether a `camera` step has reframed the page: under one, "outside the viewport" is by design. */
    cameraActive: function () { return !!state.cameraOn; },
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
